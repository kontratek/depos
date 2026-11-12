package dev.pacmon.jetbrains.editor

import com.intellij.openapi.editor.EditorLinePainter
import com.intellij.openapi.editor.LineExtensionInfo
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.JBColor
import dev.pacmon.jetbrains.core.NotesCore
import dev.pacmon.jetbrains.service.PacmonProjectService
import dev.pacmon.jetbrains.service.blockingRead
import dev.pacmon.jetbrains.settings.Decorations
import java.awt.Font

class PacmonLinePainter : EditorLinePainter() {
    override fun getLineExtensions(
        project: Project,
        file: VirtualFile,
        lineNumber: Int,
    ): Collection<LineExtensionInfo> {
        if (!DependencyPsi.isManifest(file)) return emptyList()
        return blockingRead {
            val document = FileDocumentManager.getInstance().getDocument(file) ?: return@blockingRead emptyList()
            val service = project.getService(PacmonProjectService::class.java)
            val dependency = service.dependencies(file).firstOrNull {
                document.getLineNumber(it.primaryRange.offset) == lineNumber
            } ?: return@blockingRead emptyList()
            val decorations = service.decorations()
            if (decorations == Decorations.OFF) return@blockingRead emptyList()
            val note = service.noteFor(file, dependency.name) ?: return@blockingRead emptyList()
            // "badge" says a note exists and nothing more, for people who want
            // the hint without the prose. The word carries it rather than the
            // marker alone, which on its own reads as a stray character \u2014 the
            // VS Code extension writes the same "\u25AA note".
            val text = if (decorations == Decorations.BADGE) {
                "   \u25AA note"
            } else {
                "   \u25AA ${NotesCore.preview(note.layers, service.inlineSource())}"
            }
            val color = JBColor.namedColor(
                "Label.disabledForeground",
                JBColor(0x6F737A, 0xA0A0A0),
            )
            listOf(LineExtensionInfo(text, color, null, null, Font.ITALIC))
        }
    }
}
