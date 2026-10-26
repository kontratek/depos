package dev.pacmon.jetbrains.ui

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project

/**
 * The Depos tool window's title action: back from a note to the front page —
 * coverage, the settings and the actions. The tool window shows one or the
 * other, and opening a note from a dependency manifest swaps the front page out, so
 * there has to be a way back that does not mean closing the tool window.
 */
class ShowDashboardAction(private val project: Project) :
    AnAction("Dependency Notes Overview", "Show coverage, settings and actions", AllIcons.Actions.Back),
    DumbAware {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.EDT

    override fun actionPerformed(event: AnActionEvent) {
        project.getService(PacmonToolWindowService::class.java).showDashboard()
    }
}
