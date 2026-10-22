package dev.pacmon.jetbrains.depos

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.ui.popup.JBPopupFactory
import java.awt.datatransfer.StringSelection

/** Starts org mode for a project: listeners, the 5-minute timer, the first fetch. */
class OrgStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        OrgContext.getInstance(project).start()
    }
}

/**
 * The Depos actions — the same four commands the VS Code extension has, plus the
 * MCP setup, which a JetBrains IDE cannot register for its agents.
 */
object DeposCommands {
    fun signIn(project: Project?) = DeposConnection.getInstance().signIn(project)

    fun signOut(project: Project?) = DeposConnection.getInstance().signOut(project)

    fun showConnection(project: Project?) = DeposConnection.getInstance().showConnection(project)

    fun refresh(project: Project) = OrgContext.getInstance(project).refresh()

    /**
     * An `.mcp.json` for the repository of a root in org mode, pointing at the MCP
     * server Depos serves to agents with an MCP key — the same file Depos shows under
     * Settings → AI agents. It never carries a key: the agent reads DEPOS_MCP_KEY.
     */
    fun copyMcpSetup(project: Project) {
        val folders = OrgContext.getInstance(project).orgFolders()
        when (folders.size) {
            0 -> DeposConnection.notify(project, DeposStrings.mcpNoOrgFolder, NotificationType.INFORMATION)
            1 -> copyMcpSetup(project, folders.single())
            else -> JBPopupFactory.getInstance()
                .createPopupChooserBuilder(folders)
                .setTitle(DeposStrings.mcpPickFolder)
                .setRenderer(com.intellij.ui.SimpleListCellRenderer.create("") { it.repoFullName ?: it.name })
                .setItemChosenCallback { copyMcpSetup(project, it) }
                .createPopup()
                .showCenteredInCurrentWindow(project)
        }
    }

    private fun copyMcpSetup(project: Project, folder: OrgContext.OrgFolder) {
        CopyPasteManager.getInstance().setContents(StringSelection(mcpJson(folder.origin, folder.repoUlid)))
        DeposConnection.notify(
            project,
            DeposStrings.mcpCopied(folder.repoFullName ?: folder.name),
            NotificationType.INFORMATION,
            DeposStrings.mcpOpenKeys,
        ) {
            BrowserUtil.browse("${folder.origin}/dashboard/${encodeUriComponent(folder.orgUlid)}/settings/ai-agents")
        }
    }

    /** The `.mcp.json` of `ConnectCommands.vue` in Depos, for one repository. */
    internal fun mcpJson(origin: String, repoUlid: String): String {
        val server = JsonObject().apply {
            addProperty("type", "http")
            addProperty("url", "$origin/api/mcp/repositories/${encodeUriComponent(repoUlid)}")
            add("headers", JsonObject().apply { addProperty("Authorization", "Bearer \${DEPOS_MCP_KEY}") })
        }
        val root = JsonObject().apply { add("mcpServers", JsonObject().apply { add("depos-notes", server) }) }
        return GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create().toJson(root) + "\n"
    }
}

abstract class DeposAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabledAndVisible = event.project != null
    }
}

class SignInToDeposAction : DeposAction() {
    override fun actionPerformed(event: AnActionEvent) = DeposCommands.signIn(event.project)
}

class SignOutOfDeposAction : DeposAction() {
    override fun actionPerformed(event: AnActionEvent) = DeposCommands.signOut(event.project)
}

class ShowDeposConnectionAction : DeposAction() {
    override fun actionPerformed(event: AnActionEvent) = DeposCommands.showConnection(event.project)
}

class RefreshOrgNotesAction : DeposAction() {
    override fun actionPerformed(event: AnActionEvent) {
        DeposCommands.refresh(event.project ?: return)
    }
}

class CopyDeposMcpSetupAction : DeposAction() {
    override fun actionPerformed(event: AnActionEvent) {
        DeposCommands.copyMcpSetup(event.project ?: return)
    }
}
