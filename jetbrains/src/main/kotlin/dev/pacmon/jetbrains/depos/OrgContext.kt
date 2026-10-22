package dev.pacmon.jetbrains.depos

import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationActivationListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ModuleRootEvent
import com.intellij.openapi.roots.ModuleRootListener
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.IdeFrame
import com.intellij.util.concurrency.AppExecutorUtil
import dev.pacmon.jetbrains.core.ManifestKind
import dev.pacmon.jetbrains.core.ManifestRegistry
import dev.pacmon.jetbrains.core.NotesCore
import dev.pacmon.jetbrains.core.NotesFileModel
import dev.pacmon.jetbrains.depos.DeposJson.number
import dev.pacmon.jetbrains.depos.DeposJson.str
import dev.pacmon.jetbrains.service.PacmonProjectService
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Org mode of each project root (docs/format.md, "The organization layer"). A port
 * of `src/ext/web/orgContext.ts`, with the project's roots — its base directory and
 * its content roots — in place of VS Code's workspace folders.
 *
 * - The root's organization: Depos matches the repository of its GitHub remote.
 * - The allowlist layer, per repository: one request with an ETag, so an unchanged
 *   layer costs a 304. Its results are looked up here, at the manifest line.
 * - The org notes, per organization: a local copy outside the project, kept current
 *   by a delta sync. A root whose copy is loaded is in org mode: its notes come from
 *   the copy, through a read-only notes text per ecosystem.
 *
 * Fetched while signed in to Depos: at start, after sign-in, when the IDE gets
 * focus, every 5 minutes, and on the refresh action. Signing out, or a repository
 * that is no longer in an organization of the user, removes every copy.
 */
@Service(Service.Level.PROJECT)
class OrgContext(private val project: Project) : Disposable {
    data class FolderOrg(
        val origin: String,
        val repoUlid: String,
        val orgUlid: String,
        val repoFullName: String?,
        /** The allowlist layer; null until Depos has answered once. */
        val layer: OrgLayer?,
        /** When Depos last confirmed the allowlist layer (ms since epoch). */
        var receivedAt: Long,
        val etag: String?,
    )

    /** A root in org mode, with what its org notes say about the user. */
    data class OrgNotesState(val folder: FolderOrg, val orgName: String, val canEdit: Boolean)

    /** A root in org mode, for the MCP setup of its repository. */
    data class OrgFolder(val name: String, val origin: String, val repoUlid: String, val orgUlid: String, val repoFullName: String?)

    /** What Depos answered for a root's repository, kept for a start while offline. */
    private data class Cached(
        val repoUlid: String,
        val orgUlid: String,
        val repoFullName: String?,
        val allowlist: CachedAllowlist? = null,
    )

    private data class CachedAllowlist(val raw: JsonElement, val data: OrgContextData, val etag: String?, val receivedAt: Long)

    private val log = logger<OrgContext>()
    private val connection get() = DeposConnection.getInstance()
    private val lock = Any()
    private val folders = HashMap<String, FolderOrg>()
    private val copies = HashMap<String, OrgNotesCopy>()
    private val models = HashMap<String, Pair<String, NotesFileModel>>()
    private var cache: MutableMap<String, Cached>? = null
    private val running = AtomicBoolean(false)
    @Volatile private var again = false
    @Volatile private var lastRun = 0L
    @Volatile private var disposed = false
    private var timer: ScheduledFuture<*>? = null
    private var started = false

    /** From the startup activity: listeners, the timer, and the first fetch. */
    fun start() {
        if (started || ApplicationManager.getApplication().isUnitTestMode) return
        started = true
        val app = ApplicationManager.getApplication()
        app.messageBus.connect(this).apply {
            subscribe(DeposConnectionListener.TOPIC, object : DeposConnectionListener {
                override fun connectionChanged() = refresh()
            })
            subscribe(ApplicationActivationListener.TOPIC, object : ApplicationActivationListener {
                override fun applicationActivated(ideFrame: IdeFrame) {
                    if (System.currentTimeMillis() - lastRun > FOCUS_MIN_GAP_MS) refresh()
                }
            })
        }
        project.messageBus.connect(this).subscribe(ModuleRootListener.TOPIC, object : ModuleRootListener {
            override fun rootsChanged(event: ModuleRootEvent) = refresh()
        })
        timer = AppExecutorUtil.getAppScheduledExecutorService()
            .scheduleWithFixedDelay(::refresh, REFRESH_INTERVAL_MIN, REFRESH_INTERVAL_MIN, TimeUnit.MINUTES)
        refresh()
    }

    override fun dispose() {
        disposed = true
        timer?.cancel(false)
    }

    // ── Roots ────────────────────────────────────────────────────────────────

    /** The project's base directory and its content roots, by name: VS Code's workspace folders. */
    fun roots(): List<Pair<String, Path>> = ReadAction.compute<List<Pair<String, Path>>, RuntimeException> {
        if (project.isDisposed) return@compute emptyList()
        val paths = buildList {
            project.basePath?.let { add(it.replace('\\', '/').trimEnd('/')) }
            ProjectRootManager.getInstance(project).contentRoots.forEach { add(it.path.trimEnd('/')) }
        }.distinct()
        paths.map { path -> (path.substringAfterLast('/').ifEmpty { path }) to Path.of(path) }
    }

    private fun keyOf(path: Path): String = path.toString().replace('\\', '/').trimEnd('/')

    /** The root of [filePath] among the roots in org mode: the deepest that holds it. Under [lock]. */
    private fun folderKeyFor(filePath: String): String? {
        val path = filePath.replace('\\', '/')
        return folders.keys.filter { path == it || path.startsWith("$it/") }.maxByOrNull { it.length }
    }

    // ── Reads, from any thread ───────────────────────────────────────────────

    /** The org notes state of the root that holds [file], when that root is in org mode. */
    fun notesFor(file: VirtualFile): OrgNotesState? = synchronized(lock) {
        val folder = folderKeyFor(file.path)?.let(folders::get) ?: return null
        val copy = copies[folder.orgUlid]?.takeIf { it.loaded } ?: return null
        OrgNotesState(folder, copy.orgName, copy.canEdit)
    }

    /** The org notes of [manifest]'s ecosystem as a parsed notes file, when its root is in org mode. */
    fun notesModel(manifest: VirtualFile): NotesFileModel? {
        val kind = ManifestRegistry.forPath(manifest.path)?.kind ?: return null
        return synchronized(lock) {
            val key = folderKeyFor(manifest.path) ?: return null
            val folder = folders[key] ?: return null
            val copy = copies[folder.orgUlid]?.takeIf { it.loaded } ?: return null
            val cacheKey = "$key|${kind.id}"
            val version = "${folder.orgUlid}:${copy.version}:${folder.repoUlid}"
            models[cacheKey]?.takeIf { it.first == version }?.second
                ?: NotesCore.parse(copy.notesText(kind, folder.repoUlid)).also { models[cacheKey] = version to it }
        }
    }

    /** The org notes of [manifest]'s ecosystem as text, for a read-only editor tab. */
    fun notesText(manifest: VirtualFile): String? {
        val kind = ManifestRegistry.forPath(manifest.path)?.kind ?: return null
        return synchronized(lock) {
            val folder = folderKeyFor(manifest.path)?.let(folders::get) ?: return null
            val copy = copies[folder.orgUlid]?.takeIf { it.loaded } ?: return null
            copy.notesText(kind, folder.repoUlid)
        }
    }

    /** The allowlist result of a package of [manifest], with the organization's name; null when not audited. */
    fun allowlist(manifest: VirtualFile, name: String): Pair<OrgResult, String>? {
        val kind = ManifestRegistry.forPath(manifest.path)?.kind ?: return null
        val layer = synchronized(lock) { folderKeyFor(manifest.path)?.let(folders::get)?.layer } ?: return null
        val result = layer.result(kind, name) ?: return null
        return result to layer.data.orgName
    }

    /** What the quick documentation and the note editor show of the allowlist; null when not audited. */
    fun view(manifest: VirtualFile, name: String): OrgView? {
        val kind = ManifestRegistry.forPath(manifest.path)?.kind ?: return null
        val folder = synchronized(lock) { folderKeyFor(manifest.path)?.let(folders::get) } ?: return null
        val layer = folder.layer ?: return null
        return OrgView.of(layer, folder.origin, folder.receivedAt, kind, name, ::formatTime)
    }

    /** The roots in org mode, for the MCP setup of their repositories. */
    fun orgFolders(): List<OrgFolder> {
        val roots = roots()
        return synchronized(lock) {
            roots.mapNotNull { (name, path) ->
                val folder = folders[keyOf(path)] ?: return@mapNotNull null
                if (copies[folder.orgUlid]?.loaded != true) return@mapNotNull null
                OrgFolder(name, folder.origin, folder.repoUlid, folder.orgUlid, folder.repoFullName)
            }.distinctBy { it.repoUlid }
        }
    }

    // ── Writing ──────────────────────────────────────────────────────────────

    /**
     * Save the note of a package in org mode. Empty layers delete the org note. Agent
     * lines that are not fields are left out (an org note holds fields only); their
     * count is returned so the caller can say so. Throws [DeposException] with a
     * message for the user. Off the UI thread: it is a request.
     */
    fun saveNote(manifest: VirtualFile, name: String, human: String, agent: String?): Int {
        val kind = ManifestRegistry.forPath(manifest.path)?.kind ?: throw DeposException(DeposStrings.orgNoteNotConnected)
        val (folder, copy, current) = synchronized(lock) {
            val folder = folderKeyFor(manifest.path)?.let(folders::get)
            val copy = folder?.let { copies[it.orgUlid] }?.takeIf { it.loaded }
                ?: throw DeposException(DeposStrings.orgNoteNotConnected)
            if (!copy.canEdit) throw DeposException(DeposStrings.orgNoteReadOnly)
            Triple(folder, copy, copy.note(kind, name, folder.repoUlid))
        }
        val (fields, dropped) = if (agent == null) (current?.fields ?: emptyList()) to 0 else OrgNotes.agentTextToFields(agent)
        val path = "/api/extension/organizations/${encodeUriComponent(folder.orgUlid)}/notes"

        if (human.isBlank() && fields.isEmpty()) {
            if (current == null) return dropped
            val query = encodeQuery(
                listOf("ecosystem" to kind.id, "packageName" to current.displayName, "baseUpdatedAt" to current.updatedAt),
            )
            afterWrite(connection.sendJson("DELETE", "$path?$query"))
            synchronized(lock) { copy.remove(current.ecosystem, current.noteKey) }
        } else {
            val body = JsonObject().apply {
                addProperty("ecosystem", kind.id)
                addProperty("packageName", current?.displayName ?: name)
                addProperty("humanText", human.trim())
                add("fields", OrgNotes.fieldsJson(fields))
                if (current == null) add("baseUpdatedAt", JsonNull.INSTANCE) else addProperty("baseUpdatedAt", current.updatedAt)
            }
            val result = connection.sendJson("PUT", path, body)
            afterWrite(result)
            val saved = (result as? SendResult.Ok)?.let { OrgNotes.parseNote(it.body) }
                ?: throw DeposException(DeposStrings.orgNoteSaveFailed)
            synchronized(lock) { copy.put(saved) }
        }
        persist(folder.origin, copy)
        fireChanged()
        return dropped
    }

    private fun afterWrite(result: SendResult) {
        when (result) {
            is SendResult.Ok -> return
            SendResult.SignedOut -> throw DeposException(DeposStrings.webSessionExpired)
            is SendResult.Status -> {
                // Someone else changed the note: bring the copy up to date before the user retries.
                if (result.status == 409) refresh()
                throw DeposException(result.message ?: DeposStrings.orgNoteSaveFailed)
            }
        }
    }

    // ── Fetching ─────────────────────────────────────────────────────────────

    /** Fetch every root again, off the UI thread. A call while one runs makes it run once more. */
    fun refresh() {
        if (disposed) return
        if (!running.compareAndSet(false, true)) {
            again = true
            return
        }
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                do {
                    again = false
                    refreshAll()
                } while (again && !disposed)
            } finally {
                running.set(false)
            }
            // Asked for between the last check and the release above.
            if (again && !disposed) refresh()
        }
    }

    private fun refreshAll() {
        lastRun = System.currentTimeMillis()
        try {
            val creds = connection.credentials()
            if (creds == null) {
                clearAll()
                return
            }
            var changed = false
            val seen = mutableSetOf<String>()
            val orgs = linkedSetOf<String>()
            for ((name, root) in roots()) {
                val key = keyOf(root)
                seen.add(key)
                changed = refreshFolder(name, root, key, creds.origin) || changed
                synchronized(lock) { folders[key]?.orgUlid }?.let(orgs::add)
            }
            synchronized(lock) {
                for (key in folders.keys.toList()) if (key !in seen) changed = folders.remove(key) != null || changed
            }
            for (orgUlid in orgs) changed = syncNotes(creds.origin, orgUlid) || changed
            if (changed) fireChanged()
        } catch (error: Exception) {
            log.warn("depos: org refresh failed", error)
        }
    }

    /**
     * Which organization the root's repository is in, asked on every refresh: a
     * repository removed from Depos, or a user removed from the organization, leaves
     * org mode. True when what the root shows changed.
     */
    private fun refreshFolder(name: String, root: Path, key: String, origin: String): Boolean {
        val repo = GitRemote.repositoryOf(root) ?: return synchronized(lock) { folders.remove(key) != null }
        val cacheKey = "$origin|${repo.lowercase()}"
        val cached = cached(cacheKey)
        var changed = false
        // Offline at start: use the last copies at once; the request below confirms them.
        if (cached != null && synchronized(lock) { key !in folders }) {
            changed = show(key, origin, cached)
            changed = loadCopy(origin, cached.orgUlid) || changed
        }

        try {
            val found = connection.fetchJson("/api/extension/workspace?repository=${encodeUriComponent(repo)}")
            when (found) {
                FetchResult.SignedOut, is FetchResult.Unchanged -> return changed
                is FetchResult.Status -> {
                    if (found.status == 404) return forget(key, cacheKey) || changed
                    log.info("depos: workspace lookup for $name answered HTTP ${found.status}")
                    return changed
                }
                is FetchResult.Ok -> {
                    val body = DeposJson.obj(found.body)
                    val repository = body?.get("repository") as? JsonObject
                    val organization = body?.get("organization") as? JsonObject
                    val repoUlid = repository?.str("ulid") ?: return changed
                    val orgUlid = organization?.str("ulid") ?: return changed
                    val fullName = repository.str("fullName")
                    // The allowlist layer belongs to the repository: a new one starts without it.
                    val next = if (cached?.repoUlid == repoUlid && cached.orgUlid == orgUlid) {
                        cached.copy(repoFullName = fullName ?: cached.repoFullName)
                    } else {
                        Cached(repoUlid, orgUlid, fullName)
                    }
                    if (next != cached) putCached(cacheKey, next)
                    changed = show(key, origin, next) || changed
                    changed = loadCopy(origin, orgUlid) || changed
                    return refreshAllowlist(name, key, cacheKey, origin, next) || changed
                }
            }
        } catch (error: Exception) {
            // Offline or the server is down: the last copies stay, with their times.
            log.info("depos: fetch for $name failed: ${error.message}")
            return changed
        }
    }

    /** The repository's allowlist layer, asked with the last ETag. True when what the root shows changed. */
    private fun refreshAllowlist(name: String, key: String, cacheKey: String, origin: String, cached: Cached): Boolean {
        val answer = connection.fetchJson(
            "/api/extension/repositories/${encodeUriComponent(cached.repoUlid)}/context",
            cached.allowlist?.etag,
        )
        when (answer) {
            FetchResult.SignedOut -> return false
            is FetchResult.Unchanged -> {
                val allowlist = cached.allowlist ?: return false
                val next = cached.copy(allowlist = allowlist.copy(receivedAt = System.currentTimeMillis()))
                putCached(cacheKey, next)
                return show(key, origin, next)
            }
            is FetchResult.Status -> {
                // The repository left Depos, or the user left the organization: nothing of it stays.
                if (answer.status == 404) return forget(key, cacheKey)
                log.info("depos: allowlist layer for $name answered HTTP ${answer.status}")
                return false
            }
            is FetchResult.Ok -> {
                val raw = answer.body
                val data = OrgLayers.parse(raw)
                if (raw == null || data == null) {
                    log.warn("depos: unexpected allowlist answer for $name")
                    return false
                }
                val next = cached.copy(allowlist = CachedAllowlist(raw, data, answer.etag, System.currentTimeMillis()))
                putCached(cacheKey, next)
                return show(key, origin, next)
            }
        }
    }

    /** Bring the org notes copy up to date, page by page. True when anything changed. */
    private fun syncNotes(origin: String, orgUlid: String): Boolean {
        loadCopy(origin, orgUlid)
        val copy = synchronized(lock) { copies.getOrPut(orgUlid) { OrgNotesCopy(orgUlid) } }
        var changed = false
        try {
            var page = 0
            while (page < MAX_SYNC_PAGES) {
                page++
                val cursor = synchronized(lock) { copy.cursor }
                val since = if (cursor.isNotEmpty()) "?since=${encodeUriComponent(cursor)}" else ""
                val answer = connection.fetchJson("/api/extension/organizations/${encodeUriComponent(orgUlid)}/notes$since")
                when (answer) {
                    FetchResult.SignedOut, is FetchResult.Unchanged -> return changed
                    is FetchResult.Status -> {
                        if (answer.status == 404) return forgetOrg(origin, orgUlid) || changed
                        // A cursor the server no longer accepts: start over with a full copy.
                        if (answer.status == 400 && cursor.isNotEmpty()) {
                            synchronized(lock) { copy.cursor = "" }
                            continue
                        }
                        log.info("depos: org notes sync answered HTTP ${answer.status}")
                        return changed
                    }
                    is FetchResult.Ok -> {
                        val sync = OrgNotes.parseSync(answer.body)
                        if (sync == null) {
                            log.warn("depos: unexpected org notes answer")
                            return changed
                        }
                        changed = synchronized(lock) {
                            val wasLoaded = copy.loaded
                            copy.apply(sync, System.currentTimeMillis()) || !wasLoaded
                        } || changed
                        if (!sync.more) break
                    }
                }
            }
            persist(origin, copy)
        } catch (error: Exception) {
            log.info("depos: org notes sync failed: ${error.message}")
        }
        return changed
    }

    private fun show(key: String, origin: String, cached: Cached): Boolean = synchronized(lock) {
        val before = folders[key]
        val allowlist = cached.allowlist
        if (before != null && before.origin == origin && before.orgUlid == cached.orgUlid && before.repoUlid == cached.repoUlid) {
            // Same ETag, same layer: only its time moves.
            val sameLayer = if (allowlist != null) {
                before.layer != null && allowlist.etag != null && before.etag == allowlist.etag
            } else {
                before.layer == null
            }
            if (sameLayer) {
                before.receivedAt = allowlist?.receivedAt ?: before.receivedAt
                return false
            }
        }
        folders[key] = FolderOrg(
            origin = origin,
            repoUlid = cached.repoUlid,
            orgUlid = cached.orgUlid,
            repoFullName = cached.repoFullName,
            layer = allowlist?.let { OrgLayer(it.data) },
            receivedAt = allowlist?.receivedAt ?: 0,
            etag = allowlist?.etag,
        )
        true
    }

    private fun forget(key: String, cacheKey: String): Boolean {
        putCached(cacheKey, null)
        return synchronized(lock) { folders.remove(key) != null }
    }

    private fun fireChanged() {
        ApplicationManager.getApplication().invokeLater {
            if (!disposed && !project.isDisposed) project.getService(PacmonProjectService::class.java).orgChanged()
        }
    }

    // ── The local copies ─────────────────────────────────────────────────────

    private fun serverDirectory(origin: String): Path =
        DeposConnection.storageDirectory().resolve(origin.replace(Regex("[^A-Za-z0-9.-]+"), "_"))

    private fun notesFile(origin: String, orgUlid: String): Path =
        serverDirectory(origin).resolve("org-notes").resolve("${orgUlid.replace(Regex("[^A-Za-z0-9]"), "")}.json")

    private val cacheFile: Path get() = DeposConnection.storageDirectory().resolve("repositories.json")

    /** The repository answers of every server, read once per session. */
    private fun cachedEntries(): MutableMap<String, Cached> = synchronized(lock) {
        cache ?: readCache().also { cache = it }
    }

    private fun cached(cacheKey: String): Cached? = synchronized(lock) { cachedEntries()[cacheKey] }

    private fun putCached(cacheKey: String, value: Cached?) {
        val text = synchronized(lock) {
            val entries = cachedEntries()
            if (value == null) entries.remove(cacheKey) else entries[cacheKey] = value
            JsonObject().apply { entries.forEach { (key, entry) -> add(key, cachedJson(entry)) } }.toString()
        }
        try {
            Files.createDirectories(cacheFile.parent)
            Files.writeString(cacheFile, text)
        } catch (error: Exception) {
            log.warn("depos: could not keep the repository answers", error)
        }
    }

    private fun readCache(): MutableMap<String, Cached> {
        val entries = HashMap<String, Cached>()
        val json = try {
            if (Files.isRegularFile(cacheFile)) DeposJson.obj(DeposJson.parse(Files.readString(cacheFile))) else null
        } catch (_: Exception) {
            null
        } ?: return entries
        for ((key, value) in json.entrySet()) {
            val entry = value as? JsonObject ?: continue
            val repoUlid = entry.str("repoUlid") ?: continue
            val orgUlid = entry.str("orgUlid") ?: continue
            val allowlist = (entry.get("allowlist") as? JsonObject)?.let { raw ->
                val data = raw.get("data")
                OrgLayers.parse(data)?.let { CachedAllowlist(data, it, raw.str("etag"), raw.number("receivedAt") ?: 0) }
            }
            entries[key] = Cached(repoUlid, orgUlid, entry.str("repoFullName"), allowlist)
        }
        return entries
    }

    private fun cachedJson(entry: Cached): JsonObject = JsonObject().apply {
        addProperty("repoUlid", entry.repoUlid)
        addProperty("orgUlid", entry.orgUlid)
        entry.repoFullName?.let { addProperty("repoFullName", it) }
        entry.allowlist?.let { allowlist ->
            add("allowlist", JsonObject().apply {
                add("data", allowlist.raw)
                allowlist.etag?.let { addProperty("etag", it) }
                addProperty("receivedAt", allowlist.receivedAt)
            })
        }
    }

    /** Read the copy from disk once per session. True when a copy appeared. */
    private fun loadCopy(origin: String, orgUlid: String): Boolean {
        if (synchronized(lock) { orgUlid in copies }) return false
        val snapshot = try {
            val file = notesFile(origin, orgUlid)
            if (Files.isRegularFile(file)) OrgNotes.parseSnapshot(DeposJson.parse(Files.readString(file))) else null
        } catch (_: Exception) {
            // No copy yet: the sync makes one.
            null
        }
        if (snapshot == null || snapshot.orgUlid != orgUlid) return false
        return synchronized(lock) {
            if (orgUlid in copies) false else true.also { copies[orgUlid] = OrgNotesCopy(orgUlid, snapshot) }
        }
    }

    private fun persist(origin: String, copy: OrgNotesCopy) {
        val text = synchronized(lock) { OrgNotes.snapshotJson(copy.snapshot()) }
        try {
            val file = notesFile(origin, copy.orgUlid)
            Files.createDirectories(file.parent)
            Files.writeString(file, text)
        } catch (error: Exception) {
            log.warn("depos: could not keep the org notes", error)
        }
    }

    /** The user left the organization: its notes and every root of it go. */
    private fun forgetOrg(origin: String, orgUlid: String): Boolean {
        try {
            Files.deleteIfExists(notesFile(origin, orgUlid))
        } catch (_: Exception) {
            // Already gone.
        }
        return synchronized(lock) {
            copies.remove(orgUlid)
            val gone = folders.filterValues { it.orgUlid == orgUlid }.keys
            gone.forEach(folders::remove)
            gone.isNotEmpty()
        }
    }

    /** Signed out: nothing of any organization stays, in memory or on disk. */
    private fun clearAll() {
        try {
            val directory = DeposConnection.storageDirectory()
            if (Files.exists(directory)) {
                Files.walk(directory).use { paths -> paths.sorted(Comparator.reverseOrder()).forEach(Files::deleteIfExists) }
            }
        } catch (error: Exception) {
            log.info("depos: could not remove the local copies: ${error.message}")
        }
        val had = synchronized(lock) {
            cache = null
            models.clear()
            val any = folders.isNotEmpty() || copies.isNotEmpty()
            folders.clear()
            copies.clear()
            any
        }
        if (had) fireChanged()
    }

    // ── Tests ────────────────────────────────────────────────────────────────

    /** Puts [rootPath] in org mode with [copy] and [layer], as a finished refresh would. */
    internal fun setForTest(rootPath: String, origin: String, repoUlid: String, copy: OrgNotesCopy, layer: OrgLayer? = null) {
        synchronized(lock) {
            folders[rootPath.replace('\\', '/').trimEnd('/')] = FolderOrg(origin, repoUlid, copy.orgUlid, null, layer, 0, null)
            copies[copy.orgUlid] = copy
        }
    }

    internal fun clearForTest() = synchronized(lock) {
        folders.clear()
        copies.clear()
        models.clear()
    }

    companion object {
        /** How often org data is fetched again while the project is open. */
        private const val REFRESH_INTERVAL_MIN = 5L
        /** Focusing the IDE refreshes, but not more often than this. */
        private const val FOCUS_MIN_GAP_MS = 30_000L
        /** A sync stops after this many pages and goes on at the next refresh. */
        private const val MAX_SYNC_PAGES = 50
        private val timeFormat = DateTimeFormatter.ofPattern("HH:mm")

        fun getInstance(project: Project): OrgContext = project.getService(OrgContext::class.java)

        fun formatTime(epochMillis: Long): String = timeFormat.format(Instant.ofEpochMilli(epochMillis).atZone(ZoneId.systemDefault()))
    }
}
