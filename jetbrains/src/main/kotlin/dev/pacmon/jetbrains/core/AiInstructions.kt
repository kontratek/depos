package dev.pacmon.jetbrains.core

/**
 * The pointer block written into instruction files an agent already reads
 * (`AGENTS.md`, `CLAUDE.md`, …). Deliberately three lines: the rules
 * themselves live in `.pacmon/AGENT-RULES.md`, which Pacmon owns; these files
 * it does not. A line-for-line port of the TypeScript core's
 * `aiInstructionsBlock`/`upsertAiInstructions` (`src/core/template.ts`).
 */
object AiInstructions {
    /** Files "Set Up AI Instructions" offers to write the pointer block into. */
    val TARGETS = listOf("AGENTS.md", "CLAUDE.md", ".cursor/rules/dependency-notes.md", ".github/copilot-instructions.md")

    private const val BLOCK_START = "<!-- pacmon:start -->"
    private const val BLOCK_END = "<!-- pacmon:end -->"

    /** Written before the format was named `dependency-notes/1`. Still found, never written. */
    private val legacyBlock = "<!-- pacmon:deps-notes:start -->" to "<!-- pacmon:deps-notes:end -->"

    fun block(): String = listOf(
        BLOCK_START,
        "Dependency notes live in `${NotesCore.NOTES_RELATIVE_PATH}` for npm, " +
            "`.pacmon/cargo/${NotesCore.NOTES_FILE_NAME}` for Rust, " +
            "`.pacmon/maven/${NotesCore.NOTES_FILE_NAME}` for Maven, " +
            "`.pacmon/gradle/${NotesCore.NOTES_FILE_NAME}` for Gradle, " +
            "`.pacmon/mix/${NotesCore.NOTES_FILE_NAME}` for Mix, " +
            "`.pacmon/gleam/${NotesCore.NOTES_FILE_NAME}` for Gleam, " +
            "`.pacmon/zig/${NotesCore.NOTES_FILE_NAME}` for Zig, " +
            "`.pacmon/python/${NotesCore.NOTES_FILE_NAME}` for Python, " +
            "`.pacmon/ruby/${NotesCore.NOTES_FILE_NAME}` for Ruby, " +
            "`.pacmon/go/${NotesCore.NOTES_FILE_NAME}` for Go, " +
            "`.pacmon/nuget/${NotesCore.NOTES_FILE_NAME}` for .NET/NuGet, " +
            "`.pacmon/vcpkg/${NotesCore.NOTES_FILE_NAME}` for vcpkg, " +
            "`.pacmon/conan/${NotesCore.NOTES_FILE_NAME}` for Conan, and " +
            "`.pacmon/composer/${NotesCore.NOTES_FILE_NAME}` for PHP/Composer; people write below `## <package>`, " +
            "agents under `${NotesCore.AGENT_NOTES_HEADING}`.",
        "Rules and the field list are in `${NotesCore.AGENT_RULES_RELATIVE_PATH}`; read a package's section " +
            "before adding, bumping or removing it.",
        "Update the notes in the same commit as the dependency manifest; a removed package keeps its section with " +
            "`- status: removed …`.",
        BLOCK_END,
    ).joinToString("\n")

    /** Insert or replace the marked block in an existing instructions file. */
    fun upsert(existing: String): String {
        val block = block()
        for ((startMark, endMark) in listOf(BLOCK_START to BLOCK_END, legacyBlock)) {
            val start = existing.indexOf(startMark)
            val end = existing.indexOf(endMark)
            if (start != -1 && end != -1 && end > start) {
                return existing.substring(0, start) + block + existing.substring(end + endMark.length)
            }
        }
        val separator = when {
            existing.isEmpty() -> ""
            existing.endsWith("\n\n") -> ""
            existing.endsWith("\n") -> "\n"
            else -> "\n\n"
        }
        return existing + separator + block + "\n"
    }
}
