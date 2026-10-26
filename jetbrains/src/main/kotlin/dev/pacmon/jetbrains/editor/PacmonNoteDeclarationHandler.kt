package dev.pacmon.jetbrains.editor

import com.intellij.codeInsight.navigation.actions.GotoDeclarationHandler
import com.intellij.openapi.editor.Editor
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.psi.impl.FakePsiElement
import dev.pacmon.jetbrains.action.NoteEditor
import dev.pacmon.jetbrains.service.PacmonProjectService
import dev.pacmon.jetbrains.settings.NoteButtons

/**
 * The `link` click target: Ctrl+click (Cmd+click) the package name in
 * a dependency manifest and its note opens. The counterpart of the VS Code
 * extension's document link, and like it, it adds nothing to the file —
 * the name is already there, and only the tooltip tells a documented
 * dependency from an undocumented one.
 *
 * Go-to-declaration wants a PSI element, and a note is not one, so the
 * target is a [FakePsiElement] whose only job is to open the editor when
 * the platform navigates to it.
 */
class PacmonNoteDeclarationHandler : GotoDeclarationHandler {
    override fun getGotoDeclarationTargets(
        sourceElement: PsiElement?,
        offset: Int,
        editor: Editor?,
    ): Array<PsiElement>? {
        val element = sourceElement ?: return null
        // Plain-text manifests (including mix.exs when no Elixir plugin is
        // installed) may hand the file itself to the declaration handler.
        val file = (element as? PsiFile) ?: element.containingFile ?: return null
        if (!DependencyPsi.isManifest(file)) return null
        val project = element.project
        val service = project.getService(PacmonProjectService::class.java)
        if (!service.noteButtonEnabled(NoteButtons.LINK)) return null
        val manifest = file.virtualFile ?: return null
        val dependency = service.dependencyAt(manifest, offset) ?: return null
        // Only the name half of `"express": "^4"`, so Ctrl+click on the version
        // range is left to whatever else claims it.
        if (dependency.sourceRanges.none { it.contains(offset) }) return null
        return arrayOf(NoteTarget(dependency, element, editor))
    }

    private class NoteTarget(
        private val dependency: DependencyRef,
        private val source: PsiElement,
        private val editor: Editor?,
    ) : FakePsiElement() {
        override fun getParent(): PsiElement = source

        /**
         * Go-to-declaration moves the caret, rather than navigating, when the
         * target claims to live in the file you are already looking at — and
         * moving the caret onto the package name you just clicked is nothing
         * at all. So this target claims no file and is followed as a plain
         * [com.intellij.pom.Navigatable] instead.
         */
        override fun getContainingFile(): PsiFile? = null

        override fun getName(): String = dependency.name

        override fun getPresentableText(): String = "Depos note for ${dependency.name}"

        override fun canNavigate(): Boolean = true

        override fun canNavigateToSource(): Boolean = false

        override fun navigate(requestFocus: Boolean) {
            NoteEditor.open(source.project, dependency, editor)
        }
    }
}
