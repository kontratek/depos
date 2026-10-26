package dev.pacmon.jetbrains.core

/** Static go.mod parser. Depos never invokes Go. */
object GoManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.GO
    override val fileNames = listOf("go.mod")
    override val notesRelativePath = ".depos/go/DEPENDENCY-NOTES.md"
    override fun normalizeNoteKey(raw: String): String = ManifestRegistry.stripName(raw)

    /** [range] covers the token's content, without surrounding quotes. */
    private data class Token(val value: String, val range: SourceRange, val quoted: Boolean)

    private data class Line(val tokens: List<Token>, val comment: String)

    private class Module(val path: String, val scope: String, val range: SourceRange) {
        val toolRanges = mutableListOf<SourceRange>()
    }

    private val indirectComment = Regex("^indirect(?:;|$)")

    /**
     * `require` and `tool` dependencies. `// indirect` requirements keep their own scope.
     * A tool names a package, so it is attached to the required module whose path is its longest prefix.
     */
    override fun extractDependencies(text: String): List<DependencyEntry> {
        val modules = mutableListOf<Module>()
        val byPath = mutableMapOf<String, Module>()
        val tools = mutableListOf<Token>()
        fun addRequire(token: Token, comment: String) {
            if (token.value in byPath) return
            val scope = if (indirectComment.containsMatchIn(comment.trim())) "indirect" else "require"
            val module = Module(token.value, scope, token.range)
            byPath[token.value] = module
            modules += module
        }

        var block: String? = null
        for ((tokens, comment) in lines(text)) {
            if (tokens.isEmpty()) continue
            val first = tokens[0]
            if (block != null) {
                if (first.value == ")" && !first.quoted) {
                    block = null
                    continue
                }
                if (isPath(first)) {
                    if (block == "require") addRequire(first, comment) else if (block == "tool") tools += first
                }
                continue
            }
            val argument = tokens.getOrNull(1)
            if (argument != null && argument.value == "(" && !argument.quoted) {
                // `require (` opens a block; `require ()` on one line is empty.
                val third = tokens.getOrNull(2)
                if (!(third != null && third.value == ")" && !third.quoted)) block = first.value
                continue
            }
            if (argument != null && isPath(argument)) {
                if (first.value == "require") addRequire(argument, comment) else if (first.value == "tool") tools += argument
            }
        }

        val standalone = mutableListOf<Module>()
        for (tool in tools) {
            val owner = modules
                .filter { tool.value == it.path || tool.value.startsWith("${it.path}/") }
                .maxByOrNull { it.path.length }
            if (owner != null) {
                owner.toolRanges += tool.range
            } else if (tool.value !in byPath) {
                val module = Module(tool.value, "tool", tool.range)
                byPath[tool.value] = module
                standalone += module
            }
        }

        return (modules + standalone)
            .sortedBy { it.range.offset }
            .map { DependencyEntry(it.path, it.path, it.scope, it.range, listOf(it.range) + it.toolRanges) }
    }

    private fun isPath(token: Token): Boolean = token.value.isNotEmpty() &&
        (token.quoted || (token.value != "(" && token.value != ")"))

    private fun decodeInterpreted(value: String): String = Regex("\\\\(.)").replace(value) {
        when (val escaped = it.groupValues[1]) {
            "n" -> "\n"
            "t" -> "\t"
            "r" -> "\r"
            else -> escaped
        }
    }

    private fun lines(text: String): List<Line> {
        val out = mutableListOf<Line>()
        var offset = 0
        while (offset <= text.length) {
            val newline = text.indexOf('\n', offset)
            val rawEnd = if (newline < 0) text.length else newline
            val end = if (rawEnd > offset && text[rawEnd - 1] == '\r') rawEnd - 1 else rawEnd
            val tokens = mutableListOf<Token>()
            var comment = ""
            var cursor = offset
            while (cursor < end) {
                val char = text[cursor]
                when {
                    char.isWhitespace() -> cursor++
                    char == '/' && cursor + 1 < end && text[cursor + 1] == '/' -> {
                        comment = text.substring(cursor + 2, end)
                        cursor = end
                    }
                    char == '(' || char == ')' -> {
                        tokens += Token(char.toString(), SourceRange(cursor, 1), quoted = false)
                        cursor++
                    }
                    char == '"' || char == '`' -> {
                        val contentStart = ++cursor
                        while (cursor < end && text[cursor] != char) {
                            if (char == '"' && text[cursor] == '\\' && cursor + 1 < end) cursor++
                            cursor++
                        }
                        val raw = text.substring(contentStart, cursor)
                        val value = if (char == '"') decodeInterpreted(raw) else raw
                        tokens += Token(value, SourceRange(contentStart, cursor - contentStart), quoted = true)
                        if (cursor < end) cursor++
                    }
                    else -> {
                        val start = cursor
                        while (
                            cursor < end &&
                            !text[cursor].isWhitespace() &&
                            text[cursor] != '(' &&
                            text[cursor] != ')' &&
                            !(text[cursor] == '/' && cursor + 1 < end && text[cursor + 1] == '/')
                        ) cursor++
                        tokens += Token(text.substring(start, cursor), SourceRange(start, cursor - start), quoted = false)
                    }
                }
            }
            out += Line(tokens, comment)
            if (newline < 0) break
            offset = newline + 1
        }
        return out
    }
}
