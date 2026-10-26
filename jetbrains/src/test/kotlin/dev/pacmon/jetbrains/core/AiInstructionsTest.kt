package dev.pacmon.jetbrains.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The same cases as the pointer block tests of `src/test/unit/template.test.ts`. */
class AiInstructionsTest {
    /** The lines between the current markers. */
    private fun between(text: String): List<String> {
        val lines = text.split('\n')
        val start = lines.indexOfFirst { it.contains("depos:start") }
        val end = lines.indexOfFirst { it.contains("depos:end") }
        return lines.subList(start + 1, end)
    }

    private fun count(text: String, needle: String): Int = Regex(Regex.escape(needle)).findAll(text).count()

    @Test
    fun `generated block names the notes file of every ecosystem`() {
        val block = AiInstructions.block()
        assertTrue(block.contains("`.depos/DEPENDENCY-NOTES.md` for npm"))
        for ((directory, ecosystem) in listOf(
            "cargo" to "Rust", "maven" to "Maven", "gradle" to "Gradle", "mix" to "Mix", "gleam" to "Gleam",
            "zig" to "Zig", "python" to "Python", "ruby" to "Ruby", "go" to "Go", "nuget" to ".NET/NuGet",
            "vcpkg" to "vcpkg", "conan" to "Conan", "composer" to "PHP/Composer",
        )) {
            assertTrue(ecosystem, block.contains("`.depos/$directory/DEPENDENCY-NOTES.md` for $ecosystem"))
        }
    }

    @Test
    fun `is exactly three lines and points at both files`() {
        val inner = between(AiInstructions.block())
        assertEquals(3, inner.size)
        val text = inner.joinToString("\n")
        assertTrue(text.contains(NotesCore.NOTES_RELATIVE_PATH))
        assertTrue(text.contains(NotesCore.AGENT_RULES_RELATIVE_PATH))
        assertTrue(text.contains("### Agent notes"))
        assertTrue(text.contains("status: removed"))
        assertFalse(text.contains(".pacmon/"))
    }

    @Test
    fun `names the repository's own directory when it still keeps its notes in pacmon`() {
        val text = between(AiInstructions.block(NotesCore.LEGACY_NOTES_DIRECTORY)).joinToString("\n")
        assertTrue(text.contains(".pacmon/DEPENDENCY-NOTES.md"))
        assertTrue(text.contains(".pacmon/cargo/DEPENDENCY-NOTES.md"))
        assertTrue(text.contains(".pacmon/AGENT-RULES.md"))
        assertFalse(text.contains(".depos/"))
    }

    @Test
    fun `appends the block once and replaces it on re-run`() {
        val first = AiInstructions.upsert("# AGENTS\n\nexisting\n")
        assertTrue(first.contains("depos:start"))
        val second = AiInstructions.upsert(first)
        assertEquals(1, count(second, "depos:start"))
        assertTrue(second.contains("existing"))
        assertEquals(3, between(second).size)
    }

    @Test
    fun `works on empty files`() {
        val out = AiInstructions.upsert("")
        assertTrue(out.startsWith("<!-- depos:start -->"))
        assertTrue(out.endsWith("\n"))
    }

    @Test
    fun `replaces a block left by the old markers`() {
        val old = "# AGENTS\n\n<!-- pacmon:deps-notes:start -->\nold\n<!-- pacmon:deps-notes:end -->\n"
        val out = AiInstructions.upsert(old)
        assertFalse(out.contains("deps-notes"))
        assertFalse(out.contains("\nold\n"))
        assertEquals(3, between(out).size)
    }

    @Test
    fun `replaces the block Pacmon wrote, in place`() {
        val old = "# AGENTS\n\nbefore\n\n<!-- pacmon:start -->\nold\n<!-- pacmon:end -->\n\nafter\n"
        val out = AiInstructions.upsert(old)
        assertFalse(out.contains("pacmon:"))
        assertFalse(out.contains("\nold\n"))
        assertTrue(out.indexOf("before") < out.indexOf("depos:start"))
        assertTrue(out.indexOf("depos:end") < out.indexOf("after"))
        assertEquals(3, between(out).size)
    }

    @Test
    fun `comes back to one block when an older version added its own`() {
        // A teammate on Pacmon ran the setup after this file got the Depos block:
        // Pacmon did not know the new markers and appended a block of its own.
        val block = AiInstructions.block()
        val mixed = "# AGENTS\n\nintro\n\n$block\n\nmiddle\n\n<!-- pacmon:start -->\nold\n<!-- pacmon:end -->\n"
        val out = AiInstructions.upsert(mixed)
        assertEquals(1, count(out, "depos:start"))
        assertFalse(out.contains("pacmon:"))
        assertEquals("# AGENTS\n\nintro\n\n$block\n\nmiddle\n", out)
    }

    @Test
    fun `the first block found becomes the new one, wherever it is`() {
        val mixed = "<!-- pacmon:start -->\nold\n<!-- pacmon:end -->\n\nmiddle\n\n" +
            "<!-- depos:start -->\nx\n<!-- depos:end -->\n\n<!-- pacmon:deps-notes:start -->\ny\n<!-- pacmon:deps-notes:end -->\n"
        val out = AiInstructions.upsert(mixed)
        assertEquals("${AiInstructions.block()}\n\nmiddle\n", out)
    }

    @Test
    fun `keeps CRLF files CRLF around a removed block`() {
        val mixed = "intro\r\n\r\n<!-- depos:start -->\r\nx\r\n<!-- depos:end -->\r\n\r\nmiddle\r\n\r\n" +
            "<!-- pacmon:start -->\r\nold\r\n<!-- pacmon:end -->\r\n\r\nend\r\n"
        val out = AiInstructions.upsert(mixed)
        assertTrue(out.contains("\r\n\r\nmiddle\r\n\r\nend\r\n"))
        assertFalse(out.contains("pacmon:"))
    }

    @Test
    fun `writes the block for the repository's directory`() {
        val out = AiInstructions.upsert("<!-- pacmon:start -->\nold\n<!-- pacmon:end -->\n", NotesCore.LEGACY_NOTES_DIRECTORY)
        assertEquals(AiInstructions.block(NotesCore.LEGACY_NOTES_DIRECTORY) + "\n", out)
        assertTrue(AiInstructions.hasBlock(out))
        assertFalse(AiInstructions.hasBlock("# AGENTS\n\n<!-- pacmon:start -->\nno end\n"))
    }
}
