package dev.pacmon.jetbrains.core

private enum class RubyTokenKind { WORD, SYMBOL, STRING, PUNCTUATION, NEWLINE }

private data class RubyToken(
    val kind: RubyTokenKind,
    val value: String,
    val start: Int,
    val end: Int,
    val contentStart: Int? = null,
    val contentEnd: Int? = null,
    val literal: Boolean = false,
)

private data class RubyBlock(
    val kind: Kind,
    val values: List<String> = emptyList(),
    val receiver: String? = null,
) {
    enum class Kind { GROUP, PLATFORM, DEFINITION, GEMSPEC, GENERIC }
}

/** Static Gemfile/gems.rb/gemspec parser. Depos never invokes Ruby or Bundler. */
object RubyManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.RUBY
    override val fileNames = listOf("Gemfile", "gems.rb")
    override val discoveryGlobs = listOf("**/Gemfile", "**/gems.rb", "**/*.gemspec")
    override val notesRelativePath = ".depos/ruby/DEPENDENCY-NOTES.md"
    override fun matchesPath(path: String): Boolean {
        val name = path.replace('\\', '/').substringAfterLast('/')
        return name == "Gemfile" || name == "gems.rb" || name.endsWith(".gemspec")
    }
    override fun normalizeNoteKey(raw: String): String = ManifestRegistry.stripName(raw)

    private val gemName = Regex("^[A-Za-z0-9._-]+$")
    private val definitionWords = setOf("def", "class", "module")
    private val blockWords = setOf("if", "unless", "case", "begin", "while", "until", "for")
    private val gemspecMethods = mapOf(
        "add_dependency" to "runtime",
        "add_runtime_dependency" to "runtime",
        "add_development_dependency" to "development",
    )

    override fun extractDependencies(text: String): List<DependencyEntry> = extractDependencies(text, "Gemfile")

    override fun extractDependencies(text: String, path: String): List<DependencyEntry> {
        val gemspec = path.replace('\\', '/').substringAfterLast('/').endsWith(".gemspec")
        val dependencies = mutableListOf<DependencyEntry>()
        val blocks = mutableListOf<RubyBlock>()
        for (statement in statements(tokenize(text))) {
            var start = 0
            while (statement.getOrNull(start)?.value == "end") {
                if (blocks.isNotEmpty()) blocks.removeAt(blocks.lastIndex)
                start++
            }
            val body = statement.drop(start)
            if (body.isEmpty()) continue
            val dependency = if (gemspec) gemspecDependency(body, blocks) else gemfileDependency(body, blocks)
            if (dependency != null) dependencies += dependency
            openedBlock(body)?.let(blocks::add)
        }
        return dependencies
    }

    fun uniqueDependencies(dependencies: List<DependencyEntry>): List<DependencyEntry> {
        val seen = mutableSetOf<String>()
        return dependencies.filter { seen.add(it.noteKey) }
    }

    private fun skipQuoted(text: String, start: Int, quote: Char): Int {
        var cursor = start + 1
        while (cursor < text.length) {
            if (text[cursor] == '\\' && cursor + 1 < text.length) {
                cursor += 2
                continue
            }
            if (text[cursor] == quote) return cursor + 1
            if (text[cursor] == '\n' || text[cursor] == '\r') return cursor
            cursor++
        }
        return cursor
    }

    private fun skipPercentLiteral(text: String, start: Int): Int? {
        if (text.getOrNull(start) != '%') return null
        var cursor = start + 1
        if (text.getOrNull(cursor) in setOf('q', 'Q', 'r', 'w', 'W', 'i', 'I', 'x', 's')) cursor++
        val opening = text.getOrNull(cursor) ?: return null
        if (opening.isLetterOrDigit() || opening == '_' || opening.isWhitespace()) return null
        val closing = mapOf('(' to ')', '[' to ']', '{' to '}', '<' to '>')[opening] ?: opening
        val balanced = closing != opening
        var depth = 1
        cursor++
        while (cursor < text.length) {
            val char = text[cursor]
            if (char == '\\' && cursor + 1 < text.length) {
                cursor += 2
                continue
            }
            if (balanced && char == opening) depth++
            if (char == closing && --depth == 0) return cursor + 1
            cursor++
        }
        return cursor
    }

    private fun skipHeredoc(text: String, start: Int): Int? {
        val match = Regex("^<<[-~]?(?:(['\"`])([A-Za-z_][A-Za-z0-9_]*)\\1|([A-Za-z_][A-Za-z0-9_]*))")
            .find(text.substring(start)) ?: return null
        val delimiter = match.groups[2]?.value ?: match.groups[3]?.value ?: return null
        val firstNewline = text.indexOf('\n', start + match.value.length)
        if (firstNewline < 0) return text.length
        var cursor = firstNewline + 1
        while (cursor <= text.length) {
            val newline = text.indexOf('\n', cursor)
            val end = if (newline < 0) text.length else newline
            if (text.substring(cursor, end).trimEnd('\r').trim() == delimiter) {
                return if (newline < 0) end else newline + 1
            }
            if (newline < 0) return text.length
            cursor = newline + 1
        }
        return text.length
    }

    private fun tokenize(text: String): List<RubyToken> {
        val tokens = mutableListOf<RubyToken>()
        var cursor = 0
        var lineStart = true
        while (cursor < text.length) {
            val char = text[cursor]
            if (char == '\r' && text.getOrNull(cursor + 1) == '\n') {
                tokens += RubyToken(RubyTokenKind.NEWLINE, "\n", cursor, cursor + 2)
                cursor += 2
                lineStart = true
                continue
            }
            if (char == '\n' || char == '\r') {
                tokens += RubyToken(RubyTokenKind.NEWLINE, "\n", cursor, cursor + 1)
                cursor++
                lineStart = true
                continue
            }
            if (char.isWhitespace()) {
                cursor++
                continue
            }
            if (lineStart && text.startsWith("=begin", cursor) && text.getOrNull(cursor + 6)?.let { it.isWhitespace() } != false) {
                val end = Regex("(?m)^=end(?:\\s|$)").find(text, cursor + 6)
                cursor = end?.range?.last?.plus(1) ?: text.length
                tokens += RubyToken(RubyTokenKind.NEWLINE, "\n", cursor, cursor)
                lineStart = true
                continue
            }
            lineStart = false
            if (char == '#') {
                while (cursor < text.length && text[cursor] != '\n' && text[cursor] != '\r') cursor++
                continue
            }
            val heredocEnd = if (text.startsWith("<<", cursor)) skipHeredoc(text, cursor) else null
            if (heredocEnd != null) {
                cursor = heredocEnd
                tokens += RubyToken(RubyTokenKind.NEWLINE, "\n", cursor, cursor)
                lineStart = true
                continue
            }
            val percentEnd = skipPercentLiteral(text, cursor)
            if (percentEnd != null) {
                tokens += RubyToken(RubyTokenKind.STRING, "", cursor, percentEnd)
                cursor = percentEnd
                continue
            }
            if (char == '/' && text.indexOf('/', cursor + 1) >= 0) {
                var end = cursor + 1
                while (end < text.length && text[end] != '\n' && text[end] != '\r') {
                    if (text[end] == '\\' && end + 1 < text.length) end += 2
                    else if (text[end++] == '/') break
                }
                tokens += RubyToken(RubyTokenKind.STRING, "", cursor, end)
                cursor = end
                continue
            }
            if (char == '"' || char == '\'') {
                val end = skipQuoted(text, cursor, char)
                val closed = text.getOrNull(end - 1) == char
                val contentEnd = if (closed) end - 1 else end
                val raw = text.substring(cursor + 1, contentEnd)
                val literal = closed && '\\' !in raw && (char == '\'' || "#{" !in raw)
                tokens += RubyToken(RubyTokenKind.STRING, raw, cursor, end, cursor + 1, contentEnd, literal)
                cursor = end
                continue
            }
            if (char == ':' && text.getOrNull(cursor + 1)?.let { it == '_' || it.isLetter() } == true) {
                val start = cursor++
                val valueStart = cursor
                while (text.getOrNull(cursor)?.let { it == '_' || it == '!' || it == '?' || it.isLetterOrDigit() } == true) cursor++
                tokens += RubyToken(RubyTokenKind.SYMBOL, text.substring(valueStart, cursor), start, cursor)
                continue
            }
            if (char == '_' || char.isLetter()) {
                val start = cursor++
                while (text.getOrNull(cursor)?.let { it == '_' || it == '!' || it == '?' || it.isLetterOrDigit() } == true) cursor++
                tokens += RubyToken(RubyTokenKind.WORD, text.substring(start, cursor), start, cursor)
                continue
            }
            val pair = text.substring(cursor, minOf(cursor + 2, text.length))
            if (pair in setOf("=>", "::", "->")) {
                tokens += RubyToken(RubyTokenKind.PUNCTUATION, pair, cursor, cursor + 2)
                cursor += 2
                continue
            }
            tokens += RubyToken(RubyTokenKind.PUNCTUATION, char.toString(), cursor, cursor + 1)
            cursor++
        }
        return tokens
    }

    private fun statements(tokens: List<RubyToken>): List<List<RubyToken>> {
        val out = mutableListOf<List<RubyToken>>()
        var current = mutableListOf<RubyToken>()
        val stack = mutableListOf<Char>()
        val closeFor = mapOf('(' to ')', '[' to ']', '{' to '}')
        fun flush() {
            if (current.isNotEmpty()) out += current
            current = mutableListOf()
        }
        for (token in tokens) {
            if ((token.kind == RubyTokenKind.NEWLINE || token.value == ";") && stack.isEmpty()) {
                flush()
                continue
            }
            if (token.kind == RubyTokenKind.NEWLINE) continue
            current += token
            val char = token.value.singleOrNull()
            val close = char?.let(closeFor::get)
            if (close != null) stack += close
            else if (char != null && char == stack.lastOrNull()) stack.removeAt(stack.lastIndex)
        }
        flush()
        return out
    }

    private fun literalValues(tokens: List<RubyToken>, start: Int): List<String> {
        val token = tokens.getOrNull(start) ?: return emptyList()
        if (token.kind == RubyTokenKind.SYMBOL) return listOf(token.value)
        if (token.kind == RubyTokenKind.STRING && token.literal) return listOf(token.value)
        if (token.value != "[") return emptyList()
        val values = mutableListOf<String>()
        for (index in start + 1 until tokens.size) {
            val item = tokens[index]
            if (item.value == "]") break
            if (item.value == ",") continue
            if (item.kind != RubyTokenKind.SYMBOL && !(item.kind == RubyTokenKind.STRING && item.literal)) return emptyList()
            values += item.value
        }
        return values
    }

    private fun optionValues(tokens: List<RubyToken>, names: Set<String>): List<String> {
        for (index in 0 until (tokens.size - 2).coerceAtLeast(0)) {
            val token = tokens[index]
            val modern = token.kind == RubyTokenKind.WORD && token.value in names && tokens[index + 1].value == ":"
            val legacy = token.kind == RubyTokenKind.SYMBOL && token.value in names && tokens[index + 1].value == "=>"
            if (modern || legacy) return literalValues(tokens, index + 2)
        }
        return emptyList()
    }

    private fun gemfileDependency(tokens: List<RubyToken>, blocks: List<RubyBlock>): DependencyEntry? {
        if (blocks.any { it.kind == RubyBlock.Kind.DEFINITION }) return null
        val call = tokens.firstOrNull()
        if (call?.kind != RubyTokenKind.WORD || call.value != "gem") return null
        val nameIndex = if (tokens.getOrNull(1)?.value == "(") 2 else 1
        val name = tokens.getOrNull(nameIndex)
        if (name?.kind != RubyTokenKind.STRING || !name.literal || !gemName.matches(name.value)) return null
        val contentStart = name.contentStart ?: return null
        val contentEnd = name.contentEnd ?: return null
        val groups = (blocks.filter { it.kind == RubyBlock.Kind.GROUP }.flatMap { it.values } +
            optionValues(tokens.drop(nameIndex + 1), setOf("group", "groups"))).distinct()
        val platforms = (blocks.filter { it.kind == RubyBlock.Kind.PLATFORM }.flatMap { it.values } +
            optionValues(tokens.drop(nameIndex + 1), setOf("platform", "platforms"))).distinct()
        val scope = (if (groups.isEmpty()) "default" else groups.joinToString(",")) +
            if (platforms.isEmpty()) "" else "@${platforms.joinToString(",")}"
        return dependencyEntry(
            name.value,
            scope,
            SourceRange(contentStart, contentEnd - contentStart),
            listOf(SourceRange(name.start, name.end - name.start)),
            name.value,
            SourceRange(call.start, call.end - call.start),
        )
    }

    private fun gemspecDependency(tokens: List<RubyToken>, blocks: List<RubyBlock>): DependencyEntry? {
        val specIndex = blocks.indexOfLast { it.kind == RubyBlock.Kind.GEMSPEC }
        if (specIndex < 0 || blocks.drop(specIndex + 1).any { it.kind == RubyBlock.Kind.DEFINITION }) return null
        val receiverName = blocks[specIndex].receiver ?: return null
        val receiver = tokens.getOrNull(0)
        val method = tokens.getOrNull(2)
        if (receiver?.kind != RubyTokenKind.WORD || receiver.value != receiverName || tokens.getOrNull(1)?.value != "." || method?.kind != RubyTokenKind.WORD) return null
        val scope = gemspecMethods[method.value] ?: return null
        val nameIndex = if (tokens.getOrNull(3)?.value == "(") 4 else 3
        val name = tokens.getOrNull(nameIndex)
        if (name?.kind != RubyTokenKind.STRING || !name.literal || !gemName.matches(name.value)) return null
        val contentStart = name.contentStart ?: return null
        val contentEnd = name.contentEnd ?: return null
        return dependencyEntry(
            name.value,
            scope,
            SourceRange(contentStart, contentEnd - contentStart),
            listOf(SourceRange(name.start, name.end - name.start)),
            name.value,
            SourceRange(method.start, method.end - method.start),
        )
    }

    private fun openedBlock(tokens: List<RubyToken>): RubyBlock? {
        val first = tokens.firstOrNull() ?: return null
        if (first.value in definitionWords) return RubyBlock(RubyBlock.Kind.DEFINITION)
        if (first.value in blockWords) return RubyBlock(RubyBlock.Kind.GENERIC)
        val doIndex = tokens.indexOfFirst { it.kind == RubyTokenKind.WORD && it.value == "do" }
        if (doIndex < 0) return null
        if (first.kind == RubyTokenKind.WORD && first.value == "group") {
            return RubyBlock(RubyBlock.Kind.GROUP, tokens.subList(1, doIndex).filter { it.kind == RubyTokenKind.SYMBOL }.map { it.value })
        }
        if (first.kind == RubyTokenKind.WORD && first.value in setOf("platform", "platforms")) {
            return RubyBlock(RubyBlock.Kind.PLATFORM, tokens.subList(1, doIndex).filter { it.kind == RubyTokenKind.SYMBOL }.map { it.value })
        }
        if (tokens.take(6).joinToString(" ") { it.value } == "Gem :: Specification . new do" &&
            tokens.getOrNull(6)?.value == "|" && tokens.getOrNull(7)?.kind == RubyTokenKind.WORD
        ) {
            return RubyBlock(RubyBlock.Kind.GEMSPEC, receiver = tokens[7].value)
        }
        return RubyBlock(RubyBlock.Kind.GENERIC)
    }
}
