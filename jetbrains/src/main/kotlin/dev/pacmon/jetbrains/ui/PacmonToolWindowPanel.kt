package dev.pacmon.jetbrains.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.Alarm
import com.intellij.util.ui.JBUI
import dev.pacmon.jetbrains.core.AgentNotes
import dev.pacmon.jetbrains.core.AgentProblem
import dev.pacmon.jetbrains.core.NotesCore
import dev.pacmon.jetbrains.action.PacmonCommands
import dev.pacmon.jetbrains.depos.DeposConnection
import dev.pacmon.jetbrains.depos.DeposException
import dev.pacmon.jetbrains.depos.DeposStrings
import dev.pacmon.jetbrains.depos.OrgContext
import dev.pacmon.jetbrains.depos.OrgResult
import dev.pacmon.jetbrains.service.PacmonNotesListener
import dev.pacmon.jetbrains.service.PacmonProjectService
import com.intellij.ide.BrowserUtil
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JEditorPane
import javax.swing.JPanel
import javax.swing.SwingUtilities

/** The header button outside org mode; in org mode it reads [DeposStrings.orgOpenWeb]. */
private const val OPEN_NOTES_FILE = "Open notes file"

class PacmonToolWindowPanel(
    private val project: Project,
) : JPanel(BorderLayout()), Disposable {
    private data class Layers(val human: String, val agent: String)

    private val notes = project.getService(PacmonProjectService::class.java)
    private val saveAlarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private val nameLabel = JBLabel("Select a dependency").apply {
        // Matches the VS Code panel's `.dep`: the editor font (dependency
        // names read as code, not prose), bold standing in for its 600 weight.
        val editorScheme = EditorColorsManager.getInstance().globalScheme
        font = Font(editorScheme.editorFontName, Font.BOLD, editorScheme.editorFontSize + 2)
    }
    private val sectionLabel = Badge()
    /** The allowlist result from Depos beside the name: red when denied, yellow when not listed, green when allowed. */
    private val orgBadge = Badge().apply { isVisible = false }
    private val notesPathLabel = JBLabel("->  ${NotesCore.NOTES_RELATIVE_PATH}").apply {
        // Matches `.meta`: smaller and muted, secondary to the title above it.
        font = font.deriveFont(font.size2D - 1f)
        foreground = JBColor.namedColor(
            "Label.disabledForeground",
            JBColor(0x6F737A, 0xA0A0A0),
        )
    }
    private val openFileButton = JButton(OPEN_NOTES_FILE).apply {
        // Matches the VS Code panel's secondary button: modest text, tight
        // padding, no accent color — a quiet affordance, not a call to action.
        font = font.deriveFont(font.size2D - 1f)
        margin = JBUI.insets(2, 10)
    }
    private val statusLabel = JBLabel("")
    private val conflictPanel = JPanel(FlowLayout(FlowLayout.LEFT, 6, 4))
    private val conflictLabel = JBLabel("Notes changed on disk while this panel has unsaved edits.")
    private val reloadButton = JButton("Reload")
    private val keepButton = JButton("Keep mine")
    private val humanLayer = NoteLayerPanel(
        "Your note",
        "Nothing written yet — click to write.",
        ::onInput,
        ::saveNow,
    )
    private val agentLayer = NoteLayerPanel(
        null,
        "No agent notes yet — click to add.",
        ::onInput,
        ::saveNow,
    )
    private val agentToggle = JButton("\u25B8 Agent notes")
    private val agentContent = JPanel()
    private val problemsLabel = JBLabel("")
    private val fixButton = JButton("Fix")
    private val problemsPanel = JPanel(BorderLayout(8, 0))
    private val generatedPanel = JPanel(BorderLayout())
    private val generatedPreview = JEditorPane("text/html", "").apply {
        isEditable = false
        isOpaque = false
        putClientProperty(JEditorPane.HONOR_DISPLAY_PROPERTIES, true)
    }

    private val org = OrgContext.getInstance(project)
    private val mutedColor = JBColor.namedColor("Label.disabledForeground", JBColor(0x6F737A, 0xA0A0A0))
    private val readOnlyLabel = JBLabel(DeposStrings.orgNoteReadOnly).apply {
        foreground = mutedColor
        border = JBUI.Borders.emptyBottom(6)
        alignmentX = Component.LEFT_ALIGNMENT
    }

    private var target: PacmonTarget? = null
    private var baseline = Layers("", "")
    private var writing = false
    /** A save to Depos is on its way; the next one waits for it. */
    private var orgSaving = false
    private var readOnly = false
    private var conflict = false
    private var agentExpanded = false
    private var disposed = false

    init {
        border = JBUI.Borders.empty()
        add(createHeader(), BorderLayout.NORTH)
        add(createBody(), BorderLayout.CENTER)
        add(createFooter(), BorderLayout.SOUTH)

        openFileButton.addActionListener { openNotesFile() }
        agentToggle.addActionListener { setAgentExpanded(!agentExpanded) }
        reloadButton.addActionListener { loadFromDisk(focusEmpty = false) }
        keepButton.addActionListener { saveNow() }
        fixButton.addActionListener {
            agentLayer.replaceText(AgentNotes.fix(agentLayer.text))
            onInput()
            saveNow()
        }
        showConflict(false)
        setAgentExpanded(false)
        generatedPanel.isVisible = false
    }

    private fun createHeader(): JPanel {
        val title = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.X_AXIS)
            isOpaque = false
            add(nameLabel)
            add(Box.createHorizontalStrut(JBUI.scale(8)))
            add(orgBadge)
        }
        val titleRow = ResponsiveHeaderRow(title, openFileButton)
        val metadataRow = JPanel(BorderLayout(6, 0)).apply {
            isOpaque = false
            add(sectionLabel, BorderLayout.WEST)
            add(notesPathLabel, BorderLayout.CENTER)
        }
        val stacked = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            titleRow.alignmentX = Component.LEFT_ALIGNMENT
            metadataRow.alignmentX = Component.LEFT_ALIGNMENT
            add(titleRow)
            add(Box.createVerticalStrut(JBUI.scale(4)))
            add(metadataRow)
        }
        return JPanel(BorderLayout()).apply {
            border = BorderFactory.createCompoundBorder(
                JBUI.Borders.customLineBottom(JBColor.border()),
                JBUI.Borders.empty(10, 12),
            )
            add(stacked, BorderLayout.CENTER)
        }
    }

    private fun createBody(): JBScrollPane {
        problemsPanel.apply {
            alignmentX = Component.LEFT_ALIGNMENT
            border = BorderFactory.createCompoundBorder(
                JBUI.Borders.customLine(JBColor.ORANGE, 1),
                JBUI.Borders.empty(6),
            )
            add(problemsLabel, BorderLayout.CENTER)
            add(fixButton, BorderLayout.EAST)
            isVisible = false
        }
        agentToggle.apply {
            horizontalAlignment = JButton.LEFT
            alignmentX = Component.LEFT_ALIGNMENT
            foreground = JBColor.namedColor(
                "Label.disabledForeground",
                JBColor(0x6F737A, 0xA0A0A0),
            )
            isBorderPainted = false
            isContentAreaFilled = false
            isFocusPainted = false
            margin = JBUI.emptyInsets()
        }
        agentContent.apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            add(JBLabel("<html>Written by AI agents as \"- key: value\" lines (rules in ${NotesCore.AGENT_RULES_RELATIVE_PATH}).<br>Edit if you must; agents revise these as they work.</html>").apply {
                alignmentX = Component.LEFT_ALIGNMENT
                border = JBUI.Borders.empty(5, 12, 0, 0)
            })
            agentLayer.alignmentX = Component.LEFT_ALIGNMENT
            add(agentLayer)
            add(problemsPanel)
        }
        generatedPanel.apply {
            alignmentX = Component.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyTop(10)
            add(JBLabel("Generated (read-only)"), BorderLayout.NORTH)
            add(generatedPreview, BorderLayout.CENTER)
        }
        val content = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(8, 12, 16, 12)
            add(readOnlyLabel)
            humanLayer.alignmentX = Component.LEFT_ALIGNMENT
            add(humanLayer)
            add(agentToggle)
            add(agentContent)
            add(generatedPanel)
            add(Box.createVerticalGlue().apply { setAlignmentX(Component.LEFT_ALIGNMENT) })
        }
        return JBScrollPane(content).apply {
            border = JBUI.Borders.empty()
            horizontalScrollBarPolicy = JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER
        }
    }

    private fun createFooter(): JPanel = JPanel(BorderLayout()).apply {
        border = BorderFactory.createCompoundBorder(
            JBUI.Borders.customLineTop(JBColor.border()),
            JBUI.Borders.empty(5, 10),
        )
        conflictPanel.apply {
            add(conflictLabel)
            add(reloadButton)
            add(keepButton)
        }
        add(statusLabel, BorderLayout.WEST)
        add(conflictPanel, BorderLayout.CENTER)
    }

    fun showTarget(value: PacmonTarget) {
        if (disposed) return
        flushPending()
        target = value
        nameLabel.text = value.name
        sectionLabel.text = value.section
        loadFromDisk(focusEmpty = true)
    }

    fun externalNotesChanged(paths: Set<String>) {
        if (disposed || writing || target == null) return
        val current = target ?: return
        if (PacmonNotesListener.ORG_NOTES in paths) {
            // An edit in progress stays: only the allowlist block follows, as in VS Code.
            SwingUtilities.invokeLater {
                if (disposed || writing || target == null) return@invokeLater
                if (isDirty()) refreshOrg() else loadFromDisk(focusEmpty = false, forceReset = false)
            }
            return
        }
        // The notes file, or where the first note will be created: in .depos/, or in
        // .pacmon/ in a repository that still keeps its notes there.
        val relevantPath = (notes.resolveNotesFile(current.manifest)?.path ?: notes.creationTargetPath(current.manifest))
            .replace('\\', '/')
        if (relevantPath !in paths) return
        SwingUtilities.invokeLater {
            if (disposed || writing || target == null) return@invokeLater
            if (isDirty()) {
                saveAlarm.cancelAllRequests()
                conflict = true
                showConflict(true)
                statusLabel.text = "Resolve the external change before autosave continues."
            } else {
                loadFromDisk(focusEmpty = false, forceReset = false)
            }
        }
    }

    fun flushPending() {
        if (!disposed && isDirty()) saveNow()
    }

    internal fun setLayersForTest(human: String, agent: String) {
        humanLayer.replaceText(human)
        agentLayer.replaceText(agent)
        onInput()
    }

    internal fun hasConflictForTest(): Boolean = conflict

    internal fun saveForTest() = saveNow()

    private fun loadFromDisk(focusEmpty: Boolean, forceReset: Boolean = true) {
        val current = target ?: return
        saveAlarm.cancelAllRequests()
        val note = notes.noteFor(current.manifest, current.name)
        val loaded = Layers(note?.layers?.human.orEmpty(), note?.layers?.agent.orEmpty())
        baseline = loaded
        humanLayer.load(loaded.human, forceReset)
        agentLayer.load(loaded.agent, forceReset)
        val generated = note?.layers?.generated.orEmpty()
        generatedPreview.text = PacmonMarkdown.render(generated, "")
        generatedPreview.caretPosition = 0
        generatedPanel.isVisible = generated.isNotBlank()
        conflict = false
        showConflict(false)
        statusLabel.text = ""
        refreshOrg()
        validateAgent()
        if (focusEmpty && loaded.human.isBlank() && !readOnly) SwingUtilities.invokeLater(humanLayer::startEditing)
    }

    /**
     * Org mode: where the note comes from, whether the user may change it, and the
     * package's allowlist result. The header button opens the package's page in
     * Depos instead of the notes file, which org mode does not use.
     */
    private fun refreshOrg() {
        val current = target ?: return
        val state = org.notesFor(current.manifest)
        notesPathLabel.text = "->  " + (state?.orgName?.let(DeposStrings::orgNotesLabel)
            ?: notes.notesRelativePathFor(current.manifest))
        readOnly = state != null && !state.canEdit
        humanLayer.setReadOnly(readOnly)
        agentLayer.setReadOnly(readOnly)
        readOnlyLabel.isVisible = readOnly
        val view = org.view(current.manifest, current.name)
        orgBadge.isVisible = view != null
        openFileButton.text = if (view != null) DeposStrings.orgOpenWeb else OPEN_NOTES_FILE
        if (view != null) {
            orgBadge.text = view.result
            orgBadge.tone(
                when (view.kind) {
                    OrgResult.Kind.ALLOWED -> Badge.Tone.GREEN
                    OrgResult.Kind.UNLISTED -> Badge.Tone.YELLOW
                    OrgResult.Kind.DENIED -> Badge.Tone.RED
                },
            )
            // The mode, reason and expiry are the badge's tooltip.
            orgBadge.toolTipText = listOfNotNull(
                DeposStrings.orgAllowlistLine(view.result, view.mode),
                view.reason?.let(DeposStrings::orgReason),
                view.expires?.let(DeposStrings::orgExpires),
            ).joinToString(" · ")
        }
        revalidate()
        repaint()
    }

    private fun onInput() {
        if (disposed || target == null) return
        validateAgent()
        statusLabel.text = "Unsaved changes"
        if (conflict) return
        saveAlarm.cancelAllRequests()
        saveAlarm.addRequest(::saveNow, 600)
    }

    private fun saveNow() {
        val current = target ?: return
        saveAlarm.cancelAllRequests()
        if (!isDirty()) {
            if (conflict) loadFromDisk(focusEmpty = false)
            return
        }
        val before = baseline
        val next = currentLayers()
        if (notes.isOrgMode(current.manifest)) {
            saveToOrg(current, next)
            return
        }
        writing = true
        statusLabel.text = "Saving..."
        try {
            notes.saveNoteLayers(current.manifest, current.name, next.human, next.agent)
            baseline = next
            humanLayer.refreshPreview()
            agentLayer.refreshPreview()
            conflict = false
            showConflict(false)
            statusLabel.text = "Saved ${java.time.LocalTime.now().withNano(0)}"
        } catch (error: RuntimeException) {
            baseline = before
            statusLabel.text = "Could not save: ${error.message ?: "unknown error"}"
        } finally {
            writing = false
        }
    }

    /**
     * Org mode: the note goes to Depos, which is a request, so it leaves the UI
     * thread. A save that is refused keeps the text in the box and says why — a 409
     * also brings the copy up to date, so the next save starts from it.
     */
    private fun saveToOrg(current: PacmonTarget, next: Layers) {
        if (orgSaving) {
            saveAlarm.addRequest(::saveNow, 600)
            return
        }
        orgSaving = true
        writing = true
        statusLabel.text = "Saving..."
        ApplicationManager.getApplication().executeOnPooledThread {
            val outcome = runCatching { org.saveNote(current.manifest, current.name, next.human, next.agent) }
            ApplicationManager.getApplication().invokeLater {
                orgSaving = false
                writing = false
                outcome.onSuccess { dropped ->
                    if (dropped > 0) DeposConnection.notify(project, DeposStrings.orgNoteDropped(dropped), NotificationType.WARNING)
                }
                outcome.onFailure { error ->
                    if (error is DeposException) DeposConnection.notify(project, error.message.orEmpty(), NotificationType.ERROR)
                }
                if (disposed || target != current) return@invokeLater
                outcome.onSuccess {
                    baseline = next
                    humanLayer.refreshPreview()
                    agentLayer.refreshPreview()
                    statusLabel.text = "Saved ${java.time.LocalTime.now().withNano(0)}"
                }
                outcome.onFailure { error ->
                    val message = if (error is DeposException) error.message else null
                    statusLabel.text = "Could not save: ${message ?: DeposStrings.orgNoteSaveFailed}"
                }
            }
        }
    }

    private fun openNotesFile() {
        val current = target ?: return
        flushPending()
        // The link is built here from the local copy, not taken from anything shown.
        val view = org.view(current.manifest, current.name)
        if (view != null) {
            BrowserUtil.browse(view.link)
            return
        }
        if (notes.isOrgMode(current.manifest)) {
            PacmonCommands.openOrgNotes(project, current.manifest)
            return
        }
        val file = notes.resolveNotesFile(current.manifest)
            ?: notes.saveNoteLayers(current.manifest, current.name, humanLayer.text, agentLayer.text)
        notes.open(file)
    }

    private fun validateAgent() {
        val problems = AgentNotes.lint(agentLayer.text)
        problemsPanel.isVisible = problems.isNotEmpty()
        if (problems.isEmpty()) return
        problemsLabel.text = problemsHtml(problems)
        fixButton.isVisible = problems.any(AgentProblem::fixable) && !readOnly
        setAgentExpanded(true)
    }

    private fun problemsHtml(problems: List<AgentProblem>): String = buildString {
        append("<html>")
        append(if (problems.size == 1) "1 problem:<br>" else "${problems.size} problems:<br>")
        problems.forEachIndexed { index, problem ->
            if (index > 0) append("<br>")
            append(escapeHtml(problem.message()))
        }
        append("</html>")
    }

    private fun setAgentExpanded(value: Boolean) {
        agentExpanded = value
        agentToggle.text = if (value) "\u25BE Agent notes" else "\u25B8 Agent notes"
        agentContent.isVisible = value
        revalidate()
        repaint()
    }

    private fun showConflict(value: Boolean) {
        conflictPanel.isVisible = value
        revalidate()
    }

    private fun currentLayers(): Layers = Layers(humanLayer.text.trim(), agentLayer.text.trim())

    private fun isDirty(): Boolean = currentLayers() != Layers(baseline.human.trim(), baseline.agent.trim())

    private fun escapeHtml(value: String): String = value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")

    override fun getMinimumSize(): Dimension = Dimension(260, 200)

    override fun dispose() {
        if (disposed) return
        flushPending()
        disposed = true
        saveAlarm.cancelAllRequests()
    }

    /** A small rounded badge, Depos green (the mark's colors) unless given another [Tone]. */
    private class Badge : JBLabel("") {
        enum class Tone(val background: Color, val foreground: Color) {
            GREEN(JBColor(0x00662F, 0x00FF66), JBColor(0xFFFFFF, 0x0A0A0A)),
            YELLOW(JBColor(0xF2C200, 0xF2C200), JBColor(0x1A1A1A, 0x1A1A1A)),
            RED(JBColor(0xC72E2E, 0xC72E2E), JBColor(0xFFFFFF, 0xFFFFFF)),
        }

        private var badgeBackground: Color = Tone.GREEN.background

        init {
            isOpaque = false
            foreground = Tone.GREEN.foreground
            border = JBUI.Borders.empty(1, 6)
            font = font.deriveFont(font.size2D - 1f)
        }

        fun tone(tone: Tone) {
            badgeBackground = tone.background
            foreground = tone.foreground
            repaint()
        }

        override fun paintComponent(graphics: Graphics) {
            val copy = graphics.create() as Graphics2D
            try {
                copy.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                copy.color = badgeBackground
                val arc = JBUI.scale(5)
                copy.fillRoundRect(0, 0, width, height, arc, arc)
            } finally {
                copy.dispose()
            }
            super.paintComponent(graphics)
        }
    }

    /**
     * Title label beside its action button when there is room for both; the
     * button drops below the title once the tool window gets too narrow to
     * fit a long dependency name and the button side by side — the Swing
     * equivalent of the panel's flex-wrap in the VS Code webview.
     */
    private class ResponsiveHeaderRow(
        private val content: JComponent,
        private val action: JComponent,
    ) : JPanel() {
        private val gap = JBUI.scale(8)

        init {
            isOpaque = false
            layout = null
            add(content)
            add(action)
            addComponentListener(object : java.awt.event.ComponentAdapter() {
                override fun componentResized(event: java.awt.event.ComponentEvent) = revalidate()
            })
        }

        private fun fitsSideBySide(forWidth: Int): Boolean =
            content.preferredSize.width + gap + action.preferredSize.width <= forWidth

        override fun doLayout() {
            val w = width
            val contentSize = content.preferredSize
            val actionSize = action.preferredSize
            if (fitsSideBySide(w)) {
                val rowHeight = maxOf(contentSize.height, actionSize.height)
                val contentWidth = (w - gap - actionSize.width).coerceAtLeast(0)
                content.setBounds(0, (rowHeight - contentSize.height) / 2, contentWidth, contentSize.height)
                action.setBounds(w - actionSize.width, (rowHeight - actionSize.height) / 2, actionSize.width, actionSize.height)
            } else {
                content.setBounds(0, 0, w, contentSize.height)
                action.setBounds(0, contentSize.height + gap, minOf(actionSize.width, w), actionSize.height)
            }
        }

        override fun getPreferredSize(): Dimension {
            val contentSize = content.preferredSize
            val actionSize = action.preferredSize
            val idealWidth = contentSize.width + gap + actionSize.width
            val w = width.takeIf { it > 0 } ?: idealWidth
            return if (fitsSideBySide(w)) {
                Dimension(w, maxOf(contentSize.height, actionSize.height))
            } else {
                Dimension(w, contentSize.height + gap + actionSize.height)
            }
        }
    }
}
