package dev.pacmon.jetbrains.core

object NotesCore {
    const val NOTES_DIRECTORY = ".pacmon"
    const val NOTES_FILE_NAME = "DEPENDENCY-NOTES.md"
    const val NOTES_RELATIVE_PATH = "$NOTES_DIRECTORY/$NOTES_FILE_NAME"
    const val AGENT_RULES_FILE_NAME = "AGENT-RULES.md"
    const val AGENT_RULES_RELATIVE_PATH = "$NOTES_DIRECTORY/$AGENT_RULES_FILE_NAME"
    const val AGENT_NOTES_HEADING = "### Agent notes"
    const val GENERATED_HEADING = "### Generated"
    const val FORMAT_VERSION = "dependency-notes/1"
    const val FORMAT_VERSION_V2 = "dependency-notes/2"
    val SUPPORTED_FORMAT_VERSIONS = setOf(FORMAT_VERSION, FORMAT_VERSION_V2)
    const val DEFAULT_TITLE = "# Dependency Notes"
    internal const val TITLE_TEXT = "Dependency Notes"

    private val heading = Regex("^##(?!#)\\s+(.+?)\\s*$")
    private val subheading = Regex("^###(?!#)\\s+(.+?)\\s*$")
    private val fence = Regex("^\\s{0,3}(`{3,}|~{3,})")
    private val agentField = Regex("^\\s*[-*]\\s+([a-z][a-z0-9_-]*)\\s*:\\s*(.*)$", RegexOption.IGNORE_CASE)
    private val frontmatterKv = Regex("^([A-Za-z][\\w-]*):\\s*(.*?)\\s*$")
    private val titlePattern = Regex("^#(?!#)\\s+")

    val AI_FORMAT_COMMENT_LINES = listOf(
        "<!-- Each \"## name\" below is a package from package.json. The text right under the",
        "  heading is written by people. \"$AGENT_NOTES_HEADING\" and everything below it is written",
        "  by AI agents — rules in $AGENT_RULES_RELATIVE_PATH. -->",
    )

    fun normalizeName(raw: String, ecosystem: ManifestKind? = null): String =
        ManifestRegistry.normalizeName(raw, ecosystem)

    fun notesRelativePath(ecosystem: ManifestKind): String = ManifestRegistry.forKind(ecosystem).notesRelativePath

    fun formatCommentLines(ecosystem: ManifestKind?): List<String> = when (ecosystem) {
        ManifestKind.CARGO, ManifestKind.MAVEN, ManifestKind.GRADLE, ManifestKind.MIX, ManifestKind.GLEAM,
        ManifestKind.ZIG, ManifestKind.PYTHON, ManifestKind.RUBY, ManifestKind.COMPOSER, ManifestKind.NUGET,
        ManifestKind.GO, ManifestKind.VCPKG, ManifestKind.CONAN -> listOf(
            "<!-- Each \"## name\" below is a package from the ${ecosystem.id} dependency manifest.",
            "  The text under it is written by people. \"$AGENT_NOTES_HEADING\" and everything below",
            "  it is written by AI agents — rules in $AGENT_RULES_RELATIVE_PATH. -->",
        )
        else -> AI_FORMAT_COMMENT_LINES
    }

    fun parse(textValue: String): NotesFileModel {
        var text = textValue
        val hadBom = text.startsWith('\uFEFF')
        if (hadBom) text = text.substring(1)
        val eol = if (text.contains("\r\n")) "\r\n" else "\n"
        val lines = text.split(Regex("\\r\\n|\\n"))

        var i = 0

        // --- Frontmatter (only if the file starts with ---) ---
        var frontmatter: Frontmatter? = null
        if (lines.getOrNull(0) == "---") {
            for (j in 1 until lines.size) {
                if (lines[j] == "---") {
                    var formatVersion: String? = null
                    var lang: String? = null
                    var ecosystem: ManifestKind? = null
                    for (k in 1 until j) {
                        val kv = frontmatterKv.matchEntire(lines[k]) ?: continue
                        val value = kv.groupValues[2]
                        if (value.isEmpty()) continue
                        when (kv.groupValues[1]) {
                            "format" -> formatVersion = value
                            "lang" -> lang = value
                            "ecosystem" -> ecosystem = ManifestKind.fromId(value)
                        }
                    }
                    frontmatter = Frontmatter(0, j, formatVersion, lang, ecosystem)
                    i = j + 1
                    break
                }
            }
        }

        fun skipBlanks() {
            while (i < lines.size && lines[i].isBlank()) i++
        }

        // --- Leading AI/format comment (first HTML comment before any content) ---
        skipBlanks()
        var aiComment: LineRange? = null
        if (i < lines.size && lines[i].trimStart().startsWith("<!--")) {
            val start = i
            while (i < lines.size && !lines[i].contains("-->")) i++
            if (i < lines.size) {
                aiComment = LineRange(start, i)
                i++
            } else {
                i = start
            }
        }

        // --- Title (# Heading) ---
        skipBlanks()
        var titleLine: Int? = null
        if (i < lines.size && titlePattern.containsMatchIn(lines[i])) {
            titleLine = i
            i++
        }

        // --- Intro + sections (with fenced-code awareness) ---
        val introStart = i
        var firstHeading = -1
        var inFence = false
        var current: NoteSection? = null
        val sections = mutableListOf<NoteSection>()

        while (i < lines.size) {
            val line = lines[i]
            if (fence.containsMatchIn(line)) {
                inFence = !inFence
                i++
                continue
            }
            if (inFence) {
                i++
                continue
            }

            if (current != null) {
                val sub = subheading.matchEntire(line)?.groupValues?.get(1)?.trim()?.lowercase()
                if (sub == "agent notes") {
                    if (current.agentHeadingLine == null && current.generatedHeadingLine == null) {
                        current.agentHeadingLine = i
                    }
                    i++
                    continue
                }
                if (sub == "generated") {
                    if (current.generatedHeadingLine == null) current.generatedHeadingLine = i
                    i++
                    continue
                }
            }

            val name = heading.matchEntire(line)?.groupValues?.get(1)
            if (name == null) {
                i++
                continue
            }
            if (firstHeading == -1) firstHeading = i
            current?.bodyEnd = i
            current = NoteSection(name, i, i + 1, lines.size)
            sections.add(current)
            i++
        }

        val intro = when {
            firstHeading > introStart -> LineRange(introStart, firstHeading - 1)
            firstHeading == -1 && introStart < lines.size -> LineRange(introStart, lines.size - 1)
            else -> null
        }

        val firstByName = mutableMapOf<String, NoteSection>()
        val problems = mutableListOf<NotesProblem>()
        sections.forEach { section ->
            val key = normalizeName(section.name, frontmatter?.ecosystem)
            val first = firstByName[key]
            if (first == null) firstByName[key] = section
            else problems.add(NotesProblem(section.name, section.headingLine, first.headingLine))
        }

        return NotesFileModel(eol, hadBom, lines, frontmatter, aiComment, titleLine, intro, sections, problems)
    }

    fun findSection(model: NotesFileModel, name: String): NoteSection? {
        val key = normalizeName(name, model.frontmatter?.ecosystem)
        return model.sections.firstOrNull { normalizeName(it.name, model.frontmatter?.ecosystem) == key }
    }

    fun layers(model: NotesFileModel, section: NoteSection): SectionLayers {
        val humanEnd = section.agentHeadingLine ?: section.generatedHeadingLine ?: section.bodyEnd
        val agentStart = section.agentHeadingLine?.plus(1)
        val agentEnd = if (agentStart == null) null else section.generatedHeadingLine ?: section.bodyEnd
        return SectionLayers(
            slice(model.lines, section.bodyStart, humanEnd),
            slice(model.lines, agentStart, agentEnd),
            slice(model.lines, section.generatedHeadingLine, section.generatedHeadingLine?.let { section.bodyEnd }),
        )
    }

    fun orderedLayers(layers: SectionLayers, source: InlineSource): List<String> {
        val ordered = if (source == InlineSource.AI_FIRST || source == InlineSource.AI_ONLY) {
            listOf(layers.agent, layers.human)
        } else {
            listOf(layers.human, layers.agent)
        }
        return ordered.filter { it.isNotBlank() }
    }

    fun preview(layers: SectionLayers, source: InlineSource, maxLength: Int = 90): String {
        val human = layers.human.lineSequence()
            .firstOrNull { it.isNotBlank() }
            ?.trim()
            ?.replace(Regex("^[-*]\\s+"), "")
            .orEmpty()
        val purpose = layers.agent.lineSequence().mapNotNull { line ->
            val match = agentField.matchEntire(line) ?: return@mapNotNull null
            if (match.groupValues[1].equals("purpose", ignoreCase = true)) match.groupValues[2].trim() else null
        }.firstOrNull().orEmpty()
        val value = when (source) {
            InlineSource.HUMAN_FIRST -> human.ifBlank { purpose }
            InlineSource.AI_FIRST -> purpose.ifBlank { human }
            InlineSource.HUMAN_ONLY -> human
            InlineSource.AI_ONLY -> purpose
        }.ifBlank { "note" }
        return if (value.length > maxLength) value.take(maxLength - 1) + "…" else value
    }

    fun newNotesFile(
        name: String,
        human: String,
        agent: String = "",
        ecosystem: ManifestKind = ManifestKind.NPM,
    ): String {
        val body = composeLayers(human, agent)
        return buildString {
            if (ecosystem == ManifestKind.NPM) {
                append("---\nformat: dependency-notes/1\nlang: en\n---\n\n")
            } else {
                append("---\nformat: dependency-notes/2\necosystem: ${ecosystem.id}\nlang: en\n---\n\n")
            }
            if (ecosystem == ManifestKind.NPM) {
                append("<!-- Each \"## name\" below is a package from package.json. The text right under the\n")
                append("  heading is written by people. \"### Agent notes\" and everything below it is written\n")
                append("  by AI agents — rules in .pacmon/AGENT-RULES.md. -->\n\n")
            }
            if (ecosystem != ManifestKind.NPM) {
                append(formatCommentLines(ecosystem).joinToString("\n")).append("\n\n")
            }
            append("# Dependency Notes\n\n## ").append(name.trim()).append("\n\n")
            if (body.isNotEmpty()) append(body).append('\n')
        }
    }

    fun upsertHumanNote(text: String, name: String, human: String): String {
        val model = parse(text)
        val section = findSection(model, name)
        if (section == null) return insertSection(text, model, name, human)

        val humanEnd = section.agentHeadingLine ?: section.generatedHeadingLine ?: section.bodyEnd
        val hasTail = humanEnd < model.lines.size
        val region = mutableListOf("")
        val body = human.trim()
        if (body.isNotEmpty()) {
            region.addAll(body.split(Regex("\\r?\\n")))
            if (hasTail) region.add("")
        }
        return splice(model, section.headingLine + 1, humanEnd, region)
    }

    /** Replaces the two editable layers while preserving the generated tail verbatim. */
    fun upsertNoteLayers(text: String, name: String, human: String, agent: String): String {
        val model = parse(text)
        val section = findSection(model, name)
        if (section == null) return insertSection(text, model, name, composeLayers(human, agent))

        val editableEnd = section.generatedHeadingLine ?: section.bodyEnd
        val region = mutableListOf("")
        val humanLines = cleanLines(human)
        val agentLines = cleanLines(agent)
        if (humanLines.isNotEmpty()) region.addAll(humanLines)
        if (agentLines.isNotEmpty()) {
            if (region.lastOrNull()?.isNotEmpty() == true) region.add("")
            region.add(AGENT_NOTES_HEADING)
            region.add("")
            region.addAll(agentLines)
        }
        if (editableEnd < section.bodyEnd && region.lastOrNull()?.isNotEmpty() == true) region.add("")
        return splice(model, section.headingLine + 1, editableEnd, region)
    }

    private fun composeLayers(human: String, agent: String): String = buildString {
        val humanText = human.trim()
        val agentText = agent.trim()
        if (humanText.isNotEmpty()) append(humanText)
        if (agentText.isNotEmpty()) {
            if (isNotEmpty()) append("\n\n")
            append(AGENT_NOTES_HEADING).append("\n\n").append(agentText)
        }
    }

    private fun cleanLines(value: String): List<String> {
        val cleaned = value.trim()
        return if (cleaned.isEmpty()) emptyList() else cleaned.split(Regex("\\r?\\n"))
    }

    private fun insertSection(text: String, model: NotesFileModel, name: String, bodyValue: String): String {
        val normalizedNames = model.sections.map { normalizeName(it.name, model.frontmatter?.ecosystem) }
        val sorted = normalizedNames.zipWithNext().all { (left, right) -> left <= right }
        val key = normalizeName(name, model.frontmatter?.ecosystem)
        val before = if (sorted) model.sections.firstOrNull {
            normalizeName(it.name, model.frontmatter?.ecosystem) > key
        }?.headingLine else null
        val snippet = buildString {
            append("## ").append(name.trim()).append(model.eol).append(model.eol)
            if (bodyValue.isNotBlank()) append(bodyValue.trim().replace(Regex("\\r?\\n"), model.eol)).append(model.eol)
        }
        if (before == null) {
            val base = text.removeSuffix("\r\n").removeSuffix("\n")
            return base + model.eol + model.eol + snippet
        }
        val prefix = model.lines.take(before).joinToString(model.eol) + if (before > 0) model.eol else ""
        val suffix = model.lines.drop(before).joinToString(model.eol)
        val separator = if (prefix.endsWith(model.eol + model.eol)) "" else model.eol
        return (if (model.hadBom) "\uFEFF" else "") + prefix + separator + snippet + suffix
    }

    private fun splice(model: NotesFileModel, from: Int, to: Int, region: List<String>): String {
        val rebuilt = model.lines.take(from) + region + model.lines.drop(to)
        var output = rebuilt.joinToString(model.eol)
        if (!output.endsWith(model.eol)) output += model.eol
        return (if (model.hadBom) "\uFEFF" else "") + output
    }

    private fun slice(lines: List<String>, startValue: Int?, endValue: Int?): String {
        if (startValue == null || endValue == null) return ""
        var start = startValue
        var end = endValue
        while (start < end && lines[start].isBlank()) start++
        while (end > start && lines[end - 1].isBlank()) end--
        return lines.subList(start, end).joinToString("\n")
    }

    /**
     * Canonical form: frontmatter (format keys guaranteed), the format-owned
     * header comment, title, intro (if present), sections sorted by name with
     * canonical `## name` headings, one blank line between blocks, a single
     * trailing newline. Section bodies are kept verbatim (outer blank lines
     * trimmed). Duplicate sections are kept, in their relative order.
     */
    fun serialize(model: NotesFileModel, expectedEcosystem: ManifestKind? = null): String {
        val out = mutableListOf<String>()
        val ecosystem = model.frontmatter?.ecosystem ?: expectedEcosystem.takeIf { model.frontmatter == null }
        out.addAll(frontmatterLines(model, expectedEcosystem))
        out.add("")
        out.addAll(formatCommentLines(ecosystem))
        out.add("")
        out.add(DEFAULT_TITLE)

        if (model.intro != null) {
            val intro = trimmedLines(model.lines, model.intro.startLine, model.intro.endLine + 1)
            if (intro.isNotEmpty()) {
                out.add("")
                out.addAll(intro)
            }
        }

        val sorted = model.sections
            .sortedWith(compareBy<NoteSection> { normalizeName(it.name, ecosystem) }.thenBy { it.headingLine })
        for (section in sorted) {
            out.add("")
            out.add("## ${section.name.trim()}")
            val body = trimmedLines(model.lines, section.bodyStart, section.bodyEnd)
            if (body.isNotEmpty()) {
                out.add("")
                out.addAll(body)
            }
        }

        return (if (model.hadBom) "﻿" else "") + out.joinToString(model.eol) + model.eol
    }

    /** Parse + serialize convenience: rewrites [text] into canonical form. */
    fun normalizeText(text: String, expectedEcosystem: ManifestKind? = null): String =
        serialize(parse(text), expectedEcosystem)

    private fun frontmatterLines(model: NotesFileModel, expectedEcosystem: ManifestKind?): List<String> {
        val desired = when {
            model.frontmatter == null -> expectedEcosystem
            model.frontmatter.formatVersion == FORMAT_VERSION_V2 -> model.frontmatter.ecosystem
            else -> null
        }
        val defaults = if (desired != null && desired != ManifestKind.NPM) {
            listOf("format: $FORMAT_VERSION_V2", "ecosystem: ${desired.id}", "lang: en")
        } else {
            listOf("format: $FORMAT_VERSION", "lang: en")
        }
        val frontmatter = model.frontmatter ?: return listOf("---") + defaults + listOf("---")
        val inner = model.lines.subList(frontmatter.startLine + 1, frontmatter.endLine)
        val present = inner.mapNotNull { Regex("^([A-Za-z][\\w-]*):").find(it)?.groupValues?.get(1) }.toSet()
        val missing = defaults.filter { it.substringBefore(':') !in present }
        return listOf("---") + inner + missing + listOf("---")
    }

    private fun trimmedLines(lines: List<String>, startValue: Int, endValue: Int): List<String> {
        var start = startValue
        var end = endValue
        while (start < end && lines[start].isBlank()) start++
        while (end > start && lines[end - 1].isBlank()) end--
        return lines.subList(start, end)
    }
}
