package dev.pacmon.jetbrains.service

import com.intellij.codeInsight.daemon.DaemonCodeAnalyzer
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.IndexNotReadyException
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.util.text.StringUtil
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent
import com.intellij.openapi.vfs.newvfs.events.VFilePropertyChangeEvent
import com.intellij.psi.PsiManager
import com.intellij.ui.EditorNotifications
import com.intellij.psi.search.FilenameIndex
import com.intellij.psi.search.GlobalSearchScope
import dev.pacmon.jetbrains.core.AiInstructions
import dev.pacmon.jetbrains.core.DependencyEntry
import dev.pacmon.jetbrains.core.InlineSource
import dev.pacmon.jetbrains.core.ManifestKind
import dev.pacmon.jetbrains.core.ManifestRegistry
import dev.pacmon.jetbrains.core.NotesCore
import dev.pacmon.jetbrains.core.NotesFileModel
import dev.pacmon.jetbrains.core.SectionLayers
import dev.pacmon.jetbrains.depos.OrgContext
import dev.pacmon.jetbrains.settings.Decorations
import dev.pacmon.jetbrains.settings.InlineSources
import dev.pacmon.jetbrains.settings.MonorepoModes
import dev.pacmon.jetbrains.settings.NoteButtons
import dev.pacmon.jetbrains.settings.NoteEntries
import dev.pacmon.jetbrains.editor.DependencyRef
import java.util.concurrent.ConcurrentHashMap

@Service(Service.Level.PROJECT)
@State(name = "PacmonSettings", storages = [Storage(StoragePathMacros.WORKSPACE_FILE)])
class PacmonProjectService(private val project: Project) :
    com.intellij.openapi.components.PersistentStateComponent<PacmonProjectService.Settings>,
    Disposable {
    /**
     * The same five settings the VS Code extension contributes under `depos.*`
     * (`pacmon.*` before the rename), with the same names and the same defaults.
     * The state keeps its Pacmon-era name, so stored values carry over. See the
     * extension manifest and
     * `dev.pacmon.jetbrains.settings.PacmonOptions` for the values each accepts.
     * `noteButtons` is a list because the click targets are not exclusive: any
     * combination of them may be on at once, including none.
     */
    data class Settings(
        var monorepoMode: String = MonorepoModes.NEAREST,
        var inlineSource: String = InlineSources.HUMAN_FIRST,
        var noteEntry: String = NoteEntries.PANEL,
        var decorations: String = Decorations.PREVIEW,
        var noteButtons: MutableList<String> = NoteButtons.DEFAULT.toMutableList(),
    )

    /**
     * A dependency's note. In org mode it comes from the organization's org notes in
     * Depos: [file] is null and [orgName] names the organization.
     */
    data class Note(
        val file: VirtualFile?,
        val model: NotesFileModel,
        val layers: SectionLayers,
        val orgName: String? = null,
    )

    private var settings = Settings()
    private data class CachedDependencies(val stamp: Long, val entries: List<DependencyEntry>)
    private val dependencyCache = ConcurrentHashMap<String, CachedDependencies>()
    private val manifestIndex = ConcurrentHashMap<ManifestKind, List<VirtualFile>>()
    /** [notesDirForRoot] by root path: `.depos` or `.pacmon`. */
    private val notesDirCache = ConcurrentHashMap<String, String>()
    private var lastManifest: VirtualFile? = null
    private val discoveryExcludedDirectories = mapOf(
        ManifestKind.ZIG to setOf("zig-pkg", ".zig-cache", "zig-cache", "zig-out"),
        ManifestKind.PYTHON to setOf(".venv", "venv", ".tox", ".nox", "site-packages", "dist", "build", ".git"),
        ManifestKind.RUBY to setOf(".bundle", "vendor", ".git"),
        ManifestKind.COMPOSER to setOf("vendor", ".git"),
        ManifestKind.GO to setOf("vendor", "testdata", ".git"),
        ManifestKind.NUGET to setOf("bin", "obj"),
        ManifestKind.VCPKG to setOf("vcpkg_installed", ".git"),
        ManifestKind.CONAN to setOf(".conan", ".conan2", ".git"),
    )

    init {
        project.messageBus.connect(this).subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                val paths = events.flatMap(::eventPaths)
                if (paths.none(::isRelevantPath)) return
                dependencyCache.clear()
                manifestIndex.clear()
                if (paths.any(::isInNotesDirectory)) notesDirCache.clear()
                val changedPacmonFiles = paths.map { it.replace('\\', '/') }
                    .filter(::isRelevantPath)
                    .toSet()
                ApplicationManager.getApplication().invokeLater {
                    if (project.isDisposed) return@invokeLater
                    refreshOpenEditors()
                    if (changedPacmonFiles.isNotEmpty()) {
                        project.messageBus.syncPublisher(PacmonNotesListener.TOPIC).notesChanged(changedPacmonFiles)
                    }
                }
            }
        })
    }

    override fun getState(): Settings = settings

    override fun loadState(state: Settings) {
        settings = state
    }

    override fun dispose() = Unit

    /**
     * Every setting in the tool window changes what dependency manifests look like,
     * so the open editors have to be told — and restarting the daemon on its
     * own does not tell them.
     *
     * The inlay pass stamps the project's PSI modification count onto each
     * editor as it collects hints, and skips the editor entirely on the next
     * pass while that count still matches. Nothing about ticking a click
     * target moves it, so the marks stayed exactly as they were until the file
     * was edited, or closed and reopened. Dropping the PSI caches moves the
     * count, which is what makes the pass run again. It is a heavier hammer
     * than the job wants, but the alternative is the internal API the platform
     * uses for its own inlay settings, and this happens once per click in a
     * settings panel, never in a loop.
     */
    fun settingsChanged() {
        PsiManager.getInstance(project).dropPsiCaches()
        refreshOpenEditors()
    }

    /** Whether [file]'s root is in org mode: signed in to Depos, its repository in an organization. */
    fun isOrgMode(file: VirtualFile): Boolean = OrgContext.getInstance(project).notesFor(file) != null

    /**
     * Org data changed — the org notes, the allowlist, or the mode of a root. No file
     * changed, so the PSI caches have to go for the marks to follow (see
     * [settingsChanged]), and the tool window is told with [PacmonNotesListener.ORG_NOTES].
     */
    fun orgChanged() {
        settingsChanged()
        // The org-mode banner on open notes files comes and goes with org mode.
        EditorNotifications.getInstance(project).updateAllNotifications()
        project.messageBus.syncPublisher(PacmonNotesListener.TOPIC).notesChanged(setOf(PacmonNotesListener.ORG_NOTES))
    }

    /**
     * The daemon for everything it produces, and a repaint for the end-of-line
     * markers, which [dev.pacmon.jetbrains.editor.PacmonLinePainter] draws
     * straight onto the editor rather than through a pass — nothing the daemon
     * does would bring them back.
     */
    private fun refreshOpenEditors() {
        DaemonCodeAnalyzer.getInstance(project).restart()
        for (editor in EditorFactory.getInstance().allEditors) {
            if (editor.project == project) editor.contentComponent.repaint()
        }
    }

    fun inlineSource(): InlineSource = when (settings.inlineSource) {
        InlineSources.AI_FIRST -> InlineSource.AI_FIRST
        InlineSources.HUMAN_ONLY -> InlineSource.HUMAN_ONLY
        InlineSources.AI_ONLY -> InlineSource.AI_ONLY
        else -> InlineSource.HUMAN_FIRST
    }

    /** Whether one of the five click targets is on. Unknown ids are off. */
    fun noteButtonEnabled(id: String): Boolean = id in settings.noteButtons

    fun noteButtons(): List<String> = NoteButtons.ALL.filter(::noteButtonEnabled)

    /**
     * Writes the click targets in the canonical order, so the stored value reads
     * the same however the boxes were ticked, and unknown ids never survive.
     */
    fun setNoteButtons(ids: Collection<String>) {
        settings.noteButtons = NoteButtons.ALL.filter { it in ids }.toMutableList()
    }

    fun decorations(): String = settings.decorations

    fun noteEntry(): String = settings.noteEntry

    /** Everything the tool window controls, back to the shipped defaults. */
    fun resetViewSettings() {
        val defaults = Settings()
        settings.inlineSource = defaults.inlineSource
        settings.noteEntry = defaults.noteEntry
        settings.decorations = defaults.decorations
        settings.noteButtons = defaults.noteButtons
    }

    fun dependencies(manifest: VirtualFile): List<DependencyRef> {
        val adapter = ManifestRegistry.forPath(manifest.path) ?: return emptyList()
        val document = FileDocumentManager.getInstance().getCachedDocument(manifest)
        val stamp = document?.modificationStamp ?: manifest.modificationStamp
        val cached = dependencyCache[manifest.path]
        val entries = if (cached?.stamp == stamp) {
            cached.entries
        } else {
            val parsed = adapter.extractDependencies(textOf(manifest), manifest.path)
            dependencyCache[manifest.path] = CachedDependencies(stamp, parsed)
            parsed
        }
        return entries.map { DependencyRef(manifest, it) }
    }

    fun dependencyAt(manifest: VirtualFile, offset: Int, lineFallback: Boolean = false): DependencyRef? {
        rememberManifest(manifest)
        val entries = dependencies(manifest)
        val exact = ManifestRegistry.dependencyAtOffset(entries.map { it.entry }, offset)
        if (exact != null) return DependencyRef(manifest, exact)
        if (!lineFallback) return null
        val document = FileDocumentManager.getInstance().getDocument(manifest) ?: return null
        val line = document.getLineNumber(offset.coerceIn(0, document.textLength))
        return entries.firstOrNull { document.getLineNumber(it.primaryRange.offset) == line }
    }

    /**
     * The one place a note is read: quick documentation, the marks, the end-of-line
     * hint, coverage and the note editor all come here. In org mode the notes file is
     * not read — the organization's org notes are the notes.
     */
    fun noteFor(manifest: VirtualFile, dependency: String): Note? {
        val org = OrgContext.getInstance(project)
        org.notesModel(manifest)?.let { model ->
            val section = NotesCore.findSection(model, dependency) ?: return null
            val layers = NotesCore.layers(model, section)
            if (layers.human.isBlank() && layers.agent.isBlank() && layers.generated.isBlank()) return null
            return Note(null, model, layers, org.notesFor(manifest)?.orgName)
        }
        val notesFile = resolveNotesFile(manifest) ?: return null
        val text = textOf(notesFile)
        val model = NotesCore.parse(text)
        val section = NotesCore.findSection(model, dependency) ?: return null
        val layers = NotesCore.layers(model, section)
        if (layers.human.isBlank() && layers.agent.isBlank() && layers.generated.isBlank()) return null
        return Note(notesFile, model, layers)
    }

    fun resolveNotesFile(manifest: VirtualFile): VirtualFile? {
        val kind = ManifestRegistry.forPath(manifest.path)?.kind ?: return null
        val root = manifestRoot(manifest) ?: return null
        if (settings.monorepoMode == MonorepoModes.ROOT_ONLY) return notesIn(root, kind)
        var directory: VirtualFile? = manifestOwnerDirectory(manifest)
        repeat(64) {
            val current = directory ?: return null
            notesIn(current, kind)?.let { return it }
            if (current == root || !VfsUtilCore.isAncestor(root, current, false)) return null
            directory = current.parent
        }
        return null
    }

    fun creationTargetDirectory(manifest: VirtualFile): VirtualFile = manifestOwnerDirectory(manifest)

    /**
     * Where a first note for [manifest] goes: beside the directory that owns it,
     * in the notes directory of its repository ([notesDirForRoot]).
     */
    fun creationTargetPath(manifest: VirtualFile): String {
        val kind = ManifestRegistry.forPath(manifest.path)?.kind ?: ManifestKind.NPM
        return "${creationTargetDirectory(manifest).path}/${NotesCore.notesRelativePath(kind, newNotesDirectory(manifest))}"
    }

    /**
     * The notes directory new files go to under [root], decided once for the whole
     * repository: `.depos/` when anything is there (AGENT-RULES.md or a notes file),
     * else `.pacmon/` when anything is there, else `.depos/`. A repository that keeps
     * its notes in `.pacmon/` stays there whole — the first note of a new ecosystem
     * or of a new monorepo package included — until "Move Notes to .depos/" moves
     * all of it: a teammate on a version from before Depos reads `.pacmon/` only,
     * and must not lose sight of half of the notes.
     */
    fun notesDirForRoot(root: VirtualFile): String {
        notesDirCache[root.path]?.let { return it }
        var complete = true
        val decided = NotesCore.NOTES_DIRECTORIES.firstOrNull { dir ->
            notesDirInUse(root, dir) ?: false.also { complete = false }
        } ?: NotesCore.NOTES_DIRECTORY
        // While the index is being built the answer covers the root only: asked again once it is ready.
        if (complete) notesDirCache[root.path] = decided
        return decided
    }

    /** Where a manifest's notes are: the directory of its notes file, or the one a first note would go to. */
    fun notesDirForManifest(manifest: VirtualFile): String =
        resolveNotesFile(manifest)?.let { NotesCore.notesDirOf(it.path) } ?: newNotesDirectory(manifest)

    /**
     * How messages name the notes file of [manifest]: its path from the directory
     * that owns the manifest, under the notes directory it is (or will be) in —
     * `.depos/cargo/DEPENDENCY-NOTES.md`, or `.pacmon/…` in a repository not moved yet.
     */
    fun notesRelativePathFor(manifest: VirtualFile): String {
        val adapter = ManifestRegistry.forPath(manifest.path) ?: return NotesCore.NOTES_RELATIVE_PATH
        return ManifestRegistry.notesRelativePathIn(adapter, notesDirForManifest(manifest))
    }

    /** For a notes file under `.pacmon/`: the `.depos/` file beside it that is read instead, if there is one. */
    fun shadowingNotesFile(notesFile: VirtualFile): VirtualFile? {
        val current = NotesCore.inCurrentNotesDir(notesFile.path) ?: return null
        return notesFile.fileSystem.findFileByPath(current)?.takeIf { !it.isDirectory }
    }

    /** [file]'s path from the root it is under, the way messages name files; its full path outside every root. */
    fun displayPath(file: VirtualFile): String =
        manifestRoot(file)?.let { VfsUtilCore.getRelativePath(file, it) } ?: file.path

    private fun newNotesDirectory(manifest: VirtualFile): String =
        manifestRoot(manifest)?.let(::notesDirForRoot) ?: NotesCore.NOTES_DIRECTORY

    /** Whether anything is under [dir] in [root]; null when only the index could tell, and it is not ready. */
    private fun notesDirInUse(root: VirtualFile, dir: String): Boolean? {
        // Every write puts AGENT-RULES.md at the root, so this answers for most repositories.
        if (root.findChild(dir)?.findChild(NotesCore.AGENT_RULES_FILE_NAME)?.isDirectory == false) return true
        if (ManifestRegistry.adapters.any { notesIn(root, it.kind, dir) != null }) return true
        val notesFiles = try {
            filesNamed(NotesCore.NOTES_FILE_NAME)
        } catch (_: IndexNotReadyException) {
            return null
        }
        return notesFiles.any { file ->
            val segments = VfsUtilCore.getRelativePath(file, root)?.split('/') ?: return@any false
            dir in segments.dropLast(1) && segments.none { it in NOTES_DISCOVERY_EXCLUDED }
        }
    }

    /** The project's files with this name, from the index: none from libraries or excluded folders. */
    fun filesNamed(name: String): Collection<VirtualFile> = ReadAction.compute<Collection<VirtualFile>, RuntimeException> {
        FilenameIndex.getVirtualFilesByName(name, GlobalSearchScope.projectScope(project))
    }

    private fun manifestOwnerDirectory(manifest: VirtualFile): VirtualFile {
        val adapter = ManifestRegistry.forPath(manifest.path)
        if (adapter?.kind == ManifestKind.PYTHON && manifest.name != "pyproject.toml") {
            var directory = manifest.parent
            repeat(64) {
                if (directory.name == "requirements") return directory.parent ?: directory
                directory = directory.parent ?: return manifest.parent
            }
            return manifest.parent
        }
        if (adapter?.kind != ManifestKind.NUGET || manifest.name == "Directory.Packages.props") return manifest.parent
        val directOwner = manifest.parent
        val root = manifestRoot(manifest) ?: return directOwner
        var directory = directOwner
        repeat(64) {
            val central = directory.findChild("Directory.Packages.props")
            if (central != null && !central.isDirectory) return directory
            if (directory == root || !VfsUtilCore.isAncestor(root, directory, false)) return directOwner
            directory = directory.parent ?: return directOwner
        }
        return directOwner
    }

    fun saveNoteLayers(manifest: VirtualFile, dependency: String, human: String, agent: String): VirtualFile {
        val kind = ManifestRegistry.forPath(manifest.path)?.kind ?: error("Unsupported dependency manifest.")
        var result: VirtualFile? = null
        WriteCommandAction.runWriteCommandAction(project, "Update dependency note", null, {
            val existing = resolveNotesFile(manifest)
            val notesFile = existing
                ?: createNotesFile(creationTargetDirectory(manifest), kind, newNotesDirectory(manifest))
            val current = if (existing == null) "" else textOf(notesFile)
            val updated = if (existing == null || current.isBlank()) {
                // The header names the AGENT-RULES.md of the directory the file is in.
                NotesCore.newNotesFile(dependency, human, agent, kind, NotesCore.notesDirOf(notesFile.path))
            } else {
                NotesCore.upsertNoteLayers(current, dependency, human, agent)
            }
            val document = FileDocumentManager.getInstance().getDocument(notesFile)
                ?: error("Could not open the dependency notes file.")
            // IntelliJ documents always use LF internally. FileDocumentManager
            // restores the file's detected separator (for example CRLF) when
            // saving it back to disk.
            document.setText(StringUtil.convertLineSeparators(updated))
            FileDocumentManager.getInstance().saveDocument(document)
            ensureAgentRules()
            result = notesFile
        })
        val saved = checkNotNull(result)
        notifyNotesChanged(saved.path)
        return saved
    }

    fun open(file: VirtualFile) {
        FileEditorManager.getInstance(project).openFile(file, true)
    }

    /**
     * Two writes: `.depos/AGENT-RULES.md` (`.pacmon/` in a repository not moved
     * yet) is rewritten from the plugin's own copy (the rules and the field list,
     * owned by Depos), and each of [targets] (relative to the project root, e.g.
     * `AGENTS.md`) gets the three-line pointer to it, inserted or updated between
     * markers. Returns every path actually written, `AGENT-RULES.md` first.
     */
    fun setUpAiInstructions(targets: List<String>): List<String> {
        val root = projectRoot() ?: return emptyList()
        val written = mutableListOf<String>()
        WriteCommandAction.runWriteCommandAction(project, "Set Up AI Instructions", null, {
            val notesDir = notesDirForRoot(root)
            writeAgentRules(root, notesDir, overwrite = true)
            written.add(NotesCore.agentRulesRelativePath(notesDir))
            for (relative in targets) {
                val parts = relative.split('/')
                var directory = root
                for (part in parts.dropLast(1)) {
                    directory = directory.findChild(part) ?: directory.createChildDirectory(this, part)
                }
                val fileName = parts.last()
                val file = directory.findChild(fileName) ?: directory.createChildData(this, fileName)
                val document = FileDocumentManager.getInstance().getDocument(file)
                    ?: error("Could not open $relative.")
                document.setText(StringUtil.convertLineSeparators(AiInstructions.upsert(document.text, notesDir)))
                FileDocumentManager.getInstance().saveDocument(document)
                written.add(relative)
            }
        })
        return written
    }

    private fun createNotesFile(manifestDirectory: VirtualFile, kind: ManifestKind, notesDir: String): VirtualFile {
        val parts = NotesCore.notesRelativePath(kind, notesDir).split('/')
        var directory = manifestDirectory
        for (part in parts.dropLast(1)) {
            directory = directory.findChild(part) ?: directory.createChildDirectory(this, part)
        }
        return directory.findChild(parts.last()) ?: directory.createChildData(this, parts.last())
    }

    private fun manifestRoot(manifest: VirtualFile): VirtualFile? {
        val root = projectRoot()
        if (root != null && VfsUtilCore.isAncestor(root, manifest, false)) return root
        return ProjectFileIndex.getInstance(project).getContentRootForFile(manifest)
            ?: ProjectRootManager.getInstance(project).contentRoots.firstOrNull()
            ?: root
    }

    /** The project root first, then every other content root. */
    fun manifestRoots(): List<VirtualFile> = buildList {
        projectRoot()?.let(::add)
        ProjectRootManager.getInstance(project).contentRoots.forEach { root ->
            if (none { it.path == root.path }) add(root)
        }
    }

    private fun projectRoot(): VirtualFile? = project.basePath
        ?.replace('\\', '/')
        ?.let { LocalFileSystem.getInstance().findFileByPath(it) }

    private fun ensureAgentRules(overwrite: Boolean = false) {
        val root = projectRoot() ?: return
        writeAgentRules(root, notesDirForRoot(root), overwrite)
    }

    /**
     * `<root>/<notesDir>/AGENT-RULES.md`: the plugin's own copy, which is written
     * for `.depos/`, as it reads in a repository whose notes are under [notesDir].
     * Kept as it is unless [overwrite]. In a write action.
     */
    fun writeAgentRules(root: VirtualFile, notesDir: String, overwrite: Boolean) {
        val notesDirectory = root.findChild(notesDir) ?: root.createChildDirectory(this, notesDir)
        val existing = notesDirectory.findChild(NotesCore.AGENT_RULES_FILE_NAME)
        if (existing != null && !overwrite) return
        val rules = javaClass.getResourceAsStream("/pacmon/AGENT-RULES.md")
            ?.bufferedReader(Charsets.UTF_8)
            ?.use { it.readText() }
            ?: error("Bundled AGENT-RULES.md is missing.")
        val file = existing ?: notesDirectory.createChildData(this, NotesCore.AGENT_RULES_FILE_NAME)
        val document = FileDocumentManager.getInstance().getDocument(file)
            ?: error("Could not create AGENT-RULES.md.")
        document.setText(NotesCore.inNotesDir(rules.replace("\r\n", "\n"), notesDir))
        FileDocumentManager.getInstance().saveDocument(document)
    }

    /**
     * After "Move Notes to .depos/": every answer kept about where the notes are is
     * stale, and everything that shows them is told, with the paths that moved.
     */
    fun notesMoved(paths: Set<String>) {
        dependencyCache.clear()
        manifestIndex.clear()
        notesDirCache.clear()
        refreshOpenEditors()
        EditorNotifications.getInstance(project).updateAllNotifications()
        project.messageBus.syncPublisher(PacmonNotesListener.TOPIC).notesChanged(paths)
    }

    /**
     * A saved note moves the PSI modification count by itself — the notes file
     * was just written — so this path only has to ask for the refresh, not
     * force one. It runs on every autosave, which is roughly every keystroke,
     * so it must stay cheap.
     */
    private fun notifyNotesChanged(path: String) {
        refreshOpenEditors()
        project.messageBus.syncPublisher(PacmonNotesListener.TOPIC)
            .notesChanged(setOf(path.replace('\\', '/')))
    }

    /** The notes file of [kind] in one directory: `.depos/` first, then `.pacmon/`. */
    private fun notesIn(directory: VirtualFile, kind: ManifestKind): VirtualFile? =
        NotesCore.NOTES_DIRECTORIES.firstNotNullOfOrNull { notesIn(directory, kind, it) }

    private fun notesIn(directory: VirtualFile, kind: ManifestKind, notesDir: String): VirtualFile? {
        var current: VirtualFile? = directory
        for (part in NotesCore.notesRelativePath(kind, notesDir).split('/')) {
            current = current?.findChild(part) ?: return null
        }
        return current?.takeIf { !it.isDirectory }
    }

    /** The ecosystem whose notes file [file] is, under `.depos/` or `.pacmon/`; null for any other file. */
    fun notesKind(file: VirtualFile): ManifestKind? = ManifestRegistry.notesKindOfPath(file.path)

    fun manifestBesideNotes(file: VirtualFile): VirtualFile? {
        val kind = notesKind(file) ?: return null
        val key = file.path.replace('\\', '/')
        return manifests(kind)
            .filter { resolveNotesFile(it)?.path?.replace('\\', '/') == key }
            .minByOrNull(::manifestPriority)
    }

    fun dependenciesForNotes(notesFile: VirtualFile): List<DependencyRef> {
        val kind = notesKind(notesFile) ?: return emptyList()
        val key = notesFile.path.replace('\\', '/')
        val manifests = manifests(kind).filter { resolveNotesFile(it)?.path?.replace('\\', '/') == key }
        return deduplicateDependencies(kind, manifests.flatMap(::dependencies))
    }

    /** Coverage for NuGet and Ruby combines every manifest owned by the notes file,
     * even before that notes file exists. Other ecosystems remain manifest-local. */
    fun dependenciesForCoverage(manifest: VirtualFile): List<DependencyRef> {
        val kind = ManifestRegistry.forPath(manifest.path)?.kind ?: return emptyList()
        if (kind != ManifestKind.NUGET && kind != ManifestKind.RUBY) return dependencies(manifest)
        resolveNotesFile(manifest)?.let { return dependenciesForNotes(it) }
        val ownerPath = creationTargetDirectory(manifest).path
        val shared = manifests(kind)
            .filter { creationTargetDirectory(it).path == ownerPath }
            .flatMap(::dependencies)
        return deduplicateDependencies(kind, shared)
    }

    private fun manifests(kind: ManifestKind): List<VirtualFile> = manifestIndex.getOrPut(kind) {
        val adapter = ManifestRegistry.forKind(kind)
        ReadAction.compute<List<VirtualFile>, RuntimeException> {
            val names = when (kind) {
                ManifestKind.PYTHON -> FilenameIndex.getAllFilenames(project).filter { name ->
                    name == "pyproject.toml" || name.endsWith(".txt")
                }
                ManifestKind.NUGET -> FilenameIndex.getAllFilenames(project).filter(adapter::matchesPath)
                ManifestKind.RUBY -> FilenameIndex.getAllFilenames(project).filter(adapter::matchesPath)
                else -> adapter.fileNames
            }
            names.flatMap { fileName ->
                FilenameIndex.getVirtualFilesByName(
                    fileName,
                    GlobalSearchScope.projectScope(project),
                )
            }.filter {
                !it.isDirectory && adapter.matchesPath(it.path) && !isExcludedFromManifestDiscovery(it, kind)
            }.distinctBy { it.path }.sortedBy(::manifestPriority)
        }
    }

    private fun manifestPriority(file: VirtualFile): String {
        val adapter = ManifestRegistry.forPath(file.path)
        val rank = when (adapter?.kind) {
            ManifestKind.PYTHON -> when (file.name) {
                    "pyproject.toml" -> 0
                    "requirements.txt" -> 1
                    else -> 2
                }
            ManifestKind.NUGET -> if (file.name == "Directory.Packages.props") 0 else 1
            ManifestKind.RUBY -> when (file.name) {
                "Gemfile" -> 0
                "gems.rb" -> 1
                else -> 2
            }
            else -> adapter?.fileNames?.indexOf(file.name)?.takeIf { it >= 0 } ?: 99
        }
        return "%02d:%s".format(rank, file.path.replace('\\', '/'))
    }

    private fun deduplicateDependencies(kind: ManifestKind, dependencies: List<DependencyRef>): List<DependencyRef> {
        if (kind != ManifestKind.NUGET && kind != ManifestKind.RUBY) return dependencies
        val seen = mutableSetOf<String>()
        return dependencies.filter { dependency ->
            val key = ManifestRegistry.forKind(kind).normalizeNoteKey(dependency.name)
            seen.add(if (kind == ManifestKind.NUGET) key.lowercase() else key)
        }
    }

    private fun isExcludedFromManifestDiscovery(file: VirtualFile, kind: ManifestKind): Boolean {
        val excluded = discoveryExcludedDirectories[kind] ?: return false
        var directory = file.parent
        while (directory != null) {
            if (directory.name.lowercase() in excluded) return true
            directory = directory.parent
        }
        return false
    }

    fun rememberManifest(file: VirtualFile) {
        if (file.isValid && ManifestRegistry.forPath(file.path) != null) lastManifest = file
    }

    fun defaultManifest(): VirtualFile? {
        val selected = FileEditorManager.getInstance(project).selectedFiles.firstOrNull { ManifestRegistry.forPath(it.path) != null }
        if (selected != null) return selected.also(::rememberManifest)
        lastManifest?.takeIf { it.isValid }?.let { return it }
        for (root in manifestRoots()) {
            ManifestRegistry.adapters.firstNotNullOfOrNull { adapter ->
                adapter.fileNames.firstNotNullOfOrNull(root::findChild)
            }?.let { return it }
        }
        ManifestRegistry.adapters.forEach { adapter ->
            manifests(adapter.kind).firstOrNull()?.let { return it }
        }
        return null
    }

    private fun textOf(file: VirtualFile): String = ReadAction.compute<String, RuntimeException> {
        FileDocumentManager.getInstance().getCachedDocument(file)?.text ?: VfsUtilCore.loadText(file)
    }

    /** A manifest, or anything in a notes directory — a notes file, AGENT-RULES.md, the directory itself. */
    private fun isRelevantPath(path: String): Boolean {
        val normalized = path.replace('\\', '/')
        return ManifestRegistry.adapters.any { it.matchesPath(normalized) } || isInNotesDirectory(normalized)
    }

    private fun isInNotesDirectory(path: String): Boolean {
        val normalized = path.replace('\\', '/')
        return NotesCore.NOTES_DIRECTORIES.any { normalized.endsWith("/$it") || normalized.contains("/$it/") }
    }

    /** The paths an event touches: a move or a rename has two, the one it leaves and the one it takes. */
    private fun eventPaths(event: VFileEvent): List<String> = when {
        event is VFileMoveEvent -> listOf(event.oldPath, event.newPath)
        event is VFilePropertyChangeEvent && event.isRename -> listOf(event.oldPath, event.newPath)
        else -> listOf(event.path)
    }

    companion object {
        /**
         * Directories never searched for notes: dependencies, build output, caches,
         * virtual environments. The same list as the VS Code extension's
         * `DISCOVERY_EXCLUDE` (`src/ext/resolveNotesFile.ts`).
         */
        val NOTES_DISCOVERY_EXCLUDED = setOf(
            "node_modules", "target", ".gradle", "_build", "deps", "zig-pkg", ".zig-cache", "zig-cache", "zig-out",
            ".venv", "venv", ".tox", ".nox", "site-packages", "dist", "build", "bin", "obj", "vendor", "testdata",
            ".bundle", ".conan", ".conan2", "vcpkg_installed", ".git",
        )
    }
}
