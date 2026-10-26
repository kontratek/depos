package dev.pacmon.jetbrains.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/**
 * Writes `.depos/AGENT-RULES.md` and, into whichever instruction files the
 * user picks (`AGENTS.md`, `CLAUDE.md`, …), the three-line pointer to it —
 * the JetBrains counterpart of the VS Code extension's
 * "Depos: Set Up AI Instructions" command.
 */
class SetupAiInstructionsAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        PacmonCommands.setUpAiInstructions(project)
    }
}
