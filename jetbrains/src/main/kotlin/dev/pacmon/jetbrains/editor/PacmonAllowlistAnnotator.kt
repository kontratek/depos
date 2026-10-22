package dev.pacmon.jetbrains.editor

import com.intellij.lang.annotation.AnnotationHolder
import com.intellij.lang.annotation.Annotator
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.util.TextRange
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import dev.pacmon.jetbrains.core.ManifestRegistry
import dev.pacmon.jetbrains.depos.DeposStrings
import dev.pacmon.jetbrains.depos.OrgContext
import dev.pacmon.jetbrains.depos.OrgResult
import dev.pacmon.jetbrains.depos.PolicyMode
import dev.pacmon.jetbrains.service.PacmonProjectService

/**
 * The organization's allowlist at the manifest line, in org mode: a Denied or Not
 * listed package is a warning in an ecosystem set to Audit and an error in one set
 * to Enforce — what the VS Code extension's `orgDiagnostics.ts` puts in Problems.
 * Allowed packages stay quiet, and an ecosystem Depos does not audit shows nothing.
 *
 * The result is looked up in the local copy of the allowlist, so a line just typed
 * is judged at once, before it is pushed. Registered for every manifest language,
 * like the quick documentation; it runs once per file, on the file element.
 */
class PacmonAllowlistAnnotator : Annotator {
    override fun annotate(element: PsiElement, holder: AnnotationHolder) {
        val file = element as? PsiFile ?: return
        val manifest = file.virtualFile ?: file.originalFile.virtualFile ?: return
        if (ManifestRegistry.forPath(manifest.path) == null) return
        val org = OrgContext.getInstance(file.project)
        val service = file.project.getService(PacmonProjectService::class.java)
        val end = file.textLength
        for (dependency in service.dependencies(manifest)) {
            val (result, orgName) = org.allowlist(manifest, dependency.name) ?: continue
            if (!result.isViolation) continue
            val name = dependency.displayName
            val message = if (result.kind == OrgResult.Kind.DENIED) {
                DeposStrings.orgDenied(name, orgName, result.reason)
            } else {
                DeposStrings.orgUnlisted(name, orgName)
            }
            val severity = if (result.mode == PolicyMode.ENFORCE) HighlightSeverity.ERROR else HighlightSeverity.WARNING
            val start = dependency.primaryRange.offset.coerceIn(0, end)
            val stop = (dependency.primaryRange.offset + dependency.primaryRange.length).coerceIn(start, end)
            if (start == stop) continue
            holder.newAnnotation(severity, message).range(TextRange(start, stop)).create()
        }
    }
}
