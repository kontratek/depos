package dev.pacmon.jetbrains.core

private data class GleamLine(val text: String, val offset: Int)
private data class GleamKey(val value: String, val range: SourceRange)

/** Static gleam.toml parser. Depos never invokes Gleam or resolves packages. */
object GleamManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.GLEAM
    override val fileNames = listOf("gleam.toml")
    override val notesRelativePath = ".depos/gleam/DEPENDENCY-NOTES.md"
    override fun normalizeNoteKey(raw: String): String = ManifestRegistry.stripName(raw)

    private val dependencyScopes = setOf("dependencies", "dev_dependencies")
    private val tablePattern = Regex("^\\s*\\[\\s*([^]]+)\\s*]\\s*$")
    private val bareKeyPattern = Regex("^[A-Za-z0-9_-]+$")

    override fun extractDependencies(text: String): List<DependencyEntry> {
        val dependencies = mutableListOf<DependencyEntry>()
        val seen = mutableSetOf<String>()
        var activeScope: String? = null
        var continuationDepth = 0

        for (line in splitLines(text)) {
            val content = contentBeforeComment(line.text)
            if (continuationDepth > 0) {
                continuationDepth = maxOf(0, continuationDepth + nestingDelta(content))
                continue
            }

            if (content.trimStart().startsWith('[')) {
                val table = tablePattern.matchEntire(content)?.groupValues?.get(1)?.trim()
                activeScope = table?.takeIf(dependencyScopes::contains)
                continue
            }

            val scope = activeScope ?: continue
            val equals = unquotedIndex(content, '=')
            if (equals < 0) continue
            val key = dependencyKey(content.substring(0, equals), line.offset) ?: continue
            if (seen.add("$scope\u0000${key.value}")) {
                dependencies.add(dependencyEntry(key.value, scope, key.range))
            }
            continuationDepth = maxOf(0, nestingDelta(content.substring(equals + 1)))
        }

        return dependencies
    }

    private fun splitLines(text: String): List<GleamLine> {
        val lines = mutableListOf<GleamLine>()
        var start = 0
        while (start <= text.length) {
            val newline = text.indexOf('\n', start)
            if (newline < 0) {
                lines.add(GleamLine(text.substring(start), start))
                break
            }
            val end = if (newline > start && text[newline - 1] == '\r') newline - 1 else newline
            lines.add(GleamLine(text.substring(start, end), start))
            start = newline + 1
        }
        return lines
    }

    private fun contentBeforeComment(line: String): String {
        var quote: Char? = null
        var escaped = false
        line.forEachIndexed { index, char ->
            when {
                quote == '"' && escaped -> escaped = false
                quote == '"' && char == '\\' -> escaped = true
                quote != null -> if (char == quote) quote = null
                char == '"' || char == '\'' -> quote = char
                char == '#' -> return line.substring(0, index)
            }
        }
        return line
    }

    private fun unquotedIndex(text: String, wanted: Char): Int {
        var quote: Char? = null
        var escaped = false
        text.forEachIndexed { index, char ->
            when {
                quote == '"' && escaped -> escaped = false
                quote == '"' && char == '\\' -> escaped = true
                quote != null -> if (char == quote) quote = null
                char == '"' || char == '\'' -> quote = char
                char == wanted -> return index
            }
        }
        return -1
    }

    private fun nestingDelta(text: String): Int {
        var delta = 0
        var quote: Char? = null
        var escaped = false
        for (char in text) {
            when {
                quote == '"' && escaped -> escaped = false
                quote == '"' && char == '\\' -> escaped = true
                quote != null -> if (char == quote) quote = null
                char == '"' || char == '\'' -> quote = char
                char == '{' || char == '[' -> delta++
                char == '}' || char == ']' -> delta--
            }
        }
        return delta
    }

    private fun dependencyKey(raw: String, absoluteOffset: Int): GleamKey? {
        val leading = raw.length - raw.trimStart().length
        val token = raw.trim()
        if (token.isEmpty()) return null
        val value = decodeKey(token) ?: return null
        return GleamKey(value, SourceRange(absoluteOffset + leading, token.length))
    }

    private fun decodeKey(raw: String): String? = when {
        raw.startsWith('"') -> {
            if (!raw.endsWith('"')) null
            else runCatching { decodeBasicString(raw.substring(1, raw.length - 1)) }
                .getOrElse { raw.substring(1, raw.length - 1) }
        }
        raw.startsWith('\'') -> if (raw.endsWith('\'')) raw.substring(1, raw.length - 1) else null
        bareKeyPattern.matches(raw) -> raw
        else -> null
    }

    private fun decodeBasicString(value: String): String = buildString {
        var index = 0
        while (index < value.length) {
            val char = value[index++]
            if (char != '\\') {
                append(char)
                continue
            }
            require(index < value.length)
            when (val escaped = value[index++]) {
                '"', '\\', '/' -> append(escaped)
                'b' -> append('\b')
                'f' -> append('\u000C')
                'n' -> append('\n')
                'r' -> append('\r')
                't' -> append('\t')
                'u' -> {
                    require(index + 4 <= value.length)
                    append(value.substring(index, index + 4).toInt(16).toChar())
                    index += 4
                }
                else -> error("Unsupported escape")
            }
        }
    }
}
