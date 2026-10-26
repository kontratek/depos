package dev.pacmon.jetbrains.editor

import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.testFramework.fixtures.BasePlatformTestCase

/**
 * The warnings a notes file gets must be real IDE warnings, produced by the
 * daemon: `doHighlighting()` sees exactly what the editor shows.
 */
class PacmonNotesAnnotatorTest : BasePlatformTestCase() {
    private fun highlight(
        notes: String,
        packageJson: String? = null,
        path: String = ".depos/DEPENDENCY-NOTES.md",
    ): List<Pair<String, String>> {
        if (packageJson != null) myFixture.addFileToProject("package.json", packageJson)
        val file = myFixture.addFileToProject(path, notes)
        myFixture.configureFromExistingVirtualFile(file.virtualFile)
        return myFixture.doHighlighting(HighlightSeverity.WARNING)
            .map { myFixture.editor.document.text.substring(it.startOffset, it.endOffset) to it.description.orEmpty() }
    }

    private val deps = """{ "dependencies": { "express": "^4.18.2" } }"""

    fun testWarnsWhenTheFrontmatterIsGone() {
        val warnings = highlight("# Dependency Notes\n\n## express\n\nWhy we use it.\n", deps)
        assertTrue(
            warnings.toString(),
            warnings.any { it.second == "No frontmatter — \"Format DEPENDENCY-NOTES.md\" adds it." },
        )
    }

    /** The underline is not the whole of it: the message has to be on hover too. */
    fun testEveryWarningCarriesItsMessageAsATooltip() {
        myFixture.addFileToProject("package.json", deps)
        val file = myFixture.addFileToProject(
            ".depos/DEPENDENCY-NOTES.md",
            "# Dependency Notes\n\n##express\n\nWhy we use it.\n",
        )
        myFixture.configureFromExistingVirtualFile(file.virtualFile)
        val infos = myFixture.doHighlighting(HighlightSeverity.WARNING)
        assertFalse(infos.isEmpty())
        infos.forEach { info ->
            assertNotNull("no tooltip on: ${info.description}", info.toolTip)
            assertEquals(HighlightSeverity.WARNING, info.severity)
        }
    }

    /**
     * Deleting the frontmatter block leaves the blank line that followed it, so
     * the finding's own line has nothing to underline. It has to move down to
     * real text — otherwise the warning reaches Problems and the editor shows
     * nothing at all.
     */
    fun testAWholeLineWarningOnABlankLineMovesToTheFirstLineWithText() {
        val warnings = highlight(
            "\n<!-- header comment -->\n\n# Dependency Notes\n\n## express\n\nWhy we use it.\n",
            deps,
        )
        val found = warnings.firstOrNull { it.second.startsWith("No frontmatter") }
        assertNotNull(warnings.toString(), found)
        assertEquals("<!-- header comment -->", found?.first)
    }

    fun testAWholeLineWarningUnderlinesTheTextOnlyNotTheIndent() {
        val warnings = highlight("\n  <!-- header comment -->\n\n# Dependency Notes\n", deps)
        val found = warnings.firstOrNull { it.second.startsWith("No frontmatter") }
        assertNotNull(warnings.toString(), found)
        assertEquals("<!-- header comment -->", found?.first)
    }

    fun testWarnsOnADependencyHeadingWithNoSpaceAfterTheHashes() {
        val warnings = highlight(
            "---\nformat: dependency-notes/1\nlang: en\n---\n\n# Dependency Notes\n\n##express\n\nWhy we use it.\n",
            deps,
        )
        val found = warnings.firstOrNull { it.second == "Missing space: write \"## express\"." }
        assertNotNull(warnings.toString(), found)
        assertEquals("##express", found?.first)
    }

    fun testWarnsOnADependencyHeadingAtTheWrongLevel() {
        val warnings = highlight(
            "---\nformat: dependency-notes/1\nlang: en\n---\n\n# Dependency Notes\n\n### express\n\nWhy we use it.\n",
            deps,
        )
        assertTrue(
            warnings.toString(),
            warnings.any { it.second == "\"express\" is a dependency — write \"## express\" so tools find this note." },
        )
    }

    fun testUnderlinesOnlyTheKeyOfAnUnknownAgentField() {
        val warnings = highlight(
            """
            ---
            format: dependency-notes/1
            lang: en
            ---

            # Dependency Notes

            ## express

            Why we use it.

            ### Agent notes

            - contraint: pinned for the router rewrite
            """.trimIndent() + "\n",
            deps,
        )
        val found = warnings.firstOrNull { it.second.startsWith("Unknown field \"contraint:\"") }
        assertNotNull(warnings.toString(), found)
        assertEquals("contraint", found?.first)
    }

    fun testACanonicalFileGetsNoWarnings() {
        val warnings = highlight(
            """
            ---
            format: dependency-notes/1
            lang: en
            ---

            <!-- Each "## name" below is a package from package.json. The text right under the
              heading is written by people. "### Agent notes" and everything below it is written
              by AI agents — rules in .depos/AGENT-RULES.md. -->

            # Dependency Notes

            ## express

            Why we use it.

            ### Agent notes

            - purpose: HTTP routing
            - runtime: server
            """.trimIndent() + "\n",
            deps,
        )
        assertEmpty(warnings)
    }

    /** From before Pacmon became Depos: still read, and linted like any other, with nothing said about where it is. */
    fun testACanonicalFileUnderPacmonGetsNoWarnings() {
        val warnings = highlight(
            """
            ---
            format: dependency-notes/1
            lang: en
            ---

            <!-- Each "## name" below is a package from package.json. The text right under the
              heading is written by people. "### Agent notes" and everything below it is written
              by AI agents — rules in .pacmon/AGENT-RULES.md. -->

            # Dependency Notes

            ## express

            Why we use it.
            """.trimIndent() + "\n",
            deps,
            path = ".pacmon/DEPENDENCY-NOTES.md",
        )
        assertEmpty(warnings)
    }

    /** A .pacmon/ file with a .depos/ one beside it is never read: its first line with text says so. */
    fun testAPacmonFileWithADeposFileBesideItIsMarkedAsIgnored() {
        myFixture.addFileToProject(".depos/DEPENDENCY-NOTES.md", "# Dependency Notes\n\n## express\n\nRead.\n")
        val warnings = highlight(
            "\n# Dependency Notes\n\n## express\n\nNot read.\n",
            deps,
            path = ".pacmon/DEPENDENCY-NOTES.md",
        )
        val found = warnings.firstOrNull { it.second.startsWith("Ignored:") }
        assertNotNull(warnings.toString(), found)
        assertEquals(
            "Ignored: .depos/DEPENDENCY-NOTES.md is read instead of this file. Move what is still needed there, " +
                "then delete this file.",
            found?.second,
        )
        assertEquals("# Dependency Notes", found?.first)
    }

    fun testTheDeposFileItselfIsNotMarkedAsIgnored() {
        myFixture.addFileToProject(".pacmon/DEPENDENCY-NOTES.md", "# Dependency Notes\n\n## express\n\nNot read.\n")
        val warnings = highlight("# Dependency Notes\n\n## express\n\nRead.\n", deps)
        assertFalse(warnings.toString(), warnings.any { it.second.startsWith("Ignored:") })
    }
}
