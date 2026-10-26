package dev.pacmon.jetbrains.action

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.CheckBoxList
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import dev.pacmon.jetbrains.core.AiInstructions
import java.awt.BorderLayout
import java.awt.Dimension
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Which instruction files get the three-line pointer to
 * `.depos/AGENT-RULES.md`. The same list, in the same order, as the VS Code
 * extension's quick pick, and like it, a file that already exists is ticked so
 * its block is refreshed rather than left stale.
 */
class AiInstructionsTargetsDialog(project: Project) : DialogWrapper(project) {
    private val list = CheckBoxList<String>()

    init {
        title = "Set Up AI Instructions"
        val root = PacmonCommands.projectRoot(project)
        for (target in AiInstructions.TARGETS) {
            val exists = target.split('/').fold(root) { dir, part -> dir?.findChild(part) } != null
            list.addItem(
                target,
                if (exists) "$target — exists, block will be updated" else "$target — will be created",
                exists || target == "AGENTS.md",
            )
        }
        init()
    }

    fun selectedTargets(): List<String> = AiInstructions.TARGETS.filter(list::isItemSelected)

    override fun createCenterPanel(): JComponent = JPanel(BorderLayout(0, 8)).apply {
        border = JBUI.Borders.empty(4)
        add(JBLabel("Write dependency-notes format instructions into:"), BorderLayout.NORTH)
        list.preferredSize = Dimension(420, 120)
        add(list, BorderLayout.CENTER)
    }
}
