package dev.pacmon.jetbrains.action

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import dev.pacmon.jetbrains.ui.DependencyPicker

/**
 * The searchable list of every dependency, documented or not, exactly as the
 * VS Code command of the same name shows it. The running totals live in the
 * Depos tool window; this is the list you pick from.
 */
class ShowCoverageAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        DependencyPicker.show(project, editor = event.getData(CommonDataKeys.EDITOR))
    }
}
