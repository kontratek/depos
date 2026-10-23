package dev.pacmon.jetbrains.ui

import com.intellij.icons.AllIcons
import com.intellij.ui.IdeBorderFactory
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.CardLayout
import java.awt.Component
import java.awt.Cursor
import java.awt.Dimension
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import java.awt.event.FocusAdapter
import java.awt.event.FocusEvent
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.AbstractAction
import javax.swing.JComponent
import javax.swing.JEditorPane
import javax.swing.JPanel
import javax.swing.KeyStroke
import javax.swing.SwingConstants
import javax.swing.event.DocumentEvent
import javax.swing.event.DocumentListener

class NoteLayerPanel(
    caption: String?,
    private val emptyText: String,
    private val onChanged: () -> Unit,
    private val onCommit: () -> Unit,
) : JPanel(BorderLayout()) {
    private val cards = CardLayout()
    private val cardPanel = object : JPanel(cards) {
        // CardLayout normally sizes for the largest of ALL cards; we want only
        // the currently visible one, so a short preview never reserves the
        // taller editor's space (or vice versa).
        override fun getPreferredSize(): Dimension =
            components.firstOrNull { it.isVisible }?.preferredSize ?: super.getPreferredSize()
    }
    private val hoverBackground = JBColor.namedColor("List.hoverBackground", JBColor(0xE8E8E8, 0x4B4B4B))
    private val preview = JEditorPane("text/html", "").apply {
        isEditable = false
        isOpaque = false
        cursor = Cursor.getPredefinedCursor(Cursor.TEXT_CURSOR)
        putClientProperty(JEditorPane.HONOR_DISPLAY_PROPERTIES, true)
        border = JBUI.Borders.empty(6, 8)
        addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(event: MouseEvent) = startEditing()
            override fun mouseEntered(event: MouseEvent) {
                isOpaque = true
                background = hoverBackground
                repaint()
            }
            override fun mouseExited(event: MouseEvent) {
                isOpaque = false
                repaint()
            }
        })
    }
    private val editor = JBTextArea(9, 36).apply {
        lineWrap = true
        wrapStyleWord = true
        border = JBUI.Borders.empty(6, 8)
    }
    private val previewScroll = JBScrollPane(preview).apply {
        border = JBUI.Borders.empty()
        isOpaque = false
        viewport.isOpaque = false
        verticalScrollBarPolicy = JBScrollPane.VERTICAL_SCROLLBAR_NEVER
        horizontalScrollBarPolicy = JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER
    }
    private val editorScroll = JBScrollPane(editor).apply {
        border = IdeBorderFactory.createRoundedBorder()
        horizontalScrollBarPolicy = JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER
    }
    private var loading = false
    /** Org mode for a member who is not an admin: the note shows, but does not open for writing. */
    private var readOnly = false
    /** True while the user is actively writing; guards against a background
     *  refresh (an autosave echo, or another process editing the same file)
     *  from pulling the box out from under them mid-sentence. */
    private var editing = false

    init {
        border = JBUI.Borders.empty(4, 0, 8, 0)
        if (caption != null) {
            add(JBLabel(caption, AllIcons.Actions.Edit, SwingConstants.LEFT).apply {
                border = JBUI.Borders.emptyBottom(4)
                font = font.deriveFont(font.style or java.awt.Font.BOLD)
                foreground = JBColor.namedColor(
                    "Label.disabledForeground",
                    JBColor(0x6F737A, 0xA0A0A0),
                )
                horizontalTextPosition = SwingConstants.LEFT
                iconTextGap = JBUI.scale(6)
                toolTipText = "Click to edit"
                addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(event: MouseEvent) = startEditing()
                })
            }, BorderLayout.NORTH)
        }

        cardPanel.add(previewScroll, "preview")
        cardPanel.add(editorScroll, "editor")
        add(cardPanel, BorderLayout.CENTER)

        editor.document.addDocumentListener(object : DocumentListener {
            override fun insertUpdate(event: DocumentEvent) = changed()
            override fun removeUpdate(event: DocumentEvent) = changed()
            override fun changedUpdate(event: DocumentEvent) = changed()
            private fun changed() {
                resizeEditorToContent()
                if (!loading) onChanged()
            }
        })
        editor.addFocusListener(object : FocusAdapter() {
            override fun focusLost(event: FocusEvent) = finishEditing()
        })
        addComponentListener(object : ComponentAdapter() {
            override fun componentResized(event: ComponentEvent) {
                resizeEditorToContent()
                resizePreviewToContent()
            }
        })
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_ESCAPE, 0), "pacmon.finish") { finishEditing() }
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_S, KeyEvent.CTRL_DOWN_MASK), "pacmon.save.ctrl") { onCommit() }
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_S, KeyEvent.META_DOWN_MASK), "pacmon.save.meta") { onCommit() }
    }

    override fun getAlignmentX(): Float = Component.LEFT_ALIGNMENT

    override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, preferredSize.height)

    val text: String
        get() = editor.text

    /**
     * Loads [value] into the box. A background refresh ([forceReset] = false —
     * an autosave echo or an external writer touching the same file) leaves an
     * in-progress edit alone, matching the VS Code panel: whatever is still
     * being typed stays, only a box at rest takes the freshly read text.
     */
    fun load(value: String, forceReset: Boolean = true) {
        if (editing && !forceReset) {
            refreshPreview()
            return
        }
        loading = true
        editor.text = value
        loading = false
        refreshPreview()
        resizeEditorToContent()
        cards.show(cardPanel, "preview")
    }

    fun replaceText(value: String) {
        loading = true
        editor.text = value
        loading = false
        refreshPreview()
        resizeEditorToContent()
    }

    fun refreshPreview() {
        preview.text = PacmonMarkdown.render(editor.text, emptyText)
        preview.caretPosition = 0
        resizePreviewToContent()
    }

    fun setReadOnly(value: Boolean) {
        readOnly = value
        editor.isEditable = !value
        if (value && editing) {
            editing = false
            refreshPreview()
            cards.show(cardPanel, "preview")
        }
    }

    fun startEditing() {
        if (readOnly) return
        editing = true
        cards.show(cardPanel, "editor")
        resizeEditorToContent()
        editor.requestFocusInWindow()
        editor.caretPosition = editor.document.length
    }

    private fun finishEditing() {
        if (readOnly) return
        editing = false
        refreshPreview()
        cards.show(cardPanel, "preview")
        onCommit()
    }

    private fun bind(key: KeyStroke, name: String, action: () -> Unit) {
        editor.getInputMap(JComponent.WHEN_FOCUSED).put(key, name)
        editor.actionMap.put(name, object : AbstractAction() {
            override fun actionPerformed(event: java.awt.event.ActionEvent) = action()
        })
    }

    private fun minLines() = 9

    private fun maxEditorHeight() = JBUI.scale(320)

    /** Grows the editor with its content, like a textarea with `max-height` —
     *  a floor of nine lines, then it scrolls past roughly the same cap the
     *  VS Code panel uses (40% of a typical viewport). */
    private fun resizeEditorToContent() {
        val width = editorScroll.viewport.width
        if (width <= 0) return
        val insets = editor.insets
        val lineHeight = editor.getFontMetrics(editor.font).height
        val minHeight = lineHeight * minLines() + insets.top + insets.bottom
        editor.setSize(width, Short.MAX_VALUE.toInt())
        val natural = editor.preferredSize.height
        val height = natural.coerceIn(minHeight, maxEditorHeight())
        editorScroll.verticalScrollBarPolicy = if (natural > maxEditorHeight()) {
            JBScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED
        } else {
            JBScrollPane.VERTICAL_SCROLLBAR_NEVER
        }
        editorScroll.preferredSize = Dimension(Int.MAX_VALUE, height)
        revalidate()
    }

    /** The read-only view has no cap of its own — like VS Code's `.view`, it
     *  grows to fit and lets the surrounding page scroll instead. */
    private fun resizePreviewToContent() {
        val width = previewScroll.viewport.width
        if (width <= 0) return
        val insets = preview.insets
        val lineHeight = preview.getFontMetrics(preview.font).height
        val minHeight = lineHeight * minLines() + insets.top + insets.bottom
        preview.setSize(width, Short.MAX_VALUE.toInt())
        val natural = preview.preferredSize.height
        previewScroll.preferredSize = Dimension(Int.MAX_VALUE, natural.coerceAtLeast(minHeight))
        revalidate()
    }
}
