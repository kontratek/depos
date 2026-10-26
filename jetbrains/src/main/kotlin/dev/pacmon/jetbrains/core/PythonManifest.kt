package dev.pacmon.jetbrains.core

/** Static Python dependency parsers. Depos never invokes Python, pip, Poetry, uv, or a build backend. */
object PythonManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.PYTHON
    override val fileNames = listOf("pyproject.toml", "requirements.txt")
    override val discoveryGlobs = listOf("**/pyproject.toml", "**/requirements*.txt", "**/requirements/**/*.txt")
    override val notesRelativePath = ".depos/python/DEPENDENCY-NOTES.md"

    override fun matchesPath(path: String): Boolean {
        val normalized = path.replace('\\', '/')
        val basename = normalized.substringAfterLast('/')
        return basename == "pyproject.toml" ||
            (basename.startsWith("requirements") && basename.endsWith(".txt")) ||
            (basename.endsWith(".txt") && normalized.split('/').contains("requirements"))
    }

    override fun extractDependencies(text: String): List<DependencyEntry> = extractDependencies(text, "pyproject.toml")

    override fun extractDependencies(text: String, path: String): List<DependencyEntry> =
        if (path.replace('\\', '/').substringAfterLast('/') == "pyproject.toml") extractPyproject(text)
        else extractRequirements(text, requirementsScope(path))

    override fun normalizeNoteKey(raw: String): String = normalizePackageName(ManifestRegistry.stripName(raw))

    fun normalizePackageName(value: String): String = value.trim().lowercase().replace(Regex("[._-]+"), "-")

    private data class Line(val text: String, val offset: Int)
    private data class Assignment(
        val table: List<String>,
        val key: String,
        val keyRange: SourceRange,
        val valueText: String,
        val valueOffset: Int,
    )

    private fun lines(text: String): List<Line> = buildList {
        var offset = 0
        while (offset <= text.length) {
            val newline = text.indexOf('\n', offset)
            val rawEnd = if (newline < 0) text.length else newline
            val end = if (rawEnd > offset && text[rawEnd - 1] == '\r') rawEnd - 1 else rawEnd
            add(Line(text.substring(offset, end), offset))
            if (newline < 0) break
            offset = newline + 1
        }
    }

    private fun commentStart(value: String): Int {
        var quote: Char? = null
        var escaped = false
        value.forEachIndexed { index, char ->
            if (quote == '"' && escaped) escaped = false
            else if (quote == '"' && char == '\\') escaped = true
            else if (quote != null) {
                if (char == quote) quote = null
            } else if (char == '"' || char == '\'') quote = char
            else if (char == '#') return index
        }
        return value.length
    }

    private fun splitDottedKey(raw: String): List<String>? {
        val parts = mutableListOf<String>()
        var start = 0
        var quote: Char? = null
        var escaped = false
        fun push(end: Int): Boolean {
            val token = raw.substring(start, end).trim()
            if (token.isEmpty()) return false
            parts += if (token.length >= 2 && token.first() in setOf('"', '\'') && token.last() == token.first()) {
                token.substring(1, token.length - 1)
            } else token
            return true
        }
        raw.forEachIndexed { index, char ->
            if (quote == '"' && escaped) escaped = false
            else if (quote == '"' && char == '\\') escaped = true
            else if (quote != null) {
                if (char == quote) quote = null
            } else if (char == '"' || char == '\'') quote = char
            else if (char == '.') {
                if (!push(index)) return null
                start = index + 1
            }
        }
        return if (quote == null && push(raw.length)) parts else null
    }

    private fun unquotedEquals(raw: String): Int {
        var quote: Char? = null
        var escaped = false
        raw.forEachIndexed { index, char ->
            if (quote == '"' && escaped) escaped = false
            else if (quote == '"' && char == '\\') escaped = true
            else if (quote != null) {
                if (char == quote) quote = null
            } else if (char == '"' || char == '\'') quote = char
            else if (char == '=') return index
        }
        return -1
    }

    private fun nestingDelta(raw: String): Int {
        var delta = 0
        var quote: Char? = null
        var escaped = false
        for (char in raw) {
            if (quote == '"' && escaped) escaped = false
            else if (quote == '"' && char == '\\') escaped = true
            else if (quote != null) {
                if (char == quote) quote = null
            } else if (char == '"' || char == '\'') quote = char
            else if (char == '[' || char == '{') delta++
            else if (char == ']' || char == '}') delta--
        }
        return delta
    }

    private fun assignments(text: String): List<Assignment> {
        val sourceLines = lines(text)
        val out = mutableListOf<Assignment>()
        var table = emptyList<String>()
        var index = 0
        while (index < sourceLines.size) {
            val line = sourceLines[index]
            val content = line.text.substring(0, commentStart(line.text))
            val trimmed = content.trim()
            if (trimmed.isEmpty()) {
                index++
                continue
            }
            if (trimmed.startsWith('[')) {
                table = if (!trimmed.startsWith("[[") && trimmed.endsWith(']')) {
                    splitDottedKey(trimmed.substring(1, trimmed.length - 1)) ?: emptyList()
                } else emptyList()
                index++
                continue
            }
            val equals = unquotedEquals(content)
            if (equals < 0) {
                index++
                continue
            }
            val rawKey = content.substring(0, equals)
            val keyToken = rawKey.trim()
            val keyParts = splitDottedKey(keyToken)
            if (keyParts.isNullOrEmpty()) {
                index++
                continue
            }
            val keyLeading = rawKey.length - rawKey.trimStart().length
            val quoted = keyToken.length >= 2 && keyToken.first() in setOf('"', '\'') && keyToken.last() == keyToken.first()
            val keyRange = SourceRange(line.offset + keyLeading + if (quoted) 1 else 0, keyToken.length - if (quoted) 2 else 0)
            var valueText = content.substring(equals + 1)
            val valueOffset = line.offset + equals + 1
            var depth = nestingDelta(valueText)
            while (depth > 0 && index + 1 < sourceLines.size) {
                val next = sourceLines[++index]
                val nextContent = next.text.substring(0, commentStart(next.text))
                valueText += " ".repeat((next.offset - (valueOffset + valueText.length)).coerceAtLeast(0)) + nextContent
                depth += nestingDelta(nextContent)
            }
            out += Assignment(table, keyParts.joinToString("."), keyRange, valueText, valueOffset)
            index++
        }
        return out
    }

    private data class TomlString(val raw: String, val contentOffset: Int, val range: SourceRange)

    private fun arrayStrings(assignment: Assignment): List<TomlString> = buildList {
        val raw = assignment.valueText
        var inlineTableDepth = 0
        var index = 0
        while (index < raw.length) {
            val quote = raw[index]
            if (quote == '{') {
                inlineTableDepth++
                index++
                continue
            }
            if (quote == '}') {
                inlineTableDepth = (inlineTableDepth - 1).coerceAtLeast(0)
                index++
                continue
            }
            if (quote !in setOf('"', '\'')) {
                index++
                continue
            }
            if (raw.substring(index).startsWith(quote.toString().repeat(3))) {
                val end = raw.indexOf(quote.toString().repeat(3), index + 3)
                if (end < 0) break
                index = end + 3
                continue
            }
            val start = index++
            var escaped = false
            while (index < raw.length) {
                val char = raw[index]
                if (quote == '"' && escaped) escaped = false
                else if (quote == '"' && char == '\\') escaped = true
                else if (char == quote) break
                index++
            }
            if (index >= raw.length) break
            if (inlineTableDepth == 0) {
                add(TomlString(
                    raw.substring(start + 1, index),
                    assignment.valueOffset + start + 1,
                    SourceRange(assignment.valueOffset + start, index - start + 1),
                ))
            }
            index++
        }
    }

    private data class RequirementName(val name: String, val start: Int, val length: Int)
    private val requirementNamePattern = Regex("^\\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)")

    private fun requirementName(raw: String): RequirementName? {
        val match = requirementNamePattern.find(raw) ?: return null
        val name = match.groupValues[1]
        val end = match.range.last + 1
        val next = raw.getOrNull(end)
        if (next != null && !next.isWhitespace() && next !in "[(<>=!~@;") return null
        val start = match.value.length - name.length
        return RequirementName(name, start, name.length)
    }

    private fun requirementEntry(value: TomlString, scope: String): DependencyEntry? {
        val parsed = requirementName(value.raw) ?: return null
        val range = SourceRange(value.contentOffset + parsed.start, parsed.length)
        return dependencyEntry(normalizePackageName(parsed.name), scope, range, listOf(range), parsed.name, value.range)
    }

    private fun tableEquals(table: List<String>, vararg wanted: String): Boolean = table == wanted.toList()

    fun extractPyproject(text: String): List<DependencyEntry> = buildList {
        for (assignment in assignments(text)) {
            val arrayScope = when {
                tableEquals(assignment.table, "project") && assignment.key == "dependencies" -> "project"
                tableEquals(assignment.table, "project", "optional-dependencies") -> "extra:${assignment.key}"
                tableEquals(assignment.table, "dependency-groups") -> "group:${assignment.key}"
                tableEquals(assignment.table, "build-system") && assignment.key == "requires" -> "build-system"
                tableEquals(assignment.table, "tool", "uv") && assignment.key == "dev-dependencies" -> "uv:dev"
                else -> null
            }
            if (arrayScope != null) {
                arrayStrings(assignment).mapNotNullTo(this) { requirementEntry(it, arrayScope) }
                continue
            }
            val poetryScope = when {
                tableEquals(assignment.table, "tool", "poetry", "dependencies") -> "poetry:main"
                tableEquals(assignment.table, "tool", "poetry", "dev-dependencies") -> "poetry:dev"
                assignment.table.size == 5 && assignment.table[0] == "tool" && assignment.table[1] == "poetry" &&
                    assignment.table[2] == "group" && assignment.table[4] == "dependencies" ->
                    "poetry:group:${assignment.table[3]}"
                else -> null
            }
            if (poetryScope != null && !assignment.key.equals("python", ignoreCase = true)) {
                add(dependencyEntry(
                    normalizePackageName(assignment.key),
                    poetryScope,
                    assignment.keyRange,
                    listOf(assignment.keyRange),
                    assignment.key,
                    assignment.keyRange,
                ))
            }
        }
    }

    private data class LogicalLine(val value: String, val positions: List<Int>)

    private fun logicalLines(text: String): List<LogicalLine> = buildList {
        var value = StringBuilder()
        var positions = mutableListOf<Int>()
        for (line in lines(text)) {
            val continued = Regex("\\\\\\s*$").containsMatchIn(line.text)
            val part = if (continued) line.text.replace(Regex("\\\\\\s*$"), "") else line.text
            part.forEachIndexed { index, char ->
                value.append(char)
                positions += line.offset + index
            }
            if (continued) {
                value.append(' ')
                positions += line.offset + line.text.length
            } else {
                add(LogicalLine(value.toString(), positions))
                value = StringBuilder()
                positions = mutableListOf()
            }
        }
        if (value.isNotEmpty()) add(LogicalLine(value.toString(), positions))
    }

    private fun requirementCommentStart(value: String): Int = value.indices.firstOrNull {
        value[it] == '#' && (it == 0 || value[it - 1].isWhitespace())
    } ?: value.length

    fun extractRequirements(text: String, scope: String = "requirements.txt"): List<DependencyEntry> = buildList {
        for (logical in logicalLines(text)) {
            val raw = logical.value.substring(0, requirementCommentStart(logical.value))
            var candidateStart = raw.length - raw.trimStart().length
            var candidate = raw.trimStart()
            if (candidate.isEmpty()) continue
            if (Regex("^(?:-r|--requirement|-c|--constraint)(?:\\s|=)").containsMatchIn(candidate) ||
                candidate.startsWith("--")) continue
            val editable = Regex("^(?:-e|--editable)(?:\\s+|=)").find(candidate)
            if (editable != null) {
                candidateStart += editable.value.length
                candidate = candidate.substring(editable.value.length)
            } else if (candidate.startsWith('-')) continue
            var parsed = requirementName(candidate)
            if (parsed == null) {
                val egg = Regex("[#&]egg=([A-Za-z0-9][A-Za-z0-9._-]*)", RegexOption.IGNORE_CASE).find(candidate)
                if (egg != null) {
                    val name = egg.groupValues[1]
                    parsed = RequirementName(name, egg.range.last + 1 - name.length, name.length)
                }
            }
            if (parsed == null) continue
            val offset = logical.positions.getOrNull(candidateStart + parsed.start) ?: continue
            val range = SourceRange(offset, parsed.length)
            add(dependencyEntry(normalizePackageName(parsed.name), scope, range, listOf(range), parsed.name, range))
        }
    }

    private fun requirementsScope(path: String): String {
        val normalized = path.replace('\\', '/')
        val marker = "/requirements/"
        val index = normalized.lowercase().lastIndexOf(marker)
        return if (index >= 0) normalized.substring(index + 1) else normalized.substringAfterLast('/')
    }
}
