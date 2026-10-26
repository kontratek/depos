package dev.pacmon.jetbrains.editor

import com.intellij.codeInsight.hints.ChangeListener
import com.intellij.codeInsight.hints.FactoryInlayHintsCollector
import com.intellij.codeInsight.hints.ImmediateConfigurable
import com.intellij.codeInsight.hints.InlayHintsCollector
import com.intellij.codeInsight.hints.InlayHintsProvider
import com.intellij.codeInsight.hints.InlayHintsSink
import com.intellij.codeInsight.hints.InlayPresentationFactory
import com.intellij.codeInsight.hints.NoSettings
import com.intellij.codeInsight.hints.SettingsKey
import com.intellij.codeInsight.hints.presentation.InlayPresentation
import com.intellij.openapi.editor.Editor
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import dev.pacmon.jetbrains.action.NoteEditor
import dev.pacmon.jetbrains.service.PacmonProjectService
import dev.pacmon.jetbrains.settings.NoteButtons
import java.awt.Cursor
import java.awt.Point
import java.awt.event.MouseEvent
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Three of the five click targets the Depos tool window offers, all of them
 * inlays: the mark at the dependency's manifest-specific anchor (`iconLeft`), the clickable line
 * above the dependency (`codelens`) and the words at the end of the line
 * (`inlayHint`). The other two are not inlays — `link` is a go-to-declaration
 * target in [PacmonNoteDeclarationHandler] and `lightbulb` an intention in
 * [PacmonAddNoteIntention].
 *
 * Each one is drawn only while its box is ticked, and the provider steps aside
 * entirely when none of the three is.
 */
class PacmonInlayHintsProvider : InlayHintsProvider<NoSettings> {
    override val key = SettingsKey<NoSettings>("pacmon.dependency.icons")

    override val name: String = "Depos dependency notes"

    override val previewText: String = """{ "dependencies": { "vue": "^3" } }"""

    override fun createSettings(): NoSettings = NoSettings()

    override fun createConfigurable(settings: NoSettings): ImmediateConfigurable = object : ImmediateConfigurable {
        override fun createComponent(listener: ChangeListener): JComponent = JPanel()
    }

    override fun getCollectorFor(
        file: PsiFile,
        editor: Editor,
        settings: NoSettings,
        sink: InlayHintsSink,
    ): InlayHintsCollector? {
        if (!DependencyPsi.isManifest(file)) return null
        val manifest = file.virtualFile ?: return null
        val notes = file.project.getService(PacmonProjectService::class.java)
        val icon = notes.noteButtonEnabled(NoteButtons.ICON_LEFT)
        val lens = notes.noteButtonEnabled(NoteButtons.CODE_LENS)
        val chip = notes.noteButtonEnabled(NoteButtons.INLAY_HINT)
        if (!icon && !lens && !chip) return null
        val dependencies = notes.dependencies(manifest)

        return object : FactoryInlayHintsCollector(editor) {
            override fun collect(element: PsiElement, editor: Editor, sink: InlayHintsSink): Boolean {
                if (element != file) return true
                for (dependency in dependencies) {
                    val documented = notes.noteFor(manifest, dependency.name) != null
                    val words = if (documented) "Edit note" else "Add note"
                    val open = { NoteEditor.open(file.project, dependency, editor) }
                    val nameStart = dependency.primaryRange.offset
                    val iconStart = dependency.iconRange.offset

                    if (icon) {
                        sink.addInlineElement(
                            iconStart,
                            false,
                            clickable(factory.smallScaledIcon(PacmonIcons.forNote(documented)), open),
                            false,
                        )
                    }
                    if (lens) {
                        val document = editor.document
                        val column = nameStart - document.getLineStartOffset(document.getLineNumber(nameStart))
                        sink.addBlockElement(
                            nameStart,
                            true,
                            true,
                            BLOCK_PRIORITY,
                            factory.seq(
                                factory.textSpacePlaceholder(column, true),
                                clickable(factory.smallText(words), open),
                            ),
                        )
                    }
                    if (chip) {
                        val lineEnd = editor.document.getLineEndOffset(editor.document.getLineNumber(nameStart))
                        sink.addInlineElement(
                            lineEnd,
                            true,
                            clickable(factory.roundWithBackground(factory.smallText(words)), open),
                            true,
                        )
                    }
                }
                return false
            }

            /** A hand cursor and a plain click — no modifier, unlike VS Code's inlay hints. */
            private fun clickable(presentation: InlayPresentation, onClick: () -> Unit): InlayPresentation =
                factory.withCursorOnHover(
                    factory.mouseHandling(
                        presentation,
                        object : InlayPresentationFactory.ClickListener {
                            override fun onClick(event: MouseEvent, translated: Point) = onClick()
                        },
                        null,
                    ),
                    Cursor.getPredefinedCursor(Cursor.HAND_CURSOR),
                )
        }
    }

    private companion object {
        const val BLOCK_PRIORITY = 0
    }
}
