package dev.pacmon.jetbrains.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotesCoreTest {
    @Test
    fun `creates ecosystem scoped v2 files while npm stays v1`() {
        val npm = NotesCore.newNotesFile("Vue", "Frontend")
        val cargo = NotesCore.newNotesFile("Serde", "Serialization", ecosystem = ManifestKind.CARGO)
        val maven = NotesCore.newNotesFile("Org.Example:Core", "Library", ecosystem = ManifestKind.MAVEN)
        val gradle = NotesCore.newNotesFile("org.slf4j:slf4j-api", "Logging", ecosystem = ManifestKind.GRADLE)
        val mix = NotesCore.newNotesFile("phoenix", "Framework", ecosystem = ManifestKind.MIX)
        val gleam = NotesCore.newNotesFile("gleam_stdlib", "Standard library", ecosystem = ManifestKind.GLEAM)
        val zig = NotesCore.newNotesFile("Known_Folders", "Filesystem paths", ecosystem = ManifestKind.ZIG)
        val python = NotesCore.newNotesFile("requests", "HTTP client", ecosystem = ManifestKind.PYTHON)
        val ruby = NotesCore.newNotesFile("rack", "Web server interface", ecosystem = ManifestKind.RUBY)
        val composer = NotesCore.newNotesFile("monolog/monolog", "Structured logging", ecosystem = ManifestKind.COMPOSER)
        val nuget = NotesCore.newNotesFile("Newtonsoft.Json", "JSON serialization", ecosystem = ManifestKind.NUGET)
        val vcpkg = NotesCore.newNotesFile("fmt", "Formatting", ecosystem = ManifestKind.VCPKG)
        val conan = NotesCore.newNotesFile("zlib", "Compression", ecosystem = ManifestKind.CONAN)
        val go = NotesCore.newNotesFile("github.com/Masterminds/semver/v3", "Version ranges", ecosystem = ManifestKind.GO)

        assertTrue(npm.contains("format: dependency-notes/1"))
        assertTrue(cargo.contains("format: dependency-notes/2\necosystem: cargo\nlang: en"))
        assertTrue(maven.contains("format: dependency-notes/2\necosystem: maven\nlang: en"))
        assertTrue(gradle.contains("format: dependency-notes/2\necosystem: gradle\nlang: en"))
        assertTrue(mix.contains("format: dependency-notes/2\necosystem: mix\nlang: en"))
        assertTrue(gleam.contains("format: dependency-notes/2\necosystem: gleam\nlang: en"))
        assertTrue(zig.contains("format: dependency-notes/2\necosystem: zig\nlang: en"))
        assertTrue(python.contains("format: dependency-notes/2\necosystem: python\nlang: en"))
        assertTrue(ruby.contains("format: dependency-notes/2\necosystem: ruby\nlang: en"))
        assertTrue(nuget.contains("format: dependency-notes/2\necosystem: nuget\nlang: en"))
        assertTrue(go.contains("format: dependency-notes/2\necosystem: go\nlang: en"))
        assertTrue(vcpkg.contains("format: dependency-notes/2\necosystem: vcpkg\nlang: en"))
        assertTrue(vcpkg.contains("package from the vcpkg dependency manifest"))
        assertTrue(conan.contains("format: dependency-notes/2\necosystem: conan\nlang: en"))
        assertTrue(conan.contains("package from the conan dependency manifest"))
        assertTrue(go.contains("package from the go dependency manifest"))
        assertTrue(ruby.contains("package from the ruby dependency manifest"))
        assertTrue(composer.contains("package from the composer dependency manifest"))
        assertNull(NotesCore.findSection(NotesCore.parse(go), "github.com/masterminds/semver/v3"))
        assertEquals(
            "github.com/Masterminds/semver/v3",
            NotesCore.findSection(NotesCore.parse(go), "github.com/Masterminds/semver/v3")?.name,
        )
        assertTrue(zig.contains("package from the zig dependency manifest"))
        assertTrue(gleam.contains("package from the gleam dependency manifest"))
        assertNull(NotesCore.findSection(NotesCore.parse(gleam), "GLEAM_STDLIB"))
        assertEquals("gleam_stdlib", NotesCore.findSection(NotesCore.parse(gleam), "gleam_stdlib")?.name)
        assertNull(NotesCore.findSection(NotesCore.parse(cargo), "serde"))
        assertEquals("Serde", NotesCore.findSection(NotesCore.parse(cargo), "Serde")?.name)
        assertNull(NotesCore.findSection(NotesCore.parse(zig), "known_folders"))
        assertEquals("Known_Folders", NotesCore.findSection(NotesCore.parse(zig), "Known_Folders")?.name)
        val pythonNames = NotesCore.newNotesFile("Importlib_Metadata", "Backport", ecosystem = ManifestKind.PYTHON)
        assertEquals("Importlib_Metadata", NotesCore.findSection(NotesCore.parse(pythonNames), "importlib-metadata")?.name)
        assertEquals("Vue", NotesCore.findSection(NotesCore.parse(npm), "vue")?.name)
        assertEquals("Newtonsoft.Json", NotesCore.findSection(NotesCore.parse(nuget), "newtonsoft.json")?.name)
    }

    @Test
    fun `parses human and agent layers`() {
        val model = NotesCore.parse(
            """
            ---
            format: dependency-notes/1
            lang: en
            ---

            # Dependency Notes

            ## express

            HTTP API layer.

            ### Agent notes

            - purpose: HTTP framework
            """.trimIndent(),
        )
        val section = NotesCore.findSection(model, "EXPRESS")!!
        val layers = NotesCore.layers(model, section)
        assertEquals("HTTP API layer.", layers.human)
        assertEquals("- purpose: HTTP framework", layers.agent)
        assertEquals("HTTP API layer.", NotesCore.preview(layers, InlineSource.HUMAN_FIRST))
        assertEquals("HTTP framework", NotesCore.preview(layers, InlineSource.AI_FIRST))
    }

    @Test
    fun `ignores headings inside fenced blocks`() {
        val model = NotesCore.parse("## real\n\n```md\n## fake\n```\nbody")
        assertEquals(listOf("real"), model.sections.map { it.name })
        assertTrue(NotesCore.layers(model, model.sections.single()).human.contains("## fake"))
    }

    @Test
    fun `reports duplicate sections and normalizes quoted names`() {
        val model = NotesCore.parse("## `Express`\na\n## other\nb\n## express\nc")
        assertEquals(1, model.problems.size)
        assertEquals(4, model.problems.single().line)
        assertEquals("`Express`", NotesCore.findSection(model, "express")?.name)
        assertNull(NotesCore.findSection(model, "missing"))
    }

    @Test
    fun `updates only human text and preserves agent and generated blocks`() {
        val original = listOf(
            "## alpha",
            "",
            "old human",
            "",
            "### Agent notes",
            "",
            "- purpose: p",
            "",
            "### Generated",
            "- installed: 1",
            "",
        ).joinToString("\n")
        val updated = NotesCore.upsertHumanNote(original, "alpha", "new human\nsecond line")
        assertEquals(
            "## alpha\n\nnew human\nsecond line\n\n### Agent notes\n\n- purpose: p\n\n### Generated\n- installed: 1\n",
            updated,
        )
    }

    @Test
    fun `inserts a new section in sorted order`() {
        val updated = NotesCore.upsertHumanNote("## alpha\n\na\n\n## charlie\n\nc\n", "bravo", "b")
        assertTrue(updated.indexOf("## alpha") < updated.indexOf("## bravo"))
        assertTrue(updated.indexOf("## bravo") < updated.indexOf("## charlie"))
    }

    @Test
    fun `preserves CRLF while updating`() {
        val original = "## a\r\n\r\nold\r\n\r\n### Agent notes\r\n\r\n- purpose: p\r\n"
        val updated = NotesCore.upsertHumanNote(original, "a", "new")
        assertEquals("## a\r\n\r\nnew\r\n\r\n### Agent notes\r\n\r\n- purpose: p\r\n", updated)
    }

    @Test
    fun `creates a canonical notes file`() {
        val created = NotesCore.newNotesFile("vue", "Frontend framework")
        assertTrue(created.startsWith("---\nformat: dependency-notes/1\nlang: en\n---"))
        assertTrue(created.contains("\n## vue\n\nFrontend framework\n"))
    }

    @Test
    fun `updates human and agent layers and preserves generated content`() {
        val original = "## alpha\n\nold\n\n### Agent notes\n\n- purpose: old\n\n### Generated\n- installed: 1\n"
        val updated = NotesCore.upsertNoteLayers(original, "alpha", "new human", "- purpose: new\n- runtime: server")
        assertEquals(
            "## alpha\n\nnew human\n\n### Agent notes\n\n- purpose: new\n- runtime: server\n\n### Generated\n- installed: 1\n",
            updated,
        )
    }

    @Test
    fun `two layer update preserves bom and crlf`() {
        val original = "\uFEFF## alpha\r\n\r\nold\r\n\r\n### Generated\r\n- installed: 1\r\n"
        val updated = NotesCore.upsertNoteLayers(original, "alpha", "human", "- purpose: p")
        assertEquals(
            "\uFEFF## alpha\r\n\r\nhuman\r\n\r\n### Agent notes\r\n\r\n- purpose: p\r\n\r\n### Generated\r\n- installed: 1\r\n",
            updated,
        )
    }

    @Test
    fun `creates a canonical file with both editable layers`() {
        val created = NotesCore.newNotesFile("vue", "Frontend", "- purpose: UI\n- runtime: client")
        assertTrue(created.contains("## vue\n\nFrontend\n\n### Agent notes\n\n- purpose: UI\n- runtime: client\n"))
    }
}
