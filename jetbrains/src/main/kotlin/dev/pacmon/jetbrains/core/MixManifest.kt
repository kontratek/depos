package dev.pacmon.jetbrains.core

private enum class MixTokenKind { WORD, ATOM, LITERAL, SYMBOL }

private data class MixToken(
    val kind: MixTokenKind,
    val value: String,
    val start: Int,
    val end: Int,
    val contentStart: Int? = null,
    val contentEnd: Int? = null,
)

object MixManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.MIX
    override val fileNames = listOf("mix.exs")
    override val notesRelativePath = ".depos/mix/DEPENDENCY-NOTES.md"
    override fun normalizeNoteKey(raw: String): String = ManifestRegistry.stripName(raw)

    private val openToClose = mapOf('(' to ')', '[' to ']', '{' to '}')

    override fun extractDependencies(text: String): List<DependencyEntry> {
        val tokens = tokenize(text)
        val out = mutableListOf<DependencyEntry>()
        val seen = mutableSetOf<String>()
        for (open in literalListStarts(tokens)) {
            val close = matchingToken(tokens, open) ?: continue
            for (dependency in dependenciesFromList(tokens, open, close)) {
                if (seen.add("${dependency.scope}\u0000${dependency.noteKey}")) out.add(dependency)
            }
        }
        return out
    }

    private fun isWordStart(char: Char?): Boolean = char != null && (char == '_' || char.isLetter())
    private fun isWordPart(char: Char?): Boolean = char != null && (char == '_' || char == '@' || char == '!' || char == '?' || char.isLetterOrDigit())

    private fun decodeQuoted(value: String): String = buildString {
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
                else -> append(escaped)
            }
        }
    }

    private fun quotedEnd(text: String, start: Int, quote: Char): Int {
        val marker = if (text.startsWith(quote.toString().repeat(3), start)) quote.toString().repeat(3) else quote.toString()
        var cursor = start + marker.length
        while (cursor < text.length) {
            if (text.startsWith(marker, cursor)) return cursor + marker.length
            cursor += if (text[cursor] == '\\' && cursor + 1 < text.length) 2 else 1
        }
        return text.length
    }

    private fun sigilEnd(text: String, start: Int): Int? {
        if (text.getOrNull(start) != '~' || text.getOrNull(start + 1)?.isLetter() != true) return null
        val delimiterStart = start + 2
        val opening = text.getOrNull(delimiterStart) ?: return null
        if (opening.isLetterOrDigit() || opening == '_' || opening.isWhitespace()) return null
        if ((opening == '"' || opening == '\'') && text.startsWith(opening.toString().repeat(3), delimiterStart)) {
            var cursor = quotedEnd(text, delimiterStart, opening)
            while (text.getOrNull(cursor)?.isLetter() == true) cursor++
            return cursor
        }
        val closing = mapOf('(' to ')', '[' to ']', '{' to '}', '<' to '>')[opening] ?: opening
        var depth = if (opening == closing) 0 else 1
        var cursor = delimiterStart + 1
        while (cursor < text.length) {
            val char = text[cursor]
            if (char == '\\' && cursor + 1 < text.length) {
                cursor += 2
                continue
            }
            if (opening != closing && char == opening) depth++
            if (char == closing) {
                depth--
                if (opening == closing || depth == 0) {
                    cursor++
                    while (text.getOrNull(cursor)?.isLetter() == true) cursor++
                    return cursor
                }
            }
            cursor++
        }
        return text.length
    }

    private fun tokenize(text: String): List<MixToken> {
        val tokens = mutableListOf<MixToken>()
        var cursor = 0
        while (cursor < text.length) {
            val char = text[cursor]
            if (char.isWhitespace()) {
                cursor++
                continue
            }
            if (char == '#') {
                while (cursor < text.length && text[cursor] != '\n') cursor++
                continue
            }
            val endOfSigil = sigilEnd(text, cursor)
            if (endOfSigil != null) {
                tokens.add(MixToken(MixTokenKind.LITERAL, text.substring(cursor, endOfSigil), cursor, endOfSigil))
                cursor = endOfSigil
                continue
            }
            if (char == ':' && text.getOrNull(cursor + 1) in setOf('"', '\'')) {
                val quote = text[cursor + 1]
                val quotedStart = cursor + 1
                val end = quotedEnd(text, quotedStart, quote)
                val markerWidth = if (text.startsWith(quote.toString().repeat(3), quotedStart)) 3 else 1
                val contentStart = quotedStart + markerWidth
                val contentEnd = (end - markerWidth).coerceAtLeast(contentStart)
                tokens.add(
                    MixToken(
                        MixTokenKind.ATOM,
                        decodeQuoted(text.substring(contentStart, contentEnd)),
                        cursor,
                        end,
                        contentStart,
                        contentEnd,
                    ),
                )
                cursor = end
                continue
            }
            if (char == ':' && isWordStart(text.getOrNull(cursor + 1))) {
                var end = cursor + 2
                while (isWordPart(text.getOrNull(end))) end++
                tokens.add(MixToken(MixTokenKind.ATOM, text.substring(cursor + 1, end), cursor, end, cursor + 1, end))
                cursor = end
                continue
            }
            if (char == '"' || char == '\'') {
                val end = quotedEnd(text, cursor, char)
                tokens.add(MixToken(MixTokenKind.LITERAL, text.substring(cursor, end), cursor, end))
                cursor = end
                continue
            }
            if (isWordStart(char)) {
                var end = cursor + 1
                while (isWordPart(text.getOrNull(end))) end++
                tokens.add(MixToken(MixTokenKind.WORD, text.substring(cursor, end), cursor, end))
                cursor = end
                continue
            }
            tokens.add(MixToken(MixTokenKind.SYMBOL, char.toString(), cursor, cursor + 1))
            cursor++
        }
        return tokens
    }

    private fun matchingToken(tokens: List<MixToken>, openIndex: Int): Int? {
        val wanted = tokens.getOrNull(openIndex)?.value?.singleOrNull()?.let(openToClose::get) ?: return null
        val stack = mutableListOf(wanted)
        for (index in openIndex + 1 until tokens.size) {
            val value = tokens[index].value.singleOrNull()
            val nested = value?.let(openToClose::get)
            if (nested != null) stack.add(nested)
            else if (value == stack.lastOrNull()) {
                stack.removeAt(stack.lastIndex)
                if (stack.isEmpty()) return index
            }
        }
        return null
    }

    private fun literalListStarts(tokens: List<MixToken>): List<Int> {
        val starts = sortedSetOf<Int>()
        val ancestors = mutableListOf<Char>()
        for (index in tokens.indices) {
            val token = tokens[index]
            if (
                '}' !in ancestors &&
                token.kind == MixTokenKind.WORD && token.value == "deps" &&
                tokens.getOrNull(index + 1)?.value == ":" && tokens.getOrNull(index + 2)?.value == "["
            ) {
                starts.add(index + 2)
            }
            if (token.kind == MixTokenKind.WORD && token.value in setOf("def", "defp")) {
                if (tokens.getOrNull(index + 1)?.kind == MixTokenKind.WORD && tokens[index + 1].value == "deps") {
                    var cursor = index + 2
                    if (tokens.getOrNull(cursor)?.value == "(") {
                        val close = matchingToken(tokens, cursor)
                        cursor = if (close != null && close == cursor + 1) close + 1 else -1
                    }
                    if (tokens.getOrNull(cursor)?.value == ",") cursor++
                    if (tokens.getOrNull(cursor)?.value == "do") {
                        cursor++
                        if (tokens.getOrNull(cursor)?.value == ":") cursor++
                        if (tokens.getOrNull(cursor)?.value == "[") starts.add(cursor)
                    }
                }
            }
            val value = token.value.singleOrNull()
            val nested = value?.let(openToClose::get)
            if (nested != null) ancestors.add(nested)
            else if (value != null && value == ancestors.lastOrNull()) ancestors.removeAt(ancestors.lastIndex)
        }
        return starts.toList()
    }

    private fun atomsFromOption(tokens: List<MixToken>, name: String): List<String>? {
        val stack = mutableListOf<Char>()
        for (index in 0 until (tokens.size - 2).coerceAtLeast(0)) {
            val token = tokens[index]
            if (stack.isEmpty() && token.kind == MixTokenKind.WORD && token.value == name && tokens[index + 1].value == ":") {
                val value = tokens[index + 2]
                if (value.kind == MixTokenKind.ATOM) return listOf(value.value)
                if (value.value != "[") return null
                val close = matchingToken(tokens, index + 2) ?: return null
                val atoms = mutableListOf<String>()
                for (itemIndex in index + 3 until close) {
                    val item = tokens[itemIndex]
                    if (item.kind == MixTokenKind.ATOM) atoms.add(item.value)
                    else if (item.value != ",") return null
                }
                return if (atoms.isEmpty()) null else atoms
            }
            val symbol = token.value.singleOrNull()
            val nested = symbol?.let(openToClose::get)
            if (nested != null) stack.add(nested)
            else if (symbol != null && symbol == stack.lastOrNull()) stack.removeAt(stack.lastIndex)
        }
        return null
    }

    private fun dependencyFromTuple(tokens: List<MixToken>): DependencyEntry? {
        if (tokens.size < 4 || tokens.first().value != "{" || tokens.last().value != "}") return null
        val atom = tokens[1]
        if (atom.kind != MixTokenKind.ATOM || tokens[2].value != ",") return null
        val options = tokens.subList(3, tokens.lastIndex)
        val environments = atomsFromOption(options, "only")
        val targets = atomsFromOption(options, "targets")
        val scope = buildString {
            append("deps")
            if (environments != null) append(':').append(environments.joinToString(","))
            if (targets != null) append('@').append(targets.joinToString(","))
        }
        val primaryStart = atom.contentStart ?: atom.start
        val primaryEnd = atom.contentEnd ?: atom.end
        return dependencyEntry(
            atom.value,
            scope,
            SourceRange(primaryStart, primaryEnd - primaryStart),
            listOf(SourceRange(atom.start, atom.end - atom.start)),
            atom.value,
            SourceRange(tokens.first().start, 1),
        )
    }

    private fun dependenciesFromList(tokens: List<MixToken>, open: Int, close: Int): List<DependencyEntry> {
        val out = mutableListOf<DependencyEntry>()
        val stack = mutableListOf<Char>()
        var elementStart = open + 1
        fun visit(end: Int) {
            dependencyFromTuple(tokens.subList(elementStart, end))?.let(out::add)
        }
        for (index in open + 1 until close) {
            val value = tokens[index].value.singleOrNull()
            val nested = value?.let(openToClose::get)
            if (nested != null) stack.add(nested)
            else if (value == stack.lastOrNull()) stack.removeAt(stack.lastIndex)
            else if (value == ',' && stack.isEmpty()) {
                visit(index)
                elementStart = index + 1
            }
        }
        visit(close)
        return out
    }
}
