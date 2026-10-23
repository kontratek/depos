package dev.pacmon.jetbrains.editor

import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.EditorNotificationPanel
import com.intellij.ui.EditorNotificationProvider
import dev.pacmon.jetbrains.action.PacmonCommands
import dev.pacmon.jetbrains.core.NotesCore
import dev.pacmon.jetbrains.depos.DeposStrings
import dev.pacmon.jetbrains.depos.OrgContext
import dev.pacmon.jetbrains.service.PacmonProjectService
import java.util.function.Function
import javax.swing.JComponent

/**
 * In org mode a notes file is not read: the organization's org notes are the notes.
 * A red banner across the top of `DEPENDENCY-NOTES.md` says it is no longer used and
 * should be deleted — the error the VS Code extension puts on the file's first line,
 * in the place a JetBrains IDE shows one — with a link to the org notes that stand
 * in for it.
 */
class PacmonOrgModeNotificationProvider : EditorNotificationProvider, DumbAware {
    override fun collectNotificationData(project: Project, file: VirtualFile): Function<in FileEditor, out JComponent?>? {
        if (file.name != NotesCore.NOTES_FILE_NAME) return null
        val state = OrgContext.getInstance(project).notesFor(file) ?: return null
        val service = project.getService(PacmonProjectService::class.java)
        if (service.notesKind(file) == null) return null
        return Function { editor ->
            EditorNotificationPanel(editor, EditorNotificationPanel.Status.Error).apply {
                text = DeposStrings.orgModeNotesFile(state.orgName)
                createActionLabel(DeposStrings.orgOpenOrgNotes) {
                    service.manifestBesideNotes(file)?.let { PacmonCommands.openOrgNotes(project, it) }
                }
            }
        }
    }
}
