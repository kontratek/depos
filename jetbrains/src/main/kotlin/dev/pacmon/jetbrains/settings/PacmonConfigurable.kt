package dev.pacmon.jetbrains.settings

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.JBUI
import dev.pacmon.jetbrains.depos.DeposConnection
import dev.pacmon.jetbrains.depos.DeposStrings
import dev.pacmon.jetbrains.service.PacmonProjectService
import com.intellij.ui.components.JBTextField
import javax.swing.BoxLayout
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Tools → Pacmon: the same settings the tool window shows, for anyone who
 * looks for them in Settings first. The tool window is where they are
 * explained; this page is the plain list.
 */
class PacmonConfigurable(private val project: Project) : Configurable {
    private val monorepoMode = JComboBox(MonorepoModes.ALL.toTypedArray())
    private val inlineSource = JComboBox(InlineSources.ALL.toTypedArray())
    private val noteEntry = JComboBox(NoteEntries.ALL.toTypedArray())
    private val decorations = JComboBox(Decorations.ALL.toTypedArray())
    private val noteButtons = NoteButtons.ALL.associateWith { JBCheckBox(NoteButtons.label(it)) }
    private val deposUrl = JBTextField().apply { emptyText.text = DeposStrings.webUrlPlaceholder }
    private var panel: JPanel? = null

    override fun getDisplayName(): String = "Pacmon"

    override fun createComponent(): JComponent {
        val targets = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.emptyLeft(2)
            for (id in NoteButtons.ALL) add(noteButtons.getValue(id))
        }
        panel = FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel("Notes file selection:"), monorepoMode)
            .addLabeledComponent(JBLabel("Inline note source:"), inlineSource)
            .addLabeledComponent(JBLabel("Note editor:"), noteEntry)
            .addLabeledComponent(JBLabel("Note markers:"), decorations)
            .addLabeledComponent(JBLabel("Click targets:"), targets)
            .addSeparator()
            .addLabeledComponent(JBLabel("Depos address:"), deposUrl)
            .addComponentToRightColumn(JBLabel(DEPOS_HELP).apply { foreground = com.intellij.util.ui.UIUtil.getContextHelpForeground() })
            .addComponentFillVertically(JPanel(), 0)
            .panel
        reset()
        return panel!!
    }

    override fun isModified(): Boolean {
        val settings = service().state
        return monorepoMode.selectedItem != settings.monorepoMode ||
            inlineSource.selectedItem != settings.inlineSource ||
            noteEntry.selectedItem != settings.noteEntry ||
            decorations.selectedItem != settings.decorations ||
            selectedButtons() != settings.noteButtons.toList() ||
            deposUrl.text.trim() != DeposConnection.getInstance().url
    }

    override fun apply() {
        val service = service()
        val settings = service.state
        settings.monorepoMode = monorepoMode.selectedItem as String
        settings.inlineSource = inlineSource.selectedItem as String
        settings.noteEntry = noteEntry.selectedItem as String
        settings.decorations = decorations.selectedItem as String
        service.setNoteButtons(selectedButtons())
        service.settingsChanged()
        // For every project: the address, like the VS Code setting, is application-wide.
        DeposConnection.getInstance().url = deposUrl.text.trim()
    }

    override fun reset() {
        val service = service()
        val settings = service.state
        monorepoMode.selectedItem = settings.monorepoMode
        inlineSource.selectedItem = settings.inlineSource
        noteEntry.selectedItem = settings.noteEntry
        decorations.selectedItem = settings.decorations
        for ((id, box) in noteButtons) box.isSelected = service.noteButtonEnabled(id)
        deposUrl.text = DeposConnection.getInstance().url
    }

    override fun disposeUIResources() {
        panel = null
    }

    /** In the canonical order, so the comparison against the stored list holds. */
    private fun selectedButtons(): List<String> =
        NoteButtons.ALL.filter { noteButtons.getValue(it).isSelected }

    private fun service(): PacmonProjectService = project.getService(PacmonProjectService::class.java)

    private companion object {
        const val DEPOS_HELP = "<html>For the optional organization connection (Tools → Sign In to Depos, or the Pacmon " +
            "tool window). Signed in, a folder whose GitHub repository is added to one of your organizations uses the " +
            "organization's notes in Depos instead of its notes files. Pacmon makes network requests only while you are " +
            "signed in: for the actions, and to fetch the notes of each folder (at start, when the IDE gets focus, " +
            "and every 5 minutes). Must use https, except for localhost. For every project.</html>"
    }
}
