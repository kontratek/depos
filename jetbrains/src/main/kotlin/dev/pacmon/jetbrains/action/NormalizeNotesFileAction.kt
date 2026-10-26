package dev.pacmon.jetbrains.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/**
 * Rewrites `.depos/DEPENDENCY-NOTES.md` into `docs/format.md`'s canonical
 * form — the JetBrains counterpart of the VS Code extension's
 * "Depos: Format DEPENDENCY-NOTES.md" command.
 */
class NormalizeNotesFileAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        PacmonCommands.formatNotesFile(project)
    }
}
