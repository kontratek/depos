package dev.pacmon.jetbrains.action

import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.WindowManager
import dev.pacmon.jetbrains.core.NotesCore
import dev.pacmon.jetbrains.core.ManifestRegistry
import dev.pacmon.jetbrains.depos.OrgContext
import dev.pacmon.jetbrains.service.PacmonProjectService
import com.intellij.testFramework.LightVirtualFile
import dev.pacmon.jetbrains.settings.Decorations

/**
 * What the Depos actions actually do, with no `AnActionEvent` in sight — the
 * Tools menu invokes these and so do the buttons in the tool window's Actions
 * section, which have no action event to hand. The VS Code extension reaches
 * the same five commands from its view the same way.
 *
 * Every one of them takes the dependency manifest to work from, because the caller
 * usually knows better than the active editor does: the tool window keeps
 * showing the last dependency manifest you looked at even after you switch away from
 * it.
 */
object PacmonCommands {
    fun openNotesFile(project: Project, manifest: VirtualFile? = null) {
        val chosen = manifest?.takeIf { it.isValid && ManifestRegistry.forPath(it.path) != null }
            ?: FileEditorManager.getInstance(project).selectedFiles.firstOrNull { ManifestRegistry.forPath(it.path) != null }
            ?: service(project).defaultManifest()
        if (chosen != null && service(project).isOrgMode(chosen)) {
            openOrgNotes(project, chosen)
            return
        }
        val notesFile = findNotesFile(project, manifest)
        if (notesFile == null) {
            Messages.showInfoMessage(
                project,
                "No ${NotesCore.NOTES_FILE_NAME} found. Use \"Add/Edit Dependency Note\" to create one.",
                "Depos",
            )
            return
        }
        service(project).open(notesFile)
    }

    /**
     * Org mode: the org notes of the manifest's ecosystem, as the notes file they
     * stand in for — read-only, and never on disk. A change goes through the note
     * editor or Depos.
     */
    fun openOrgNotes(project: Project, manifest: VirtualFile) {
        val text = OrgContext.getInstance(project).notesText(manifest) ?: return
        val kind = ManifestRegistry.forPath(manifest.path)?.kind ?: return
        val file = LightVirtualFile("Notes from Depos (${kind.id}).md", text).apply { isWritable = false }
        service(project).open(file)
    }

    /** The mirror of [openNotesFile]: the manifest the notes describe. */
    fun openManifest(project: Project, manifest: VirtualFile? = null) {
        val selected = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()
        val file = manifest?.takeIf { it.isValid && ManifestRegistry.forPath(it.path) != null }
            ?: selected?.let { service(project).manifestBesideNotes(it) }
            ?: service(project).defaultManifest()
        if (file == null) {
            Messages.showInfoMessage(project, "No supported dependency manifest found in this project.", "Depos")
            return
        }
        service(project).open(file)
    }

    /** Backward-compatible action id retained for existing keymaps. */
    fun openPackageJson(project: Project, manifest: VirtualFile? = null) = openManifest(project, manifest)

    fun formatNotesFile(project: Project, manifest: VirtualFile? = null) {
        val statusBar = WindowManager.getInstance().getStatusBar(project)
        val notesFile = findNotesFile(project, manifest)
        if (notesFile == null) {
            statusBar?.info =
                "Depos: no ${NotesCore.NOTES_FILE_NAME} found. Use \"Add/Edit Dependency Note\" to create one."
            return
        }

        var changed = false
        WriteCommandAction.runWriteCommandAction(project, "Format DEPENDENCY-NOTES.md", null, {
            val document = FileDocumentManager.getInstance().getDocument(notesFile) ?: return@runWriteCommandAction
            // The header keeps naming the AGENT-RULES.md of the directory the file is in.
            val canonical = NotesCore.normalizeText(
                document.text,
                service(project).notesKind(notesFile),
                NotesCore.notesDirOf(notesFile.path),
            )
            if (canonical != document.text) {
                document.setText(canonical)
                FileDocumentManager.getInstance().saveDocument(document)
                changed = true
            }
        })
        statusBar?.info = if (changed) {
            "Depos: ${NotesCore.NOTES_FILE_NAME} formatted."
        } else {
            "Depos: ${NotesCore.NOTES_FILE_NAME} is already in canonical form."
        }
        service(project).open(notesFile)
    }

    fun setUpAiInstructions(project: Project) {
        val dialog = AiInstructionsTargetsDialog(project)
        if (!dialog.showAndGet()) return
        val written = service(project).setUpAiInstructions(dialog.selectedTargets())
        WindowManager.getInstance().getStatusBar(project)?.info =
            "Depos: AI instructions written to ${written.joinToString(", ")}."
    }

    /**
     * The end-of-line hint off and back on again, without a trip to the
     * settings — the counterpart of VS Code's "Toggle Note Markers". Coming
     * back on means `preview`, the default, since `badge` is a deliberate
     * choice nobody arrives at by toggling.
     */
    fun toggleDecorations(project: Project) {
        val notes = service(project)
        val on = notes.decorations() == Decorations.OFF
        notes.state.decorations = if (on) Decorations.PREVIEW else Decorations.OFF
        notes.settingsChanged()
        WindowManager.getInstance().getStatusBar(project)?.info =
            if (on) "Depos: note markers on." else "Depos: note markers off."
    }

    /**
     * The notes file in play: the one open in the editor, else the one for the
     * given (or active) dependency manifest, else the project root's.
     */
    fun findNotesFile(project: Project, manifest: VirtualFile? = null): VirtualFile? {
        val notes = service(project)
        val selected = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()
        if (selected != null && notes.notesKind(selected) != null) return selected

        val chosen = manifest?.takeIf { it.isValid && ManifestRegistry.forPath(it.path) != null }
            ?: selected?.takeIf { ManifestRegistry.forPath(it.path) != null }
            ?: notes.defaultManifest()
        if (chosen != null) notes.resolveNotesFile(chosen)?.let { return it }

        return null
    }

    fun defaultManifest(project: Project): VirtualFile? = service(project).defaultManifest()

    /** Backward-compatible npm-era name. */
    fun defaultPackageJson(project: Project): VirtualFile? = defaultManifest(project)

    fun projectRoot(project: Project): VirtualFile? = project.basePath
        ?.replace('\\', '/')
        ?.let { LocalFileSystem.getInstance().findFileByPath(it) }

    private fun service(project: Project): PacmonProjectService =
        project.getService(PacmonProjectService::class.java)
}
