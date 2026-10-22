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
     * The same five settings the VS Code extension contributes under `pacmon.*`,
     * with the same names and the same defaults — see the extension manifest and
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
    private var lastManifest: VirtualFile? = null
    private val discoveryExcludedDirectories = mapOf(
        ManifestKind.ZIG to setOf("zig-pkg", ".zig-cache", "zig-cache", "zig-out"),
        ManifestKind.PYTHON to setOf(".venv", "venv", ".tox", ".nox", "site-packages", "dist", "build", ".git"),
        ManifestKind.RUBY to setOf(".bundle", "vendor", ".git"),
        ManifestKind.GO to setOf("vendor", "testdata", ".git"),
        ManifestKind.NUGET to setOf("bin", "obj"),
    )

    init {
        project.messageBus.connect(this).subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                if (events.none { isRelevantPath(it.path) }) return
                dependencyCache.clear()
                manifestIndex.clear()
                val changedPacmonFiles = events.map { it.path.replace('\\', '/') }
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
            val notesFile = existing ?: createNotesFile(creationTargetDirectory(manifest), kind)
            val current = if (existing == null) "" else textOf(notesFile)
            val updated = if (existing == null || current.isBlank()) {
                NotesCore.newNotesFile(dependency, human, agent, kind)
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
     * Two writes: `.pacmon/AGENT-RULES.md` is rewritten from the plugin's own
     * copy (the rules and the field list, owned by Pacmon), and each of
     * [targets] (relative to the project root, e.g. `AGENTS.md`) gets the
     * three-line pointer to it, inserted or updated between markers. Returns
     * every path actually written, `AGENT-RULES.md` first.
     */
    fun setUpAiInstructions(targets: List<String>): List<String> {
        val root = projectRoot() ?: return emptyList()
        val written = mutableListOf<String>()
        WriteCommandAction.runWriteCommandAction(project, "Set Up AI Instructions", null, {
            ensureAgentRules(overwrite = true)
            written.add(NotesCore.AGENT_RULES_RELATIVE_PATH)
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
                document.setText(StringUtil.convertLineSeparators(AiInstructions.upsert(document.text)))
                FileDocumentManager.getInstance().saveDocument(document)
                written.add(relative)
            }
        })
        return written
    }

    private fun createNotesFile(manifestDirectory: VirtualFile, kind: ManifestKind): VirtualFile {
        val parts = ManifestRegistry.forKind(kind).notesRelativePath.split('/')
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

    private fun manifestRoots(): List<VirtualFile> = buildList {
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
        val notesDirectory = root.findChild(NotesCore.NOTES_DIRECTORY)
            ?: root.createChildDirectory(this, NotesCore.NOTES_DIRECTORY)
        val existing = notesDirectory.findChild(NotesCore.AGENT_RULES_FILE_NAME)
        if (existing != null && !overwrite) return
        val rules = javaClass.getResourceAsStream("/pacmon/AGENT-RULES.md")
            ?.bufferedReader(Charsets.UTF_8)
            ?.use { it.readText() }
            ?: error("Bundled AGENT-RULES.md is missing.")
        val file = existing ?: notesDirectory.createChildData(this, NotesCore.AGENT_RULES_FILE_NAME)
        val document = FileDocumentManager.getInstance().getDocument(file)
            ?: error("Could not create AGENT-RULES.md.")
        document.setText(rules.replace("\r\n", "\n"))
        FileDocumentManager.getInstance().saveDocument(document)
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

    private fun notesIn(directory: VirtualFile, kind: ManifestKind): VirtualFile? {
        var current: VirtualFile? = directory
        for (part in ManifestRegistry.forKind(kind).notesRelativePath.split('/')) {
            current = current?.findChild(part) ?: return null
        }
        return current?.takeIf { !it.isDirectory }
    }

    fun notesKind(file: VirtualFile): ManifestKind? {
        val normalized = file.path.replace('\\', '/')
        return ManifestRegistry.adapters.firstOrNull {
            normalized.endsWith("/${it.notesRelativePath}")
        }?.kind
    }

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

    private fun isRelevantPath(path: String): Boolean {
        val normalized = path.replace('\\', '/')
        return ManifestRegistry.adapters.any {
            it.matchesPath(normalized) ||
                normalized.endsWith("/${it.notesRelativePath}")
        }
    }
}
