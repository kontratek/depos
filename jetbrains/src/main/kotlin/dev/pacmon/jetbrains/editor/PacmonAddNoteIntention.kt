package dev.pacmon.jetbrains.editor

import com.intellij.codeInsight.intention.IntentionAction
import com.intellij.codeInsight.intention.PriorityAction
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile
import com.intellij.util.IncorrectOperationException
import dev.pacmon.jetbrains.action.NoteEditor
import dev.pacmon.jetbrains.service.PacmonProjectService
import dev.pacmon.jetbrains.settings.NoteButtons

/**
 * The `lightbulb` click target: the quietest of the five. Nothing is drawn in
 * dependency manifests at rest; the note is one Alt+Enter away while the caret sits
 * on a dependency line. The VS Code extension offers the same thing as a code
 * action.
 */
class PacmonAddNoteIntention : IntentionAction, PriorityAction {
    private var text: String = FAMILY

    override fun getFamilyName(): String = FAMILY

    override fun getText(): String = text

    override fun getPriority(): PriorityAction.Priority = PriorityAction.Priority.NORMAL

    override fun startInWriteAction(): Boolean = false

    override fun isAvailable(project: Project, editor: Editor?, file: PsiFile?): Boolean {
        if (editor == null || file == null) return false
        if (!DependencyPsi.isManifest(file)) return false
        val notes = project.getService(PacmonProjectService::class.java)
        if (!notes.noteButtonEnabled(NoteButtons.LIGHTBULB)) return false
        val manifest = file.virtualFile ?: return false
        val dependency = notes.dependencyAt(manifest, editor.caretModel.offset, lineFallback = true) ?: return false
        val documented = notes.noteFor(manifest, dependency.name) != null
        text = if (documented) {
            "Edit the Depos note for ${dependency.name}"
        } else {
            "Add a Depos note for ${dependency.name}"
        }
        return true
    }

    @Throws(IncorrectOperationException::class)
    override fun invoke(project: Project, editor: Editor?, file: PsiFile?) {
        if (editor == null || file == null) return
        val manifest = file.virtualFile ?: return
        val dependency = project.getService(PacmonProjectService::class.java)
            .dependencyAt(manifest, editor.caretModel.offset, lineFallback = true) ?: return
        NoteEditor.open(project, dependency, editor)
    }

    private companion object {
        /**
         * The name from before Pacmon became Depos, kept: the IDE remembers an
         * intention someone turned off by its family name.
         */
        const val FAMILY = "Add/edit the Pacmon dependency note"
    }
}
