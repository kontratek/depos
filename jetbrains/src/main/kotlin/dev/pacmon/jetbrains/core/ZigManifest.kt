package dev.pacmon.jetbrains.core

/** Static build.zig.zon parser. Depos never invokes Zig or evaluates build.zig. */
object ZigManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.ZIG
    override val fileNames = listOf("build.zig.zon")
    override val notesRelativePath = ".depos/zig/DEPENDENCY-NOTES.md"
    override fun normalizeNoteKey(raw: String): String = ManifestRegistry.stripName(raw)

    private enum class TokenKind { IDENTIFIER, STRING, SYMBOL }

    private data class Token(
        val kind: TokenKind,
        val value: String,
        val start: Int,
        val end: Int,
        val contentStart: Int? = null,
        val contentEnd: Int? = null,
    )

    private data class ZonField(
        val name: String,
        val primaryRange: SourceRange,
        val sourceRange: SourceRange,
        val iconRange: SourceRange,
        val equalsIndex: Int,
    )

    private val openToClose = mapOf("{" to "}", "[" to "]", "(" to ")")

    override fun extractDependencies(text: String): List<DependencyEntry> {
        val tokens = tokenize(text)
        val open = dependenciesOpen(tokens) ?: return emptyList()
        val out = mutableListOf<DependencyEntry>()
        val seen = mutableSetOf<String>()
        val stack = mutableListOf("}")

        for (index in open + 1 until tokens.size) {
            val token = tokens[index]
            if (stack.size == 1) {
                if (token.value == "}") break
                val field = fieldAt(tokens, index)
                if (field != null && seen.add(field.name)) {
                    out.add(
                        dependencyEntry(
                            noteKey = field.name,
                            scope = "dependencies",
                            primaryRange = field.primaryRange,
                            sourceRanges = listOf(field.sourceRange),
                            displayName = field.name,
                            iconRange = field.iconRange,
                        ),
                    )
                }
            }
            openToClose[token.value]?.let(stack::add)
                ?: if (token.value == stack.lastOrNull()) stack.removeAt(stack.lastIndex) else Unit
        }
        return out
    }

    private fun dependenciesOpen(tokens: List<Token>): Int? {
        val stack = mutableListOf<String>()
        for (index in tokens.indices) {
            val token = tokens[index]
            if (stack.size == 1) {
                val field = fieldAt(tokens, index)
                if (field?.name == "dependencies" &&
                    tokens.getOrNull(field.equalsIndex + 1)?.value == "." &&
                    tokens.getOrNull(field.equalsIndex + 2)?.value == "{"
                ) {
                    return field.equalsIndex + 2
                }
            }
            openToClose[token.value]?.let(stack::add)
                ?: if (token.value == stack.lastOrNull()) stack.removeAt(stack.lastIndex) else Unit
        }
        return null
    }

    private fun fieldAt(tokens: List<Token>, dotIndex: Int): ZonField? {
        val dot = tokens.getOrNull(dotIndex)?.takeIf { it.value == "." } ?: return null
        val next = tokens.getOrNull(dotIndex + 1) ?: return null
        val name: String
        val primaryRange: SourceRange
        val sourceRange: SourceRange
        val equalsIndex: Int

        if (next.kind == TokenKind.IDENTIFIER) {
            name = next.value
            primaryRange = SourceRange(next.start, next.end - next.start)
            sourceRange = primaryRange
            equalsIndex = dotIndex + 2
        } else if (next.value == "@" && tokens.getOrNull(dotIndex + 2)?.kind == TokenKind.STRING) {
            val quoted = tokens[dotIndex + 2]
            name = quoted.value
            val contentStart = quoted.contentStart ?: quoted.start
            val contentEnd = quoted.contentEnd ?: quoted.end
            primaryRange = SourceRange(contentStart, contentEnd - contentStart)
            sourceRange = SourceRange(next.start, quoted.end - next.start)
            equalsIndex = dotIndex + 3
        } else {
            return null
        }
        if (tokens.getOrNull(equalsIndex)?.value != "=") return null
        return ZonField(
            name,
            primaryRange,
            sourceRange,
            SourceRange(dot.start, dot.end - dot.start),
            equalsIndex,
        )
    }

    private fun tokenize(text: String): List<Token> {
        val tokens = mutableListOf<Token>()
        var cursor = 0
        while (cursor < text.length) {
            val char = text[cursor]
            if (char.isWhitespace()) {
                cursor++
                continue
            }
            if (char == '/' && text.getOrNull(cursor + 1) == '/') {
                cursor += 2
                while (cursor < text.length && text[cursor] != '\r' && text[cursor] != '\n') cursor++
                continue
            }
            if (char == '\\' && text.getOrNull(cursor + 1) == '\\') {
                cursor += 2
                while (cursor < text.length && text[cursor] != '\r' && text[cursor] != '\n') cursor++
                continue
            }
            if (char == '"' || char == '\'') {
                val quote = char
                val start = cursor++
                val contentStart = cursor
                while (cursor < text.length) {
                    if (text[cursor] == '\\' && cursor + 1 < text.length) {
                        cursor += 2
                        continue
                    }
                    if (text[cursor] == quote) break
                    cursor++
                }
                val contentEnd = cursor
                if (cursor < text.length) cursor++
                val raw = text.substring(contentStart, contentEnd)
                tokens.add(
                    Token(
                        TokenKind.STRING,
                        if (quote == '"') decodeString(raw) else raw,
                        start,
                        cursor,
                        contentStart,
                        contentEnd,
                    ),
                )
                continue
            }
            if (char == '_' || char.isLetter()) {
                val start = cursor++
                while (cursor < text.length &&
                    (text[cursor] == '_' || text[cursor].isLetterOrDigit())
                ) cursor++
                tokens.add(Token(TokenKind.IDENTIFIER, text.substring(start, cursor), start, cursor))
                continue
            }
            tokens.add(Token(TokenKind.SYMBOL, char.toString(), cursor, cursor + 1))
            cursor++
        }
        return tokens
    }

    private fun decodeString(value: String): String = buildString {
        var cursor = 0
        while (cursor < value.length) {
            val char = value[cursor++]
            if (char != '\\' || cursor >= value.length) {
                append(char)
                continue
            }
            when (val escaped = value[cursor++]) {
                'n' -> append('\n')
                'r' -> append('\r')
                't' -> append('\t')
                'x' -> {
                    val end = (cursor + 2).coerceAtMost(value.length)
                    val digits = value.substring(cursor, end)
                    val code = digits.takeIf { it.length == 2 && it.all { char -> char.isHexDigit() } }?.toIntOrNull(16)
                    if (code == null) append('x')
                    else {
                        append(code.toChar())
                        cursor = end
                    }
                }
                'u' -> {
                    val close = if (value.getOrNull(cursor) == '{') value.indexOf('}', cursor + 1) else -1
                    val digits = if (close < 0) "" else value.substring(cursor + 1, close)
                    val code = digits.takeIf { it.length in 1..6 && it.all { char -> char.isHexDigit() } }?.toIntOrNull(16)
                    if (code == null || code > 0x10ffff) append('u')
                    else {
                        appendCodePoint(code)
                        cursor = close + 1
                    }
                }
                else -> append(escaped)
            }
        }
    }

    private fun Char.isHexDigit(): Boolean = this in '0'..'9' || this in 'a'..'f' || this in 'A'..'F'
}
