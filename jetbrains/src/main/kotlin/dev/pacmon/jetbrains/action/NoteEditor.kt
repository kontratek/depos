package dev.pacmon.jetbrains.action

import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Disposer
import com.intellij.util.ui.JBUI
import dev.pacmon.jetbrains.editor.DependencyRef
import dev.pacmon.jetbrains.service.PacmonProjectService
import dev.pacmon.jetbrains.settings.NoteEntries
import dev.pacmon.jetbrains.ui.PacmonTarget
import dev.pacmon.jetbrains.ui.PacmonToolWindowPanel
import dev.pacmon.jetbrains.ui.PacmonToolWindowService
import java.awt.Dimension

/**
 * Where a note is written when one is opened from a dependency manifest — the
 * `noteEntry` setting, the same two first-class choices the VS Code extension
 * offers:
 *
 * - `panel`: the note editor in the Depos tool window, which stays open as you
 *   move from dependency to dependency.
 * - `peek`: the same editor in a popup over the dependency line, closest to
 *   VS Code's embedded peek editor — it comes up where you are looking and
 *   goes away when you are done.
 *
 * Both write through the same panel, so both autosave into
 * `.depos/DEPENDENCY-NOTES.md` the same way.
 */
object NoteEditor {
    fun open(project: Project, dependency: DependencyRef, editor: Editor? = null) {
        val service = project.getService(PacmonProjectService::class.java)
        service.rememberManifest(dependency.manifest)
        val entry = service.noteEntry()
        // Org mode always opens the panel, as in VS Code: it carries the allowlist
        // result and the read-only state, which a popup over the line has no room for.
        if (entry == NoteEntries.PEEK && !service.isOrgMode(dependency.manifest)) {
            openPeek(project, dependency, editor)
        } else {
            openPanel(project, dependency)
        }
    }

    private fun openPanel(project: Project, dependency: DependencyRef) {
        project.getService(PacmonToolWindowService::class.java).open(dependency)
    }

    private fun openPeek(project: Project, dependency: DependencyRef, editor: Editor?) {
        val manifest = dependency.manifest
        val panel = PacmonToolWindowPanel(project)
        panel.preferredSize = Dimension(JBUI.scale(520), JBUI.scale(360))
        panel.showTarget(PacmonTarget(manifest, dependency.name, dependency.section))
        val popup = JBPopupFactory.getInstance()
            .createComponentPopupBuilder(panel, panel)
            .setProject(project)
            .setTitle("Note — ${dependency.name}")
            .setResizable(true)
            .setMovable(true)
            .setRequestFocus(true)
            // The note autosaves as you type, so clicking away is a perfectly
            // good way to be done with it — but a click INSIDE the popup must
            // not close it, and neither must the IDE losing focus while a note
            // is half written.
            .setCancelOnClickOutside(true)
            .setCancelOnWindowDeactivation(false)
            .createPopup()
        // Whatever is still unsaved when the popup closes is flushed by the
        // panel's own dispose.
        Disposer.register(popup, panel)
        if (editor != null) popup.showInBestPositionFor(editor) else popup.showCenteredInCurrentWindow(project)
    }
}
