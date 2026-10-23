package dev.pacmon.jetbrains.core

enum class ManifestKind(val id: String) {
    NPM("npm"),
    CARGO("cargo"),
    MAVEN("maven"),
    GRADLE("gradle"),
    MIX("mix"),
    GLEAM("gleam"),
    ZIG("zig"),
    PYTHON("python"),
    RUBY("ruby"),
    COMPOSER("composer"),
    NUGET("nuget"),
    GO("go"),
    VCPKG("vcpkg"),
    CONAN("conan");

    companion object {
        fun fromId(value: String?): ManifestKind? = entries.firstOrNull { it.id == value }
    }
}

data class SourceRange(val offset: Int, val length: Int) {
    fun contains(position: Int): Boolean = position >= offset && position <= offset + length
}

data class DependencyEntry(
    val noteKey: String,
    val displayName: String,
    val scope: String,
    val primaryRange: SourceRange,
    val sourceRanges: List<SourceRange> = listOf(primaryRange),
    val iconRange: SourceRange = primaryRange,
)

interface ManifestAdapter {
    val kind: ManifestKind
    val fileNames: List<String>
    val discoveryGlobs: List<String> get() = fileNames.map { "**/$it" }
    val notesRelativePath: String
    fun extractDependencies(text: String): List<DependencyEntry>
    fun extractDependencies(text: String, path: String): List<DependencyEntry> = extractDependencies(text)
    fun matchesPath(path: String): Boolean = path.replace('\\', '/').substringAfterLast('/') in fileNames
    fun normalizeNoteKey(raw: String): String
}

object ManifestRegistry {
    val adapters: List<ManifestAdapter> = listOf(
        NpmManifestAdapter,
        CargoManifestAdapter,
        MavenManifestAdapter,
        GradleManifestAdapter,
        MixManifestAdapter,
        GleamManifestAdapter,
        ZigManifestAdapter,
        PythonManifestAdapter,
        RubyManifestAdapter,
        ComposerManifestAdapter,
        NugetManifestAdapter,
        GoManifestAdapter,
        VcpkgManifestAdapter,
        ConanManifestAdapter,
    )

    fun forFileName(fileName: String): ManifestAdapter? = forPath(fileName)

    fun forPath(path: String): ManifestAdapter? = adapters.firstOrNull { it.matchesPath(path) }

    fun forKind(kind: ManifestKind): ManifestAdapter = adapters.first { it.kind == kind }

    fun dependencyAtOffset(dependencies: List<DependencyEntry>, offset: Int): DependencyEntry? =
        dependencies.firstOrNull { dependency -> dependency.sourceRanges.any { it.contains(offset) } }

    fun stripName(raw: String): String {
        var value = raw.trim()
        if (value.length >= 2 && value.first() == value.last() && value.first() in setOf('`', '\'', '"')) {
            value = value.substring(1, value.length - 1).trim()
        }
        return value
    }

    fun normalizeName(raw: String, ecosystem: ManifestKind?): String {
        val value = stripName(raw)
        if (ecosystem == ManifestKind.PYTHON) return PythonManifestAdapter.normalizePackageName(value)
        if (ecosystem in setOf(ManifestKind.NUGET, ManifestKind.COMPOSER, ManifestKind.VCPKG, ManifestKind.CONAN)) return value.lowercase()
        return if (ecosystem != null && ecosystem != ManifestKind.NPM) value else value.lowercase()
    }
}

internal fun dependencyEntry(
    noteKey: String,
    scope: String,
    primaryRange: SourceRange,
    sourceRanges: List<SourceRange> = listOf(primaryRange),
    displayName: String = noteKey,
    iconRange: SourceRange = primaryRange,
) = DependencyEntry(noteKey, displayName, scope, primaryRange, sourceRanges, iconRange)

object NpmManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.NPM
    override val fileNames = listOf("package.json")
    override val notesRelativePath = ".pacmon/DEPENDENCY-NOTES.md"
    override fun normalizeNoteKey(raw: String): String = ManifestRegistry.stripName(raw).lowercase()

    private val dependencySections = setOf(
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    )

    override fun extractDependencies(text: String): List<DependencyEntry> {
        val root = JsonReader(text).readValue() as? JsonObject ?: return emptyList()
        return root.properties.flatMap { section ->
            if (section.key !in dependencySections) return@flatMap emptyList()
            val dependencies = section.value as? JsonObject ?: return@flatMap emptyList()
            dependencies.properties.map { dependency ->
                dependencyEntry(dependency.key, section.key, dependency.keyRange)
            }
        }
    }
}

object ComposerManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.COMPOSER
    override val fileNames = listOf("composer.json")
    override val notesRelativePath = ".pacmon/composer/DEPENDENCY-NOTES.md"
    override fun normalizeNoteKey(raw: String): String = ManifestRegistry.stripName(raw).lowercase()

    private val dependencySections = listOf("require", "require-dev")
    private val packageName = Regex("^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$")
    private val platformPackage = Regex(
        "^(?:php(?:-[A-Za-z0-9_.-]+)?|hhvm|ext-[A-Za-z0-9_.-]+|lib-[A-Za-z0-9_.-]+|composer(?:-(?:plugin|runtime)-api)?)$",
        RegexOption.IGNORE_CASE,
    )

    /** Reads direct Composer requirements without invoking PHP or Composer. */
    override fun extractDependencies(text: String): List<DependencyEntry> {
        val root = JsonReader(text).readValue() as? JsonObject ?: return emptyList()
        return dependencySections.flatMap { section ->
            val dependencies = root.property(section) as? JsonObject ?: return@flatMap emptyList()
            dependencies.properties.mapNotNull { dependency ->
                if (dependency.value !is JsonText || !isDependencyName(dependency.key)) return@mapNotNull null
                val keyRange = dependency.keyRange
                val range = SourceRange(keyRange.offset + 1, keyRange.length - 2)
                dependencyEntry(
                    dependency.key.lowercase(),
                    section,
                    range,
                    displayName = dependency.key,
                    iconRange = SourceRange(keyRange.offset, 1),
                )
            }
        }
    }

    private fun isDependencyName(value: String): Boolean =
        packageName.matches(value) || platformPackage.matches(value)
}

object VcpkgManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.VCPKG
    override val fileNames = listOf("vcpkg.json")
    override val notesRelativePath = ".pacmon/vcpkg/DEPENDENCY-NOTES.md"
    override fun normalizeNoteKey(raw: String): String = ManifestRegistry.stripName(raw).lowercase()

    private val packageName = Regex("^[A-Za-z0-9][A-Za-z0-9-]*$")

    /** Reads direct dependency declarations from vcpkg.json without invoking vcpkg. */
    override fun extractDependencies(text: String): List<DependencyEntry> {
        val root = JsonReader(text).readValue() as? JsonObject ?: return emptyList()
        val out = dependenciesFrom(root.property("dependencies"), "dependencies").toMutableList()
        val features = root.property("features") as? JsonObject ?: return out
        for (feature in features.properties) {
            val body = feature.value as? JsonObject ?: continue
            out.addAll(dependenciesFrom(body.property("dependencies"), "feature:${feature.key}"))
        }
        return out
    }

    private fun dependenciesFrom(node: JsonValue?, scope: String): List<DependencyEntry> {
        val array = node as? JsonArray ?: return emptyList()
        return array.items.mapNotNull { dependencyFrom(it, scope) }
    }

    private fun dependencyFrom(node: JsonValue, scope: String): DependencyEntry? {
        val name = when (node) {
            is JsonText -> node
            is JsonObject -> node.property("name") as? JsonText
            else -> null
        } ?: return null
        if (!packageName.matches(name.value)) return null
        val host = node is JsonObject && (node.property("host") as? JsonScalar)?.raw == "true"
        val range = SourceRange(name.range.offset + 1, name.range.length - 2)
        return dependencyEntry(
            name.value.lowercase(),
            if (host) "$scope:host" else scope,
            range,
            displayName = name.value,
            iconRange = SourceRange(node.offset, 1),
        )
    }
}

private sealed interface JsonValue {
    val offset: Int
}
private data class JsonObject(val properties: List<JsonProperty>, override val offset: Int) : JsonValue {
    fun property(name: String): JsonValue? = properties.firstOrNull { it.key == name }?.value
}
private data class JsonArray(val items: List<JsonValue>, override val offset: Int) : JsonValue
private data class JsonText(val value: String, val range: SourceRange) : JsonValue {
    override val offset: Int get() = range.offset
}
/** A number, literal or unreadable value; [raw] is its source text. */
private data class JsonScalar(val raw: String, override val offset: Int) : JsonValue
private data class JsonProperty(
    val key: String,
    val keyRange: SourceRange,
    val value: JsonValue,
)

/** Small JSONC reader: enough structure for package.json, composer.json and vcpkg.json, with no runtime dependency. */
private class JsonReader(private val text: String) {
    private var cursor = 0

    fun readValue(): JsonValue? {
        skipTrivia()
        if (cursor >= text.length) return null
        return when (text[cursor]) {
            '{' -> readObject()
            '[' -> readArray()
            '"' -> readString()?.let { JsonText(it.value, it.range) }
            else -> readPrimitive()
        }
    }

    private fun readObject(): JsonObject {
        val start = cursor++
        val properties = mutableListOf<JsonProperty>()
        while (cursor < text.length) {
            skipTrivia()
            if (take('}')) break
            val key = readString()
            if (key == null) {
                recover(',', '}')
                if (take(',')) continue
                if (take('}')) break
                continue
            }
            skipTrivia()
            if (!take(':')) {
                recover(',', '}')
                if (take(',')) continue
                if (take('}')) break
                continue
            }
            val value = readValue() ?: JsonScalar("", cursor)
            properties.add(JsonProperty(key.value, key.range, value))
            skipTrivia()
            if (take(',')) continue
            if (take('}')) break
            recover(',', '}')
            if (take(',')) continue
            if (take('}')) break
        }
        return JsonObject(properties, start)
    }

    private fun readArray(): JsonArray {
        val start = cursor++
        val items = mutableListOf<JsonValue>()
        while (cursor < text.length) {
            skipTrivia()
            if (take(']')) break
            val before = cursor
            readValue()?.let(items::add)
            // A stray '}' or an unterminated string reads nothing; step past it.
            if (cursor == before) cursor++
            skipTrivia()
            if (take(',')) continue
            if (take(']')) break
        }
        return JsonArray(items, start)
    }

    private data class JsonString(val value: String, val range: SourceRange)

    private fun readString(): JsonString? {
        skipTrivia()
        if (cursor >= text.length || text[cursor] != '"') return null
        val start = cursor++
        val value = StringBuilder()
        while (cursor < text.length) {
            val ch = text[cursor++]
            if (ch == '"') return JsonString(value.toString(), SourceRange(start, cursor - start))
            if (ch != '\\') {
                value.append(ch)
                continue
            }
            if (cursor >= text.length) break
            when (val escaped = text[cursor++]) {
                '"', '\\', '/' -> value.append(escaped)
                'b' -> value.append('\b')
                'f' -> value.append('\u000C')
                'n' -> value.append('\n')
                'r' -> value.append('\r')
                't' -> value.append('\t')
                'u' -> {
                    val end = (cursor + 4).coerceAtMost(text.length)
                    val digits = text.substring(cursor, end)
                    val code = digits.toIntOrNull(16)
                    if (digits.length == 4 && code != null) {
                        value.append(code.toChar())
                        cursor = end
                    } else {
                        value.append('u').append(digits)
                        cursor = end
                    }
                }
                else -> value.append(escaped)
            }
        }
        return null
    }

    private fun readPrimitive(): JsonValue {
        val start = cursor
        while (cursor < text.length && text[cursor] !in charArrayOf(',', '}', ']') && !text[cursor].isWhitespace()) cursor++
        return JsonScalar(text.substring(start, cursor), start)
    }

    private fun skipTrivia() {
        while (cursor < text.length) {
            if (text[cursor].isWhitespace()) {
                cursor++
                continue
            }
            if (text.startsWith("//", cursor)) {
                cursor += 2
                while (cursor < text.length && text[cursor] != '\n') cursor++
                continue
            }
            if (text.startsWith("/*", cursor)) {
                val end = text.indexOf("*/", cursor + 2)
                cursor = if (end < 0) text.length else end + 2
                continue
            }
            break
        }
    }

    private fun recover(vararg wanted: Char) {
        while (cursor < text.length && text[cursor] !in wanted) cursor++
    }

    private fun take(ch: Char): Boolean {
        if (cursor >= text.length || text[cursor] != ch) return false
        cursor++
        return true
    }
}

object CargoManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.CARGO
    override val fileNames = listOf("Cargo.toml")
    override val notesRelativePath = ".pacmon/cargo/DEPENDENCY-NOTES.md"
    override fun normalizeNoteKey(raw: String): String = ManifestRegistry.stripName(raw)

    private data class KeyPart(val value: String, val range: SourceRange)
    private data class TableContext(val scope: String, val dependencyIndex: Int?)
    private val dependencyTables = setOf("dependencies", "dev-dependencies", "build-dependencies")

    override fun extractDependencies(text: String): List<DependencyEntry> {
        val out = mutableListOf<DependencyEntry>()
        val seen = mutableSetOf<String>()
        var activeScope: String? = null
        var continuationDepth = 0

        fun add(part: KeyPart, scope: String) {
            if (!seen.add("$scope\u0000${part.value}")) return
            out.add(dependencyEntry(part.value, scope, part.range))
        }

        for ((line, lineOffset) in splitLines(text)) {
            val content = contentBeforeComment(line)
            if (continuationDepth > 0) {
                continuationDepth = (continuationDepth + nestingDelta(content)).coerceAtLeast(0)
                continue
            }
            val header = tableHeader(content)
            if (header == null && content.trimStart().startsWith('[')) {
                activeScope = null
                continue
            }
            if (header != null) {
                val parts = keyParts(header.first, lineOffset + header.second)
                val context = parts?.let(::tableScope)
                activeScope = if (context?.dependencyIndex == null) context?.scope else null
                if (parts != null && context?.dependencyIndex != null) {
                    parts.getOrNull(context.dependencyIndex)?.let { add(it, context.scope) }
                }
                continue
            }
            val scope = activeScope ?: continue
            val equals = unquotedIndex(content, '=')
            if (equals < 0) continue
            val rawKey = content.substring(0, equals)
            val leading = rawKey.length - rawKey.trimStart().length
            keyParts(rawKey.trim(), lineOffset + leading)?.firstOrNull()?.let { add(it, scope) }
            continuationDepth = nestingDelta(content.substring(equals + 1)).coerceAtLeast(0)
        }
        return out
    }

    private fun splitLines(text: String): List<Pair<String, Int>> {
        val result = mutableListOf<Pair<String, Int>>()
        var start = 0
        while (start <= text.length) {
            val newline = text.indexOf('\n', start)
            val rawEnd = if (newline < 0) text.length else newline
            val end = if (rawEnd > start && text[rawEnd - 1] == '\r') rawEnd - 1 else rawEnd
            result.add(text.substring(start, end) to start)
            if (newline < 0) break
            start = newline + 1
        }
        return result
    }

    private fun contentBeforeComment(line: String): String {
        var quote: Char? = null
        var escaped = false
        line.forEachIndexed { index, ch ->
            if (quote == '"' && escaped) {
                escaped = false
            } else if (quote == '"' && ch == '\\') {
                escaped = true
            } else if (quote != null) {
                if (ch == quote) quote = null
            } else if (ch == '"' || ch == '\'') {
                quote = ch
            } else if (ch == '#') {
                return line.substring(0, index)
            }
        }
        return line
    }

    private fun decodeKey(raw: String): String {
        if (raw.length < 2) return raw
        if (raw.first() == '\'' && raw.last() == '\'') return raw.substring(1, raw.length - 1)
        if (raw.first() != '"' || raw.last() != '"') return raw
        return decodeBasicString(raw.substring(1, raw.length - 1))
    }

    private fun decodeBasicString(value: String): String = buildString {
        var i = 0
        while (i < value.length) {
            val ch = value[i++]
            if (ch != '\\' || i >= value.length) append(ch)
            else when (val escaped = value[i++]) {
                '"', '\\', '/' -> append(escaped)
                'b' -> append('\b')
                'f' -> append('\u000C')
                'n' -> append('\n')
                'r' -> append('\r')
                't' -> append('\t')
                'u' -> {
                    val end = (i + 4).coerceAtMost(value.length)
                    val digits = value.substring(i, end)
                    val code = digits.toIntOrNull(16)
                    if (digits.length == 4 && code != null) {
                        append(code.toChar())
                        i = end
                    } else {
                        append('u').append(digits)
                        i = end
                    }
                }
                else -> append(escaped)
            }
        }
    }

    private fun keyParts(raw: String, absoluteOffset: Int): List<KeyPart>? {
        val out = mutableListOf<KeyPart>()
        var start = 0
        var quote: Char? = null
        var escaped = false

        fun push(end: Int): Boolean {
            val segment = raw.substring(start, end)
            val leading = segment.length - segment.trimStart().length
            val token = segment.trim()
            if (token.isEmpty()) return false
            if ((token.startsWith('"') && !token.endsWith('"')) ||
                (token.startsWith('\'') && !token.endsWith('\''))
            ) return false
            out.add(KeyPart(decodeKey(token), SourceRange(absoluteOffset + start + leading, token.length)))
            return true
        }

        raw.forEachIndexed { index, ch ->
            if (quote == '"' && escaped) {
                escaped = false
            } else if (quote == '"' && ch == '\\') {
                escaped = true
            } else if (quote != null) {
                if (ch == quote) quote = null
            } else if (ch == '"' || ch == '\'') {
                quote = ch
            } else if (ch == '.') {
                if (!push(index)) return null
                start = index + 1
            }
        }
        if (quote != null || !push(raw.length)) return null
        return out
    }

    private fun unquotedIndex(raw: String, wanted: Char): Int {
        var quote: Char? = null
        var escaped = false
        raw.forEachIndexed { index, ch ->
            if (quote == '"' && escaped) escaped = false
            else if (quote == '"' && ch == '\\') escaped = true
            else if (quote != null) {
                if (ch == quote) quote = null
            } else if (ch == '"' || ch == '\'') quote = ch
            else if (ch == wanted) return index
        }
        return -1
    }

    private fun nestingDelta(raw: String): Int {
        var delta = 0
        var quote: Char? = null
        var escaped = false
        for (ch in raw) {
            if (quote == '"' && escaped) escaped = false
            else if (quote == '"' && ch == '\\') escaped = true
            else if (quote != null) {
                if (ch == quote) quote = null
            } else if (ch == '"' || ch == '\'') quote = ch
            else if (ch == '{' || ch == '[') delta++
            else if (ch == '}' || ch == ']') delta--
        }
        return delta
    }

    private fun tableHeader(line: String): Pair<String, Int>? {
        val leading = line.length - line.trimStart().length
        if (line.getOrNull(leading) != '[' || line.getOrNull(leading + 1) == '[') return null
        var quote: Char? = null
        var escaped = false
        for (index in leading + 1 until line.length) {
            val ch = line[index]
            if (quote == '"' && escaped) escaped = false
            else if (quote == '"' && ch == '\\') escaped = true
            else if (quote != null) {
                if (ch == quote) quote = null
            } else if (ch == '"' || ch == '\'') quote = ch
            else if (ch == ']') return line.substring(leading + 1, index) to leading + 1
        }
        return null
    }

    private fun tableScope(parts: List<KeyPart>): TableContext? {
        if (parts.isEmpty() || parts.first().value == "workspace") return null
        val sectionIndex = when {
            parts.first().value in dependencyTables -> 0
            parts.first().value == "target" -> parts.indexOfFirstIndexed { index, part ->
                index >= 2 && part.value in dependencyTables
            }
            else -> -1
        }
        if (sectionIndex < 0) return null
        val section = parts[sectionIndex].value
        val scope = if (sectionIndex == 0) section else {
            "target:${parts.subList(1, sectionIndex).joinToString(".") { it.value }}/$section"
        }
        return TableContext(scope, if (parts.size > sectionIndex + 1) sectionIndex + 1 else null)
    }

    private inline fun <T> List<T>.indexOfFirstIndexed(predicate: (Int, T) -> Boolean): Int {
        forEachIndexed { index, value -> if (predicate(index, value)) return index }
        return -1
    }
}

object MavenManifestAdapter : ManifestAdapter {
    override val kind = ManifestKind.MAVEN
    override val fileNames = listOf("pom.xml")
    override val notesRelativePath = ".pacmon/maven/DEPENDENCY-NOTES.md"
    override fun normalizeNoteKey(raw: String): String = ManifestRegistry.stripName(raw)

    override fun extractDependencies(text: String): List<DependencyEntry> {
        val project = parseXml(text).firstOrNull { it.name == "project" } ?: return emptyList()
        val out = dependenciesFrom(text, xmlChild(project, "dependencies")).toMutableList()
        xmlChild(project, "profiles")?.children?.filter { it.name == "profile" }?.forEach { profile ->
            val id = xmlTextValue(text, xmlChild(profile, "id"))?.first ?: "unnamed"
            out.addAll(dependenciesFrom(text, xmlChild(profile, "dependencies"), "profile:$id"))
        }
        return out
    }

    private fun dependenciesFrom(text: String, dependencies: XmlNode?, scopePrefix: String? = null): List<DependencyEntry> {
        dependencies ?: return emptyList()
        return dependencies.children.filter { it.name == "dependency" }.mapNotNull { dependency ->
            val group = xmlTextValue(text, xmlChild(dependency, "groupId")) ?: return@mapNotNull null
            val artifact = xmlTextValue(text, xmlChild(dependency, "artifactId")) ?: return@mapNotNull null
            val declaredScope = xmlTextValue(text, xmlChild(dependency, "scope"))?.first ?: "compile"
            val scope = if (scopePrefix == null) declaredScope else "$scopePrefix/$declaredScope"
            dependencyEntry(
                "${group.first}:${artifact.first}",
                scope,
                artifact.second,
                listOf(group.second, artifact.second),
                iconRange = SourceRange(dependency.openStart, 1),
            )
        }
    }
}
