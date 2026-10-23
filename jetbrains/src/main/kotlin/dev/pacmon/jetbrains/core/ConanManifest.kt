package dev.pacmon.jetbrains.core

/** Conan recipes, read statically: conanfile.txt by section, conanfile.py by token, never executed. */
object ConanManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.CONAN
    override val fileNames = listOf("conanfile.py", "conanfile.txt")
    override val notesRelativePath = ".pacmon/conan/DEPENDENCY-NOTES.md"
    override fun normalizeNoteKey(raw: String): String = ManifestRegistry.stripName(raw).lowercase()

    private val scopes = setOf("requires", "tool_requires", "test_requires", "build_requires")
    private val reference = Regex("^\\s*([A-Za-z0-9][A-Za-z0-9_+.-]*)/\\S+\\s*$")
    private val stringStart = Regex("^[rRuUbBfF]{0,2}(['\"])")
    private val sectionHeader = Regex("^\\s*\\[([^\\]]+)]\\s*$")
    private val commentLine = Regex("^\\s*[#;]")
    private val defLine = Regex("^(?:async\\s+)?def\\b.*:\\s*(?:#.*)?$")
    private val classLine = Regex("^class\\b.*:\\s*(?:#.*)?$")

    private enum class TokenKind { IDENTIFIER, STRING, PUNCTUATION, NEWLINE }
    private enum class BlockKind { CLASS, DEF }

    private data class Token(
        val kind: TokenKind,
        val value: String,
        val offset: Int,
        val line: Int,
        val contentOffset: Int? = null,
        val literal: Boolean = false,
    )

    override fun extractDependencies(text: String): List<DependencyEntry> = extractDependencies(text, "conanfile.py")

    override fun extractDependencies(text: String, path: String): List<DependencyEntry> =
        if (path.replace('\\', '/').substringAfterLast('/').lowercase() == "conanfile.txt") extractTextDependencies(text)
        else extractPythonDependencies(text)

    /** Reads the four dependency sections supported by Conan 1 and Conan 2 text manifests. */
    fun extractTextDependencies(text: String): List<DependencyEntry> {
        val out = mutableListOf<DependencyEntry>()
        var scope: String? = null
        var offset = 0
        for (rawLine in text.split('\n')) {
            val line = rawLine.removeSuffix("\r")
            val section = sectionHeader.matchEntire(line)
            if (section != null) {
                val candidate = section.groupValues[1].trim().lowercase()
                scope = candidate.takeIf { it in scopes }
            } else if (scope != null && line.isNotBlank() && !commentLine.containsMatchIn(line)) {
                val leading = line.length - line.trimStart().length
                val token = Token(
                    TokenKind.STRING,
                    line.trim(),
                    offset + leading,
                    line = 0,
                    contentOffset = offset + leading,
                    literal = true,
                )
                conanEntry(token, scope)?.let(out::add)
            }
            offset += rawLine.length + 1
        }
        return out
    }

    /** Reads literal Conan requirements without importing or executing conanfile.py. */
    fun extractPythonDependencies(text: String): List<DependencyEntry> {
        val tokens = tokenize(text)
        val contexts = lineContexts(text)
        val out = mutableListOf<DependencyEntry>()
        var i = 0
        while (i < tokens.size) {
            val token = tokens[i]
            val context = contexts.getOrElse(token.line) { emptySet() }

            if (
                token.kind == TokenKind.IDENTIFIER &&
                token.value in scopes &&
                tokens.getOrNull(i + 1)?.value == "=" &&
                BlockKind.CLASS in context &&
                BlockKind.DEF !in context
            ) {
                val end = statementEnd(tokens, i + 2)
                for (value in literalSequence(tokens, i + 2, end)) {
                    conanEntry(value, token.value)?.let(out::add)
                }
                i = maxOf(i, end - 1) + 1
                continue
            }

            val call = tokens.getOrNull(i + 2)
            if (
                token.kind == TokenKind.IDENTIFIER &&
                token.value == "self" &&
                tokens.getOrNull(i + 1)?.value == "." &&
                call?.kind == TokenKind.IDENTIFIER &&
                call.value in scopes &&
                tokens.getOrNull(i + 3)?.value == "(" &&
                BlockKind.CLASS in context
            ) {
                val value = tokens.getOrNull(i + 4)
                val after = tokens.getOrNull(i + 5)
                if (value?.kind == TokenKind.STRING && value.literal && (after?.value == ")" || after?.value == ",")) {
                    conanEntry(value, call.value)?.let(out::add)
                }
            }
            i++
        }
        return out
    }

    private fun conanEntry(token: Token, scope: String): DependencyEntry? {
        if (token.kind != TokenKind.STRING || !token.literal) return null
        val contentOffset = token.contentOffset ?: return null
        val name = reference.matchEntire(token.value)?.groupValues?.get(1)?.takeIf { it.isNotEmpty() } ?: return null
        val leading = token.value.length - token.value.trimStart().length
        val range = SourceRange(contentOffset + leading, name.length)
        return dependencyEntry(
            name.lowercase(),
            scope,
            range,
            displayName = name,
            iconRange = SourceRange(token.offset, 1),
        )
    }

    private fun isIdentifierChar(ch: Char): Boolean =
        ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch == '_'

    private fun tokenize(text: String): List<Token> {
        val tokens = mutableListOf<Token>()
        var i = 0
        var line = 0
        fun pushNewline() {
            tokens.add(Token(TokenKind.NEWLINE, "\n", i, line))
            i++
            line++
        }
        while (i < text.length) {
            val char = text[i]
            if (char == '\r' && text.getOrNull(i + 1) == '\n') {
                i++
                pushNewline()
                continue
            }
            if (char == '\n') {
                pushNewline()
                continue
            }
            if (char.isWhitespace()) {
                i++
                continue
            }
            if (char == '#') {
                while (i < text.length && text[i] != '\n' && text[i] != '\r') i++
                continue
            }

            val prefixMatch = stringStart.find(text.substring(i, minOf(i + 3, text.length)))
            val previous = text.getOrNull(i - 1)
            if (prefixMatch != null && (previous == null || !isIdentifierChar(previous))) {
                val prefixLength = prefixMatch.value.length - 1
                val quote = prefixMatch.groupValues[1]
                val tripleQuote = quote.repeat(3)
                val start = i
                val tokenLine = line
                i += prefixLength
                val triple = text.startsWith(tripleQuote, i)
                i += if (triple) 3 else 1
                val contentOffset = i
                var escaped = false
                while (i < text.length) {
                    if (!triple && (text[i] == '\n' || text[i] == '\r')) break
                    if (triple && text.startsWith(tripleQuote, i)) break
                    val current = text[i]
                    if (!triple && escaped) escaped = false
                    else if (!triple && current == '\\') escaped = true
                    else if (!triple && current == quote[0]) break
                    if (current == '\n') line++
                    i++
                }
                val contentEnd = i
                if (triple && text.startsWith(tripleQuote, i)) i += 3
                else if (!triple && text.getOrNull(i) == quote[0]) i++
                val prefix = text.substring(start, start + prefixLength).lowercase()
                val content = text.substring(contentOffset, contentEnd)
                tokens.add(
                    Token(
                        TokenKind.STRING,
                        content,
                        start,
                        tokenLine,
                        contentOffset = contentOffset,
                        literal = !triple && 'f' !in prefix && 'b' !in prefix && '\\' !in content,
                    ),
                )
                continue
            }
            if (char in 'A'..'Z' || char in 'a'..'z' || char == '_') {
                val start = i++
                while (i < text.length && isIdentifierChar(text[i])) i++
                tokens.add(Token(TokenKind.IDENTIFIER, text.substring(start, i), start, line))
                continue
            }
            tokens.add(Token(TokenKind.PUNCTUATION, char.toString(), i, line))
            i++
        }
        return tokens
    }

    private fun lineContexts(text: String): List<Set<BlockKind>> {
        val result = mutableListOf<Set<BlockKind>>()
        val stack = ArrayDeque<Pair<Int, BlockKind>>()
        for (raw in text.split(Regex("\r?\n"))) {
            val trimmed = raw.trim()
            if (trimmed.isEmpty() || trimmed.startsWith('#')) {
                result.add(stack.map { it.second }.toSet())
                continue
            }
            val indent = raw.takeWhile { it.isWhitespace() }.fold(0) { count, ch -> count + if (ch == '\t') 8 else 1 }
            while (stack.isNotEmpty() && indent <= stack.last().first) stack.removeLast()
            result.add(stack.map { it.second }.toSet())
            if (defLine.matches(trimmed)) stack.addLast(indent to BlockKind.DEF)
            else if (classLine.matches(trimmed)) stack.addLast(indent to BlockKind.CLASS)
        }
        return result
    }

    private fun statementEnd(tokens: List<Token>, start: Int): Int {
        var depth = 0
        for (i in start until tokens.size) {
            val token = tokens[i]
            if (token.kind == TokenKind.PUNCTUATION && token.value in setOf("[", "(", "{")) depth++
            else if (token.kind == TokenKind.PUNCTUATION && token.value in setOf("]", ")", "}")) depth--
            else if (token.kind == TokenKind.NEWLINE && depth == 0) return i
            else if (token.kind == TokenKind.PUNCTUATION && token.value == ";" && depth == 0) return i
        }
        return tokens.size
    }

    private fun literalSequence(tokens: List<Token>, start: Int, end: Int): List<Token> {
        if (start >= end) return emptyList()
        val significant = tokens.subList(start, end).filter { it.kind != TokenKind.NEWLINE }
        if (significant.isEmpty()) return emptyList()
        var left = 0
        var right = significant.size
        val closer = when (significant.first().value) {
            "[" -> "]"
            "(" -> ")"
            else -> null
        }
        if (closer != null) {
            if (significant.last().value != closer) return emptyList()
            left++
            right--
        }
        val values = mutableListOf<Token>()
        var expectValue = true
        for (token in significant.subList(left, maxOf(left, right))) {
            if (expectValue) {
                if (token.kind != TokenKind.STRING || !token.literal) return emptyList()
                values.add(token)
                expectValue = false
            } else {
                if (token.kind != TokenKind.PUNCTUATION || token.value != ",") return emptyList()
                expectValue = true
            }
        }
        return if (values.isNotEmpty() && (!expectValue || significant.getOrNull(right - 1)?.value == ",")) values
        else emptyList()
    }
}
