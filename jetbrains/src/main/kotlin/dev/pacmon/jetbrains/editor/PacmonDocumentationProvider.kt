package dev.pacmon.jetbrains.editor

import com.intellij.lang.documentation.AbstractDocumentationProvider
import com.intellij.lang.documentation.DocumentationMarkup
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.util.TextRange
import com.intellij.openapi.util.text.StringUtil
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.impl.FakePsiElement
import dev.pacmon.jetbrains.core.NotesCore
import dev.pacmon.jetbrains.depos.DeposStrings
import dev.pacmon.jetbrains.depos.OrgContext
import dev.pacmon.jetbrains.service.PacmonProjectService

class PacmonDocumentationProvider : AbstractDocumentationProvider() {
    override fun getCustomDocumentationElement(
        editor: Editor,
        file: PsiFile,
        contextElement: PsiElement?,
        targetOffset: Int,
    ): PsiElement? {
        val manifest = file.virtualFile ?: return null
        val service = file.project.getService(PacmonProjectService::class.java)
        val dependency = service.dependencyAt(manifest, targetOffset) ?: return null
        val element = file.findElementAt(dependency.primaryRange.offset)
        if (element != null && element.textRange.startOffset == dependency.primaryRange.offset) return element
        return DocumentationTarget(file, dependency)
    }

    override fun generateDoc(element: PsiElement, originalElement: PsiElement?): String? = documentation(element)

    override fun generateHoverDoc(element: PsiElement, originalElement: PsiElement?): String? = documentation(element)

    private fun documentation(element: PsiElement): String? {
        val manifest = element.containingFile?.virtualFile ?: return null
        val service = element.project.getService(PacmonProjectService::class.java)
        val dependency = service.dependencyAt(manifest, element.textRange.startOffset) ?: return null
        val note = service.noteFor(manifest, dependency.name)
        val layers = note?.let { NotesCore.orderedLayers(it.layers, service.inlineSource()) }.orEmpty()
        // In org mode the allowlist result shows even on a line with no note.
        val org = OrgContext.getInstance(element.project).view(manifest, dependency.name)
        if (layers.isEmpty() && org == null) return null

        return buildString {
            append(DocumentationMarkup.DEFINITION_START)
            append(StringUtil.escapeXmlEntities(dependency.name))
            append(DocumentationMarkup.DEFINITION_END)
            if (layers.isNotEmpty()) {
                append(DocumentationMarkup.CONTENT_START)
                append(layers.joinToString("<hr>") { markdownAsSafeHtml(it) })
                append(DocumentationMarkup.CONTENT_END)
            }
            append(DocumentationMarkup.SECTIONS_START)
            if (org != null) {
                section("Allowlist", buildString {
                    append(StringUtil.escapeXmlEntities(org.line()))
                    append("<br><a href=\"").append(StringUtil.escapeXmlEntities(org.link)).append("\">")
                    append(DeposStrings.orgOpenWeb).append("</a> · ")
                    append(StringUtil.escapeXmlEntities(org.received))
                })
            }
            if (note != null && layers.isNotEmpty()) {
                val source = note.orgName?.let(DeposStrings::orgNotesLabel)
                    ?: service.notesRelativePathFor(manifest)
                section("Source", StringUtil.escapeXmlEntities(source))
            }
            append(DocumentationMarkup.SECTIONS_END)
        }
    }

    private fun StringBuilder.section(header: String, html: String) {
        append(DocumentationMarkup.SECTION_HEADER_START)
        append(header)
        append(DocumentationMarkup.SECTION_SEPARATOR)
        append(html)
        append(DocumentationMarkup.SECTION_END)
    }

    private fun markdownAsSafeHtml(markdown: String): String = markdown
        .lineSequence()
        .joinToString("<br>") { StringUtil.escapeXmlEntities(it) }

    /** Plain-text PSI can represent the whole manifest as one element, losing the hovered offset. */
    private class DocumentationTarget(
        private val source: PsiFile,
        private val dependency: DependencyRef,
    ) : FakePsiElement() {
        override fun getParent(): PsiElement = source

        override fun getContainingFile(): PsiFile = source

        override fun getName(): String = dependency.name

        override fun getTextRange(): TextRange = TextRange(
            dependency.primaryRange.offset,
            dependency.primaryRange.offset + dependency.primaryRange.length,
        )
    }
}
