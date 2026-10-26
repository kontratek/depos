package dev.pacmon.jetbrains.core

/**
 * The pointer block written into instruction files an agent already reads
 * (`AGENTS.md`, `CLAUDE.md`, …). Deliberately three lines: the rules
 * themselves live in `.depos/AGENT-RULES.md`, which Depos owns; these files
 * it does not. A line-for-line port of the TypeScript core's
 * `aiInstructionsBlock`/`upsertAiInstructions` (`src/core/template.ts`).
 */
object AiInstructions {
    /** Files "Set Up AI Instructions" offers to write the pointer block into. */
    val TARGETS = listOf("AGENTS.md", "CLAUDE.md", ".cursor/rules/dependency-notes.md", ".github/copilot-instructions.md")

    private const val BLOCK_START = "<!-- depos:start -->"
    private const val BLOCK_END = "<!-- depos:end -->"

    /**
     * Markers written by earlier versions: Pacmon's, and before them the ones from
     * before the format was named `dependency-notes/1`. Still found, never written.
     */
    private val legacyBlocks = listOf(
        "<!-- pacmon:start -->" to "<!-- pacmon:end -->",
        "<!-- pacmon:deps-notes:start -->" to "<!-- pacmon:deps-notes:end -->",
    )

    private val trailingLineBreaks = Regex("(?:\\r?\\n)+\\z")
    private val leadingLineBreaks = Regex("^(?:\\r?\\n)+")

    /** [dir] is the repository's notes directory. */
    fun block(dir: String = NotesCore.NOTES_DIRECTORY): String {
        val file = NotesCore.NOTES_FILE_NAME
        return listOf(
            BLOCK_START,
            "Dependency notes live in `$dir/$file` for npm, " +
                "`$dir/cargo/$file` for Rust, " +
                "`$dir/maven/$file` for Maven, " +
                "`$dir/gradle/$file` for Gradle, " +
                "`$dir/mix/$file` for Mix, " +
                "`$dir/gleam/$file` for Gleam, " +
                "`$dir/zig/$file` for Zig, " +
                "`$dir/python/$file` for Python, " +
                "`$dir/ruby/$file` for Ruby, " +
                "`$dir/go/$file` for Go, " +
                "`$dir/nuget/$file` for .NET/NuGet, " +
                "`$dir/vcpkg/$file` for vcpkg, " +
                "`$dir/conan/$file` for Conan, and " +
                "`$dir/composer/$file` for PHP/Composer; people write below `## <package>`, " +
                "agents under `${NotesCore.AGENT_NOTES_HEADING}`.",
            "Rules and the field list are in `${NotesCore.agentRulesRelativePath(dir)}`; read a package's section " +
                "before adding, bumping or removing it.",
            "Update the notes in the same commit as the dependency manifest; a removed package keeps its section with " +
                "`- status: removed …`.",
            BLOCK_END,
        ).joinToString("\n")
    }

    /** True when [text] has a pointer block, current or legacy. */
    fun hasBlock(text: String): Boolean = markedBlocks(text).isNotEmpty()

    /**
     * Insert or replace the marked block in an existing instructions file. The
     * first block found, current or legacy, becomes the new one; any other is
     * removed. A teammate on an older version adds a `pacmon:` block of their own,
     * so the file comes back to one block the next time this runs.
     */
    fun upsert(existing: String, dir: String = NotesCore.NOTES_DIRECTORY): String {
        val block = block(dir)
        val ranges = markedBlocks(existing)
        val first = ranges.firstOrNull()
        if (first != null) {
            var text = existing
            for (range in ranges.drop(1).asReversed()) text = withoutBlock(text, range)
            return text.substring(0, first.first) + block + text.substring(first.last + 1)
        }
        val separator = when {
            existing.isEmpty() -> ""
            existing.endsWith("\n\n") -> ""
            existing.endsWith("\n") -> "\n"
            else -> "\n\n"
        }
        return existing + separator + block + "\n"
    }

    /** Every marked block in the text, current and legacy, in the order they appear. */
    private fun markedBlocks(text: String): List<IntRange> {
        val ranges = mutableListOf<IntRange>()
        for ((startMark, endMark) in listOf(BLOCK_START to BLOCK_END) + legacyBlocks) {
            var from = 0
            while (true) {
                val start = text.indexOf(startMark, from)
                if (start == -1) break
                val end = text.indexOf(endMark, start + startMark.length)
                if (end == -1) break
                ranges.add(start until end + endMark.length)
                from = end + endMark.length
            }
        }
        ranges.sortBy { it.first }
        // A block inside another (a hand-edited file) is the outer block's business.
        return ranges.filterIndexed { i, range -> ranges.subList(0, i).all { range.first > it.last } }
    }

    /** The text without the block, and without the blank lines it leaves behind. */
    private fun withoutBlock(text: String, range: IntRange): String {
        val eol = if (text.contains("\r\n")) "\r\n" else "\n"
        val before = text.substring(0, range.first).replace(trailingLineBreaks, "")
        val after = text.substring(range.last + 1).replace(leadingLineBreaks, "")
        if (before.isEmpty()) return after
        if (after.isEmpty()) return before + eol
        return before + eol + eol + after
    }
}
