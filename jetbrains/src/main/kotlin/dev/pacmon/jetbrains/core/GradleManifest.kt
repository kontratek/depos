package dev.pacmon.jetbrains.core

private enum class GradleTokenKind { IDENTIFIER, STRING, SYMBOL, NEWLINE }

private data class GradleToken(
    val kind: GradleTokenKind,
    val value: String,
    val start: Int,
    val end: Int,
    val contentStart: Int? = null,
)

private data class ParsedGradleDependency(
    val noteKey: String,
    val primaryRange: SourceRange,
    val sourceRanges: List<SourceRange>,
)

/**
 * Static Groovy/Kotlin DSL reader. Gradle scripts are executable programs, so
 * Depos deliberately reads only source-visible dependency declarations and
 * never evaluates a script or invokes Gradle.
 */
object GradleManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.GRADLE
    override val fileNames = listOf("build.gradle.kts", "build.gradle")
    override val notesRelativePath = ".depos/gradle/DEPENDENCY-NOTES.md"

    override fun normalizeNoteKey(raw: String): String = ManifestRegistry.stripName(raw)

    override fun extractDependencies(text: String): List<DependencyEntry> {
        val tokens = tokenizeGradle(text)
        val result = mutableListOf<DependencyEntry>()
        val blocks = mutableListOf<String>()
        var index = 0
        while (index < tokens.size) {
            val token = tokens[index]
            when (token.value) {
                "}" -> {
                    if (blocks.isNotEmpty()) blocks.removeAt(blocks.lastIndex)
                    index++
                    continue
                }
                "{" -> {
                    val previous = tokens.getOrNull(index - 1)
                    blocks.add(if (previous?.kind == GradleTokenKind.IDENTIFIER) previous.value else "")
                    index++
                    continue
                }
            }
            if (token.kind != GradleTokenKind.IDENTIFIER || token.value != "dependencies" || "buildscript" in blocks) {
                index++
                continue
            }
            val open = nextGradleCode(tokens, index + 1)
            if (tokens.getOrNull(open)?.value != "{") {
                index++
                continue
            }
            val close = matchingGradle(tokens, open, tokens.size, "{", "}")
            if (close == null) {
                index++
                continue
            }
            result.addAll(parseDependencyBody(tokens, open + 1, close))
            index = close + 1
        }
        return result
    }
}

private val gradleWrappers = setOf("platform", "enforcedPlatform", "testFixtures")
private val nonLibraryCatalogs = setOf("bundles", "plugins", "versions")
private val nonConfigurations = setOf("val", "var", "def", "if", "for", "while", "when", "return", "println")
private val nonModuleFactories = setOf("project", "files", "fileTree", "gradleApi", "localGroovy")

private fun tokenizeGradle(text: String): List<GradleToken> {
    val tokens = mutableListOf<GradleToken>()
    var index = 0
    while (index < text.length) {
        val start = index
        val char = text[index]
        if (char == '\r' || char == '\n') {
            if (char == '\r' && text.getOrNull(index + 1) == '\n') index++
            index++
            tokens.add(GradleToken(GradleTokenKind.NEWLINE, "\n", start, index))
            continue
        }
        if (char.isWhitespace()) {
            index++
            continue
        }
        if (char == '/' && text.getOrNull(index + 1) == '/') {
            index += 2
            while (index < text.length && text[index] != '\r' && text[index] != '\n') index++
            continue
        }
        if (char == '/' && text.getOrNull(index + 1) == '*') {
            index += 2
            while (index < text.length && !(text[index] == '*' && text.getOrNull(index + 1) == '/')) {
                if (text[index] == '\r' || text[index] == '\n') {
                    val lineStart = index
                    if (text[index] == '\r' && text.getOrNull(index + 1) == '\n') index++
                    index++
                    tokens.add(GradleToken(GradleTokenKind.NEWLINE, "\n", lineStart, index))
                } else {
                    index++
                }
            }
            if (index < text.length) index += 2
            continue
        }
        if (char == '"' || char == '\'') {
            val triple = text.regionMatches(index, char.toString().repeat(3), 0, 3)
            val width = if (triple) 3 else 1
            index += width
            val contentStart = index
            while (index < text.length) {
                if (triple && text.regionMatches(index, char.toString().repeat(3), 0, 3)) break
                if (!triple && text[index] == char) break
                if (!triple && text[index] == '\\' && index + 1 < text.length) index += 2 else index++
            }
            val contentEnd = index
            if (index < text.length) index += width
            tokens.add(
                GradleToken(
                    GradleTokenKind.STRING,
                    text.substring(contentStart, contentEnd),
                    start,
                    index,
                    contentStart,
                ),
            )
            continue
        }
        if (char.isLetter() || char == '_' || char == '$') {
            index++
            while (index < text.length && (text[index].isLetterOrDigit() || text[index] == '_' || text[index] == '$')) index++
            tokens.add(GradleToken(GradleTokenKind.IDENTIFIER, text.substring(start, index), start, index))
            continue
        }
        index++
        tokens.add(GradleToken(GradleTokenKind.SYMBOL, char.toString(), start, index))
    }
    return tokens
}

private fun nextGradleCode(tokens: List<GradleToken>, from: Int, end: Int = tokens.size): Int {
    var index = from
    while (index < end && tokens[index].kind == GradleTokenKind.NEWLINE) index++
    return index
}

private fun matchingGradle(
    tokens: List<GradleToken>,
    open: Int,
    end: Int,
    left: String,
    right: String,
): Int? {
    var depth = 0
    for (index in open until end) {
        val token = tokens[index]
        if (token.kind != GradleTokenKind.SYMBOL) continue
        if (token.value == left) depth++
        else if (token.value == right) {
            depth--
            if (depth == 0) return index
        }
    }
    return null
}

private fun decodeGradleString(value: String): String {
    val result = StringBuilder()
    var index = 0
    while (index < value.length) {
        if (value[index] != '\\' || index + 1 >= value.length) {
            result.append(value[index++])
            continue
        }
        val escaped = value[index + 1]
        result.append(
            when (escaped) {
                'n' -> '\n'
                'r' -> '\r'
                't' -> '\t'
                else -> escaped
            },
        )
        index += 2
    }
    return result.toString()
}

private fun stringRange(token: GradleToken, start: Int = 0, length: Int = token.value.length) =
    SourceRange((token.contentStart ?: token.start) + start, length)

private fun coordinateFrom(token: GradleToken): ParsedGradleDependency? {
    if (token.kind != GradleTokenKind.STRING) return null
    val first = token.value.indexOf(':')
    val second = token.value.indexOf(':', first + 1)
    val end = if (second == -1) token.value.length else second
    if (first <= 0 || end <= first + 1) return null
    val group = decodeGradleString(token.value.substring(0, first))
    val artifact = decodeGradleString(token.value.substring(first + 1, end))
    if (group.isEmpty() || artifact.isEmpty()) return null
    val groupRange = stringRange(token, 0, first)
    val artifactRange = stringRange(token, first + 1, end - first - 1)
    return ParsedGradleDependency("$group:$artifact", artifactRange, listOf(groupRange, artifactRange))
}

private fun mapNotation(tokens: List<GradleToken>, start: Int, end: Int): ParsedGradleDependency? {
    var group: GradleToken? = null
    var name: GradleToken? = null
    for (index in start until end) {
        val key = tokens[index]
        if (key.kind != GradleTokenKind.IDENTIFIER || key.value !in setOf("group", "name")) continue
        val separator = nextGradleCode(tokens, index + 1, end)
        if (tokens.getOrNull(separator)?.value !in setOf(":", "=")) continue
        val valueIndex = nextGradleCode(tokens, separator + 1, end)
        val value = tokens.getOrNull(valueIndex)
        if (value?.kind != GradleTokenKind.STRING) continue
        if (key.value == "group") group = value else name = value
    }
    val groupToken = group ?: return null
    val nameToken = name ?: return null
    val groupName = decodeGradleString(groupToken.value)
    val artifactName = decodeGradleString(nameToken.value)
    if (groupName.isEmpty() || artifactName.isEmpty()) return null
    val groupRange = stringRange(groupToken)
    val nameRange = stringRange(nameToken)
    return ParsedGradleDependency("$groupName:$artifactName", nameRange, listOf(groupRange, nameRange))
}

private fun catalogAlias(tokens: List<GradleToken>, start: Int, end: Int): ParsedGradleDependency? {
    for (index in start until end) {
        val root = tokens[index]
        if (root.kind != GradleTokenKind.IDENTIFIER || root.value != "libs") continue
        val parts = mutableListOf("libs")
        var last = root
        var cursor = index + 1
        while (cursor + 1 < end && tokens[cursor].value == "." && tokens[cursor + 1].kind == GradleTokenKind.IDENTIFIER) {
            val part = tokens[cursor + 1]
            if (part.value == "get" && tokens.getOrNull(nextGradleCode(tokens, cursor + 2, end))?.value == "(") break
            parts.add(part.value)
            last = part
            cursor += 2
        }
        if (parts.size < 2 || parts[1] in nonLibraryCatalogs) continue
        val range = SourceRange(root.start, last.end - root.start)
        return ParsedGradleDependency(parts.joinToString("."), range, listOf(range))
    }
    return null
}

private fun parseExpression(tokens: List<GradleToken>, start: Int, end: Int): ParsedGradleDependency? {
    if ((start until end).any { tokens[it].kind == GradleTokenKind.IDENTIFIER && tokens[it].value in nonModuleFactories }) {
        return null
    }
    mapNotation(tokens, start, end)?.let { return it }
    catalogAlias(tokens, start, end)?.let { return it }
    for (index in start until end) {
        val token = tokens[index]
        if (token.kind == GradleTokenKind.STRING) coordinateFrom(token)?.let { return it }
        if (token.kind == GradleTokenKind.IDENTIFIER && token.value in gradleWrappers) {
            val open = nextGradleCode(tokens, index + 1, end)
            if (tokens.getOrNull(open)?.value == "(") {
                val close = matchingGradle(tokens, open, end, "(", ")")
                if (close != null) parseExpression(tokens, open + 1, close)?.let { return it }
            }
        }
    }
    return null
}

private fun topLevelComma(tokens: List<GradleToken>, start: Int, end: Int): Int? {
    var parens = 0
    var brackets = 0
    for (index in start until end) {
        when (tokens[index].value) {
            "(" -> parens++
            ")" -> parens--
            "[" -> brackets++
            "]" -> brackets--
            "," -> if (parens == 0 && brackets == 0) return index
        }
    }
    return null
}

private fun parseDependencyBody(tokens: List<GradleToken>, start: Int, end: Int): List<DependencyEntry> {
    val result = mutableListOf<DependencyEntry>()
    var index = start
    var braceDepth = 0
    while (index < end) {
        val token = tokens[index]
        if (token.value == "{") {
            braceDepth++
            index++
            continue
        }
        if (token.value == "}") {
            braceDepth--
            index++
            continue
        }
        if (braceDepth != 0 || token.kind !in setOf(GradleTokenKind.IDENTIFIER, GradleTokenKind.STRING)) {
            index++
            continue
        }
        val configuration = token
        if (configuration.kind == GradleTokenKind.IDENTIFIER && configuration.value in nonConfigurations) {
            while (index < end && tokens[index].kind != GradleTokenKind.NEWLINE && tokens[index].value != ";") index++
            index++
            continue
        }
        val afterName = nextGradleCode(tokens, index + 1, end)
        if (tokens.getOrNull(afterName)?.value == "{") {
            index++
            continue
        }

        var expressionStart = afterName
        var expressionEnd: Int
        val statementEnd: Int
        if (tokens.getOrNull(afterName)?.value == "(") {
            val close = matchingGradle(tokens, afterName, end, "(", ")")
            if (close == null) {
                index++
                continue
            }
            expressionStart = afterName + 1
            expressionEnd = close
            statementEnd = close + 1
        } else {
            var parens = 0
            var brackets = 0
            var cursor = afterName
            while (cursor < end) {
                val current = tokens[cursor]
                when (current.value) {
                    "(" -> parens++
                    ")" -> parens--
                    "[" -> brackets++
                    "]" -> brackets--
                }
                if (parens == 0 && brackets == 0 &&
                    (current.kind == GradleTokenKind.NEWLINE || current.value in setOf(";", "{"))
                ) break
                cursor++
            }
            expressionEnd = cursor
            statementEnd = cursor
        }

        var scope = if (configuration.kind == GradleTokenKind.STRING) {
            decodeGradleString(configuration.value)
        } else {
            configuration.value
        }
        if (scope == "add") {
            val comma = topLevelComma(tokens, expressionStart, expressionEnd)
            val scopeToken = tokens.getOrNull(nextGradleCode(tokens, expressionStart, expressionEnd))
            if (comma == null || scopeToken?.kind != GradleTokenKind.STRING) {
                index = maxOf(statementEnd, index + 1)
                continue
            }
            scope = decodeGradleString(scopeToken.value)
            expressionStart = comma + 1
        }

        parseExpression(tokens, expressionStart, expressionEnd)?.let { parsed ->
            if (scope.isNotEmpty()) {
                result.add(
                    dependencyEntry(
                        parsed.noteKey,
                        scope,
                        parsed.primaryRange,
                        parsed.sourceRanges,
                        parsed.noteKey,
                        SourceRange(configuration.start, configuration.end - configuration.start),
                    ),
                )
            }
        }
        index = maxOf(statementEnd, index + 1)
    }
    return result
}
