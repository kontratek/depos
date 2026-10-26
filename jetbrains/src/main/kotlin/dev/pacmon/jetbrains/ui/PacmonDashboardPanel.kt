package dev.pacmon.jetbrains.ui

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.JBColor
import com.intellij.ui.components.ActionLink
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBRadioButton
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.panel
import com.intellij.util.ui.JBUI
import dev.pacmon.jetbrains.action.PacmonCommands
import dev.pacmon.jetbrains.core.NotesCore
import dev.pacmon.jetbrains.core.ManifestRegistry
import dev.pacmon.jetbrains.depos.DeposCommands
import dev.pacmon.jetbrains.depos.DeposConnection
import dev.pacmon.jetbrains.depos.DeposConnectionListener
import dev.pacmon.jetbrains.depos.DeposStrings
import dev.pacmon.jetbrains.service.PacmonProjectService
import dev.pacmon.jetbrains.settings.PacmonConfigurable
import com.intellij.ui.dsl.builder.Row
import dev.pacmon.jetbrains.settings.Decorations
import dev.pacmon.jetbrains.settings.InlineSources
import dev.pacmon.jetbrains.settings.NoteButtons
import dev.pacmon.jetbrains.settings.NoteEntries
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Rectangle
import javax.swing.ButtonGroup
import javax.swing.JComponent
import javax.swing.JEditorPane
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JProgressBar
import javax.swing.Scrollable
import kotlin.math.roundToInt

/**
 * The Depos tool window's front page: the same six sections the VS Code
 * extension's activity-bar view has, in the same order and with the same
 * words — coverage, the click targets, the note editor, the note markers, the
 * inline note source, and the actions.
 *
 * Everything here writes straight through to [PacmonProjectService]; the
 * Settings page under Tools → Depos is the same settings again, for anyone
 * who looks there first.
 */
class PacmonDashboardPanel(private val project: Project) : JPanel(BorderLayout()) {
    internal data class CoverageSnapshot(
        val ratio: String,
        val packagePath: String,
        val percent: Int,
        val status: String,
        val barVisible: Boolean,
    )

    private val service = project.getService(PacmonProjectService::class.java)
    private val mutedColor = JBColor.namedColor("Label.disabledForeground", JBColor.GRAY)

    private val coverageBar = JProgressBar(0, 100).apply {
        border = JBUI.Borders.empty()
        preferredSize = Dimension(1, JBUI.scale(4))
        minimumSize = Dimension(1, JBUI.scale(4))
        isStringPainted = false
    }

    private lateinit var coverageCountLabel: JLabel
    private lateinit var packageLabel: JLabel
    private lateinit var coverageStatusLabel: JLabel
    private lateinit var targetsCountLabel: JLabel
    private lateinit var markersLede: JEditorPane
    private lateinit var openNotesLink: ActionLink
    private lateinit var webStatusLabel: JEditorPane
    private val signedOutRows = mutableListOf<Row>()
    private val signedInRows = mutableListOf<Row>()

    private val buttonToggles = LinkedHashMap<String, JBCheckBox>()
    private val noteEntryRadios = LinkedHashMap<String, JBRadioButton>()
    private val decorationRadios = LinkedHashMap<String, JBRadioButton>()
    private val inlineSourceRadios = LinkedHashMap<String, JBRadioButton>()

    private var lastManifest: VirtualFile? = null
    private var loading = false

    private val content = panel {
        row {
            label("Depos: Dependency Notes")
                .bold()
                .applyToComponent { font = font.deriveFont(font.size2D + 2f) }
                .resizableColumn()
            link("Reset") { resetToDefaults() }
                .applyToComponent { toolTipText = "Reset everything in this view to its default" }
            link("Settings") { ShowSettingsUtil.getInstance().showSettingsDialog(project, PacmonConfigurable::class.java) }
        }

        group("COVERAGE") {
            row {
                packageLabel = muted("").resizableColumn().component
                coverageCountLabel = muted("").align(AlignX.RIGHT).component
            }
            row {
                cell(coverageBar).align(AlignX.FILL)
            }
            row {
                coverageStatusLabel = muted("").component
            }
        }

        group("CLICK TARGETS") {
            row {
                comment("How you open a dependency's note from its manifest. Right-click always works too.")
                    .resizableColumn()
                targetsCountLabel = muted("").align(AlignX.RIGHT).component
            }
            for (id in NoteButtons.ALL) {
                row {
                    val box = checkBox(NoteButtons.label(id)).resizableColumn().component
                    box.addActionListener { if (!loading) writeNoteButtons() }
                    buttonToggles[id] = box
                    muted(NoteButtons.gesture(id)).align(AlignX.RIGHT)
                }
                indent {
                    row { cell(NoteExamples.forClickTarget(id)).align(AlignX.FILL) }
                    row { comment(NoteButtons.help(id)) }
                }
            }
        }

        group("NOTE EDITOR") {
            row { comment("Where a note is written when you open one from a dependency manifest.") }
            radioGroup(NoteEntries.ALL, noteEntryRadios, NoteEntries::help) { value ->
                service.state.noteEntry = value
            }
        }

        group("NOTE MARKERS") {
            row {
                markersLede = comment("End-of-line hint on dependencies that already have a note.").component
            }
            radioGroup(Decorations.ALL, decorationRadios, Decorations::help, NoteExamples::forMarker) { value ->
                service.state.decorations = value
            }
        }

        group("INLINE NOTE SOURCE") {
            row {
                comment(
                    "Which layer of a note shows next to the dependency and leads its quick documentation. " +
                        "Every note has two: what people write under the heading, and the \"Agent notes\" " +
                        "block AI agents fill in. The documentation always shows both.",
                )
            }
            radioGroup(InlineSources.ALL, inlineSourceRadios, InlineSources::help) { value ->
                service.state.inlineSource = value
            }
        }

        group("ACTIONS") {
            row {
                openNotesLink = link("Open ${NotesCore.NOTES_FILE_NAME}") {
                    PacmonCommands.openNotesFile(project, lastManifest)
                }.comment("The notes file for the dependency manifest you are in.").component
            }
            row {
                link("Open dependency manifest") { PacmonCommands.openManifest(project, lastManifest) }
                    .comment("The manifest these notes describe.")
            }
            row {
                link("Search dependencies…") { DependencyPicker.show(project, lastManifest) }
                    .comment("Every dependency in one list, documented or not — pick one to open its note.")
            }
            row {
                link("Format notes file") { PacmonCommands.formatNotesFile(project, lastManifest) }
                    .comment("Sort sections and canonicalize headings. Prose untouched.")
            }
            row {
                link("Set up AI instructions") { PacmonCommands.setUpAiInstructions(project) }
                    .comment(
                        "Write ${NotesCore.AGENT_RULES_RELATIVE_PATH} — the rules agents follow — and point " +
                            "AGENTS.md, CLAUDE.md and friends at it.",
                    )
            }
        }

        group(DeposStrings.viewGroupWeb) {
            row { webStatusLabel = comment("").component }
            signedOutRows += row {
                link(DeposStrings.viewWebSignIn) { DeposCommands.signIn(project) }.comment(DeposStrings.viewWebSignInHelp)
            }
            signedInRows += row {
                link(DeposStrings.viewWebShow) { DeposCommands.showConnection(project) }.comment(DeposStrings.viewWebShowHelp)
            }
            signedInRows += row {
                link(DeposStrings.viewWebRefresh) { DeposCommands.refresh(project) }.comment(DeposStrings.viewWebRefreshHelp)
            }
            signedInRows += row {
                link(DeposStrings.viewWebMcp) { DeposCommands.copyMcpSetup(project) }.comment(DeposStrings.viewWebMcpHelp)
            }
            signedInRows += row {
                link(DeposStrings.viewWebSignOut) { DeposCommands.signOut(project) }.comment(DeposStrings.viewWebSignOutHelp)
            }
        }
    }

    init {
        border = JBUI.Borders.empty()
        content.border = JBUI.Borders.empty(8, 12)
        add(
            JBScrollPane(WidthTrackingWrapper(content)).apply {
                border = JBUI.Borders.empty()
                horizontalScrollBarPolicy = JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER
            },
            BorderLayout.CENTER,
        )

        project.messageBus.connect(project).subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) {
                    if (event.newFile?.let { ManifestRegistry.forPath(it.path) } != null) {
                        lastManifest = event.newFile
                        event.newFile?.let(service::rememberManifest)
                    }
                    scheduleRefresh()
                }
            },
        )
        ApplicationManager.getApplication().messageBus.connect(project).subscribe(
            DeposConnectionListener.TOPIC,
            object : DeposConnectionListener {
                override fun connectionChanged() = scheduleRefresh()
                override fun statusKnown() = scheduleRefresh()
            },
        )
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                if (FileDocumentManager.getInstance().getFile(event.document)?.let { ManifestRegistry.forPath(it.path) } != null) {
                    scheduleRefresh()
                }
            }
        }, project)
    }

    fun refresh() {
        loading = true
        for ((id, box) in buttonToggles) box.isSelected = service.noteButtonEnabled(id)
        noteEntryRadios[service.noteEntry()]?.isSelected = true
        decorationRadios[service.decorations()]?.isSelected = true
        inlineSourceRadios[service.state.inlineSource]?.isSelected = true
        loading = false
        refreshTargetsCount()
        refreshWeb()

        val selected = FileEditorManager.getInstance(project).selectedFiles
            .firstOrNull { ManifestRegistry.forPath(it.path) != null }
        if (selected != null) {
            lastManifest = selected
            service.rememberManifest(selected)
        }
        val manifest = selected ?: lastManifest?.takeIf { it.isValid } ?: service.defaultManifest()
        markersLede.text = markersHelp(manifest)
        openNotesLink.text = "Open ${notesFileLabel(manifest)}"
        if (manifest == null) {
            showCoverage("", "", 0, "Open a dependency manifest to see its dependencies here.", false)
            return
        }
        val dependencies = service.dependenciesForCoverage(manifest)
        if (dependencies.isEmpty()) {
            showCoverage("", relativePath(manifest), 0, "This dependency manifest has no supported dependencies.", false)
            return
        }
        val documented = dependencies.count { service.noteFor(it.manifest, it.name) != null }
        val missing = dependencies.size - documented
        val status = when (missing) {
            0 -> "Every dependency has a note."
            1 -> "1 dependency has no note yet."
            else -> "$missing dependencies have no note yet."
        }
        showCoverage(
            "$documented of ${dependencies.size}",
            relativePath(manifest),
            (documented * 100.0 / dependencies.size).roundToInt(),
            status,
            true,
        )
    }

    internal fun coverageForTest(): CoverageSnapshot = CoverageSnapshot(
        coverageCountLabel.text,
        packageLabel.text,
        coverageBar.value,
        coverageStatusLabel.text,
        coverageBar.isVisible,
    )

    internal fun setNoteButtonForTest(id: String, on: Boolean) {
        buttonToggles.getValue(id).isSelected = on
        writeNoteButtons()
    }

    internal fun selectChoiceForTest(group: String, value: String) {
        val radios = when (group) {
            "noteEntry" -> noteEntryRadios
            "decorations" -> decorationRadios
            else -> inlineSourceRadios
        }
        radios.getValue(value).doClick()
    }

    internal fun resetForTest() = resetToDefaults()

    private fun resetToDefaults() {
        service.resetViewSettings()
        service.settingsChanged()
        refresh()
    }

    /**
     * The checkboxes are not exclusive, so the whole set is written at once and
     * the service puts them back in canonical order — the same thing the VS
     * Code view does with `pacmon.noteButtons`.
     */
    private fun writeNoteButtons() {
        service.setNoteButtons(buttonToggles.filterValues { it.isSelected }.keys)
        refreshTargetsCount()
        service.settingsChanged()
    }

    /** The Depos group: from the setting and the last known token state, with no request. */
    private fun refreshWeb() {
        val status = DeposConnection.getInstance().status()
        webStatusLabel.text = when {
            status.invalid -> DeposStrings.viewWebInvalidUrl
            status.signedIn && status.host != null -> DeposStrings.viewWebSignedIn(status.host)
            else -> DeposStrings.viewWebSignedOut(status.host)
        }
        signedOutRows.forEach { it.visible(!status.signedIn) }
        signedInRows.forEach { it.visible(status.signedIn) }
    }

    private fun refreshTargetsCount() {
        targetsCountLabel.text = "${service.noteButtons().size} of ${NoteButtons.ALL.size}"
    }

    private fun markersHelp(manifest: VirtualFile?): String =
        "End-of-line hint on dependencies that already have a note in ${notesFileLabel(manifest)}."

    /** The notes file this manifest resolves to, shown the way you would
     *  type it — or the bare file name when there is no notes file yet. */
    private fun notesFileLabel(manifest: VirtualFile?): String {
        val notesFile = manifest?.takeIf { it.isValid }?.let(service::resolveNotesFile)
        return if (notesFile == null) NotesCore.NOTES_FILE_NAME else relativePath(notesFile)
    }

    private fun showCoverage(ratio: String, file: String, percent: Int, status: String, showBar: Boolean) {
        coverageCountLabel.text = ratio
        packageLabel.text = file
        coverageBar.value = percent
        coverageBar.isVisible = showBar
        coverageStatusLabel.text = status
    }

    private fun scheduleRefresh() = ApplicationManager.getApplication().invokeLater {
        if (!project.isDisposed) refresh()
    }

    private fun relativePath(file: VirtualFile): String {
        val root = project.basePath?.replace('\\', '/')?.trimEnd('/') ?: return file.name
        return file.path.replace('\\', '/').removePrefix("$root/")
    }

    private fun com.intellij.ui.dsl.builder.Row.muted(text: String) =
        label(text).applyToComponent { foreground = mutedColor }

    /**
     * One exclusive group of choices with its help line under each — the Swing
     * shape of the VS Code view's radio rows. Writing goes through [apply];
     * every group refreshes the editor afterwards, since each of them changes
     * what dependency manifests look like.
     */
    private fun com.intellij.ui.dsl.builder.Panel.radioGroup(
        values: List<String>,
        into: MutableMap<String, JBRadioButton>,
        help: (String) -> String,
        example: ((String) -> JComponent)? = null,
        apply: (String) -> Unit,
    ) {
        // The DSL refuses a radio button outside a `buttonsGroup`, and a group
        // only keeps them exclusive once it is bound to a property. These are
        // written straight through to the service instead, so the exclusivity
        // comes from a plain ButtonGroup of our own.
        val group = ButtonGroup()
        buttonsGroup(indent = false) {
            for (value in values) {
                row {
                    val button = radioButton(value).component
                    button.addActionListener {
                        if (!loading && button.isSelected) {
                            apply(value)
                            service.settingsChanged()
                            markersLede.text = markersHelp(lastManifest)
                        }
                    }
                    into[value] = button
                }
                indent {
                    example?.let { build -> row { cell(build(value)).align(AlignX.FILL) } }
                    row { comment(help(value)) }
                }
            }
        }
        for (button in values.mapNotNull(into::get)) group.add(button)
    }

    /**
     * Six sections are taller than a tool window, so the page scrolls — but it
     * must never scroll sideways: the help lines wrap to the width they are
     * given, and a viewport that lets the content keep its own preferred width
     * would clip the right-hand edge instead, with the horizontal scrollbar
     * turned off.
     */
    private class WidthTrackingWrapper(view: JComponent) : JPanel(BorderLayout()), Scrollable {
        init {
            isOpaque = false
            add(view, BorderLayout.CENTER)
        }

        override fun getPreferredScrollableViewportSize(): Dimension = preferredSize

        override fun getScrollableUnitIncrement(visible: Rectangle, orientation: Int, direction: Int): Int =
            JBUI.scale(16)

        override fun getScrollableBlockIncrement(visible: Rectangle, orientation: Int, direction: Int): Int =
            JBUI.scale(64)

        override fun getScrollableTracksViewportWidth(): Boolean = true

        override fun getScrollableTracksViewportHeight(): Boolean = false
    }
}
