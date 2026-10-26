package dev.pacmon.jetbrains.action

import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.DumbService
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.WindowManager
import dev.pacmon.jetbrains.core.AiInstructions
import dev.pacmon.jetbrains.core.ManifestRegistry
import dev.pacmon.jetbrains.core.NotesCore
import dev.pacmon.jetbrains.depos.DeposConnection
import dev.pacmon.jetbrains.service.PacmonProjectService
import java.io.IOException

/**
 * "Move Notes to .depos/": every `.pacmon/` directory of the project — the notes'
 * directory from before Pacmon became Depos — renamed to `.depos/` at once, and
 * what points into them brought along: the header comment of each notes file,
 * AGENT-RULES.md, and the pointer block of the instruction files. One command, so
 * Undo puts it all back, and the IDE's version control sees renames. A port of
 * the VS Code extension's `src/ext/commands/moveNotes.ts`.
 *
 * Never run without asking: a teammate on a version from before Depos reads
 * `.pacmon/` only.
 */
object MoveNotes {
    // The same words as the VS Code extension (`src/ext/strings.ts`), "project"
    // where it says "workspace".
    const val ACTION = "Move Notes to .depos/"
    const val SUGGEST =
        "Depos: this repository keeps its notes in .pacmon/, their directory from before Pacmon became Depos. " +
            "Move them to .depos/ once everyone working in it has updated."
    const val NONE = "Depos: no .pacmon/ directory in this project — the notes are already in .depos/."

    fun conflict(paths: String): String =
        "Depos: a .depos/ directory already exists beside $paths. Merge the two by hand, then run Move Notes to .depos/ again."

    fun confirm(count: Int): String =
        "Move ${if (count == 1) "the .pacmon/ directory" else "$count .pacmon/ directories"} to .depos/? " +
            "Versions from before Depos read .pacmon/ only: move once everyone working here has updated."

    fun done(count: Int): String = "Depos: moved ${if (count == 1) "1 directory" else "$count directories"} to .depos/."

    fun failed(path: String, reason: String): String = "Depos: $path could not be moved to .depos/: $reason"

    /** On a `.pacmon/` notes file with a `.depos/` one beside it ([PacmonProjectService.shadowingNotesFile]). */
    fun shadowedNotesFile(current: String): String =
        "Ignored: $current is read instead of this file. Move what is still needed there, then delete this file."

    private const val TITLE = "Depos"
    private const val SUGGESTED_KEY = "depos.moveNotesSuggested"

    /** The header comment of a notes file names the AGENT-RULES.md beside it ([NotesCore.formatCommentLines]). */
    private val legacyRulesReference = "rules in ${NotesCore.agentRulesRelativePath(NotesCore.LEGACY_NOTES_DIRECTORY)}"
    private val currentRulesReference = "rules in ${NotesCore.agentRulesRelativePath(NotesCore.NOTES_DIRECTORY)}"
    private val pointerMarker = Regex("<!-- (?:depos|pacmon):")

    /** Once per project, when a notes file under `.pacmon/` is opened: the move, offered. */
    fun suggest(project: Project, file: VirtualFile) {
        if (NotesCore.notesDirOf(file.path) != NotesCore.LEGACY_NOTES_DIRECTORY) return
        if (ManifestRegistry.notesKindOfPath(file.path) == null) return
        val properties = PropertiesComponent.getInstance(project)
        if (properties.getBoolean(SUGGESTED_KEY)) return
        properties.setValue(SUGGESTED_KEY, true)
        DeposConnection.notify(project, SUGGEST, NotificationType.INFORMATION, ACTION) { moveToDepos(project) }
    }

    /**
     * Every `.pacmon/` directory of the project with notes or rules in it, outside
     * the directories never searched for notes ([PacmonProjectService.NOTES_DISCOVERY_EXCLUDED]).
     * Found through the file-name index, as the manifests are, rather than by
     * walking the tree: a large repository would hold the IDE up.
     */
    fun legacyDirectories(project: Project): List<VirtualFile> {
        val service = service(project)
        val roots = service.manifestRoots()
        val found = LinkedHashMap<String, VirtualFile>()
        for (file in listOf(NotesCore.NOTES_FILE_NAME, NotesCore.AGENT_RULES_FILE_NAME).flatMap(service::filesNamed)) {
            val root = roots.firstOrNull { VfsUtilCore.isAncestor(it, file, true) } ?: continue
            val segments = VfsUtilCore.getRelativePath(file, root)?.split('/') ?: continue
            if (segments.any { it in PacmonProjectService.NOTES_DISCOVERY_EXCLUDED }) continue
            // The innermost .pacmon/ the file is in.
            var directory = file.parent
            while (directory != null && directory != root && directory.name != NotesCore.LEGACY_NOTES_DIRECTORY) {
                directory = directory.parent
            }
            if (directory == null || directory == root) continue
            found.putIfAbsent(directory.path, directory)
        }
        return found.values.sortedBy { it.path }
    }

    /** [confirmed] skips the question, for programmatic callers (tests). */
    fun moveToDepos(project: Project, confirmed: Boolean = false) {
        // The suggestion's button can be clicked while the IDE indexes: the directories are found through the index.
        if (DumbService.isDumb(project)) {
            DumbService.getInstance(project).runWhenSmart { moveToDepos(project, confirmed) }
            return
        }
        val service = service(project)
        val legacy = legacyDirectories(project)
        if (legacy.isEmpty()) {
            Messages.showInfoMessage(project, NONE, TITLE)
            return
        }
        val conflicts = legacy.filter { it.parent?.findChild(NotesCore.NOTES_DIRECTORY) != null }
        if (conflicts.isNotEmpty()) {
            Messages.showWarningDialog(project, conflict(conflicts.joinToString(", ") { service.displayPath(it) }), TITLE)
            return
        }
        if (!confirmed) {
            val choice = Messages.showOkCancelDialog(
                project,
                confirm(legacy.size),
                TITLE,
                ACTION,
                Messages.getCancelButton(),
                Messages.getWarningIcon(),
            )
            if (choice != Messages.OK) return
        }

        val moved = mutableListOf<VirtualFile>()
        var failure: String? = null
        WriteCommandAction.runWriteCommandAction(project, ACTION, null, {
            for (directory in legacy) {
                val path = service.displayPath(directory)
                try {
                    directory.rename(this, NotesCore.NOTES_DIRECTORY)
                    moved.add(directory)
                } catch (error: IOException) {
                    failure = failed(path, error.message ?: error.javaClass.simpleName)
                    break
                }
            }
            if (moved.isEmpty()) return@runWriteCommandAction
            // The header comment of each notes file now names `.depos/AGENT-RULES.md`.
            for (directory in moved) {
                VfsUtilCore.iterateChildrenRecursively(directory, null) { file ->
                    if (!file.isDirectory && file.name == NotesCore.NOTES_FILE_NAME) rewriteRulesReference(file)
                    true
                }
            }
            for (root in service.manifestRoots()) {
                // The rules themselves, rewritten for `.depos/` where the root has a copy.
                if (root.findChild(NotesCore.NOTES_DIRECTORY)?.findChild(NotesCore.AGENT_RULES_FILE_NAME) != null) {
                    service.writeAgentRules(root, NotesCore.NOTES_DIRECTORY, overwrite = true)
                }
                // The pointer block, in the instruction files that have one.
                for (relative in AiInstructions.TARGETS) {
                    val file = root.findFileByRelativePath(relative)?.takeIf { !it.isDirectory } ?: continue
                    val document = FileDocumentManager.getInstance().getDocument(file) ?: continue
                    val text = document.text
                    if (!pointerMarker.containsMatchIn(text)) continue
                    val updated = AiInstructions.upsert(text, NotesCore.NOTES_DIRECTORY)
                    if (updated != text) {
                        document.setText(updated)
                        FileDocumentManager.getInstance().saveDocument(document)
                    }
                }
            }
        })
        if (moved.isNotEmpty()) {
            service.notesMoved(moved.mapTo(mutableSetOf()) { it.path })
            WindowManager.getInstance().getStatusBar(project)?.info = done(moved.size)
        }
        failure?.let { Messages.showErrorDialog(project, it, TITLE) }
    }

    private fun rewriteRulesReference(file: VirtualFile) {
        val document = FileDocumentManager.getInstance().getDocument(file) ?: return
        val at = document.text.indexOf(legacyRulesReference)
        if (at == -1) return
        document.replaceString(at, at + legacyRulesReference.length, currentRulesReference)
        FileDocumentManager.getInstance().saveDocument(document)
    }

    private fun service(project: Project): PacmonProjectService = project.getService(PacmonProjectService::class.java)
}

/** "Move Notes to .depos/" in Tools → Depos. */
class MoveNotesAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        MoveNotes.moveToDepos(event.project ?: return)
    }
}

/** A notes file under `.pacmon/` opened: the move, offered once per project ([MoveNotes.suggest]). */
class MoveNotesSuggestion(private val project: Project) : FileEditorManagerListener {
    override fun fileOpened(source: FileEditorManager, file: VirtualFile) = MoveNotes.suggest(project, file)
}
