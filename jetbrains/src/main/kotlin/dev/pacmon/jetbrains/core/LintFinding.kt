package dev.pacmon.jetbrains.core

/**
 * A mistake `docs/format.md` defines, with a fixed fix — never a matter of
 * taste. Mirrors the TypeScript core's `LintFinding` union (`src/core/lint.ts`)
 * field for field, so the two stay easy to compare by eye.
 */
sealed class LintFinding(val line: Int) {
    abstract fun message(): String

    private companion object {
        /** The Tools-menu action that rewrites the file, named as the user sees it. */
        const val FORMAT_ACTION = "Format ${NotesCore.NOTES_FILE_NAME}"
    }

    class DuplicateSection(line: Int, val name: String, val firstLine: Int) : LintFinding(line) {
        override fun message(): String =
            "\"$name\" is already defined at line ${firstLine + 1} — only the first section is read."
    }

    class WrongHeadingLevel(line: Int, val name: String, val level: Int) : LintFinding(line) {
        override fun message(): String = "\"$name\" is a dependency — write \"## $name\" so tools find this note."
    }

    class MissingSpaceAfterHashes(line: Int, val name: String) : LintFinding(line) {
        override fun message(): String = "Missing space: write \"## $name\"."
    }

    class MissingFrontmatter(line: Int) : LintFinding(line) {
        override fun message(): String = "No frontmatter — \"$FORMAT_ACTION\" adds it."
    }

    class UnknownFormat(line: Int, val version: String) : LintFinding(line) {
        override fun message(): String =
            "Unknown format \"$version\" — this version of Depos reads ${NotesCore.SUPPORTED_FORMAT_VERSIONS.joinToString(" and ")}."
    }

    class MissingEcosystem(line: Int) : LintFinding(line) {
        override fun message(): String =
            "Format dependency-notes/2 requires a supported ecosystem value, such as ecosystem: ruby."
    }

    class WrongEcosystem(
        line: Int,
        val actual: ManifestKind,
        val expected: ManifestKind,
    ) : LintFinding(line) {
        override fun message(): String =
            "This notes path is for ${expected.id}, but the frontmatter says ecosystem: ${actual.id}."
    }

    class MissingTitle(line: Int) : LintFinding(line) {
        override fun message(): String =
            "No \"${NotesCore.DEFAULT_TITLE}\" title — \"$FORMAT_ACTION\" adds it."
    }

    class WrongTitle(line: Int, val text: String) : LintFinding(line) {
        override fun message(): String = "The title is \"${NotesCore.DEFAULT_TITLE}\"."
    }

    class ExtraTitle(line: Int, val text: String) : LintFinding(line) {
        override fun message(): String = "Only one \"#\" heading, \"${NotesCore.DEFAULT_TITLE}\" — make this plain text."
    }

    enum class StrayHeadingMeant { AGENT_NOTES, GENERATED }

    class StrayHeading(
        line: Int,
        val text: String,
        val level: Int,
        val meant: StrayHeadingMeant? = null,
    ) : LintFinding(line) {
        override fun message(): String = when (meant) {
            StrayHeadingMeant.AGENT_NOTES -> "Did you mean \"${NotesCore.AGENT_NOTES_HEADING}\"?"
            StrayHeadingMeant.GENERATED -> "\"${NotesCore.GENERATED_HEADING}\" is reserved for tools — nothing writes it yet."
            null -> "Only \"${NotesCore.AGENT_NOTES_HEADING}\" may head a section — make this plain text."
        }
    }

    class UnknownAgentKey(
        line: Int,
        val key: String,
        val value: String,
        val span: Span,
        val suggestion: String? = null,
    ) : LintFinding(line) {
        override fun message(): String = suggestion?.let { "Unknown field \"$key:\" — did you mean \"$it:\"?" }
            ?: "Unknown field \"$key:\" — keep it as \"note:\" or remove it. Fields: ${NotesCore.AGENT_RULES_RELATIVE_PATH}"
    }

    class EmptyAgentValue(line: Int, val key: String, val span: Span) : LintFinding(line) {
        override fun message(): String = "\"$key:\" is empty — remove the line."
    }

    class BadAgentValue(
        line: Int,
        val key: String,
        val value: String,
        val expected: String,
        val span: Span,
    ) : LintFinding(line) {
        override fun message(): String = "\"$key:\" expects $expected."
    }

    class RemovedButPresent(line: Int, val name: String, val span: Span) : LintFinding(line) {
        override fun message(): String =
            "\"$name\" is still in its dependency manifest — remove \"status: removed\"."
    }
}
