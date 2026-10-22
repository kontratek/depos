package dev.pacmon.jetbrains.depos

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import dev.pacmon.jetbrains.core.ManifestKind
import dev.pacmon.jetbrains.core.ManifestRegistry
import dev.pacmon.jetbrains.core.NotesCore
import dev.pacmon.jetbrains.depos.DeposJson.bool
import dev.pacmon.jetbrains.depos.DeposJson.isNull
import dev.pacmon.jetbrains.depos.DeposJson.list
import dev.pacmon.jetbrains.depos.DeposJson.number
import dev.pacmon.jetbrains.depos.DeposJson.str

/**
 * The org notes of one organization, as the IDE keeps them on the user's machine
 * (docs/format.md, "The organization layer", org mode). A port of
 * `src/ext/web/orgNotes.ts`. Depos is the source; this is a copy filled by a delta
 * sync.
 */

data class OrgNoteField(val key: String, val value: String)

sealed interface OrgNoteScope {
    data object All : OrgNoteScope
    data class Repos(val repositoryUlids: List<String>) : OrgNoteScope
}

data class OrgNote(
    val ulid: String,
    val ecosystem: String,
    val noteKey: String,
    val displayName: String,
    val humanText: String,
    val fields: List<OrgNoteField>,
    val scope: OrgNoteScope,
    /** Sent back as the version the user edited. */
    val updatedAt: String,
    val updatedByName: String?,
) {
    fun covers(repoUlid: String): Boolean = when (scope) {
        OrgNoteScope.All -> true
        is OrgNoteScope.Repos -> repoUlid in scope.repositoryUlids
    }
}

sealed interface OrgNoteChange {
    data class Upsert(val note: OrgNote) : OrgNoteChange
    data class Delete(val ulid: String, val ecosystem: String, val noteKey: String) : OrgNoteChange
}

data class OrgNotesSync(
    val orgUlid: String,
    val orgName: String,
    val canEdit: Boolean,
    val full: Boolean,
    val changes: List<OrgNoteChange>,
    val cursor: String,
    val more: Boolean,
)

/** What is written to disk between sessions. */
data class OrgNotesSnapshot(
    val orgUlid: String,
    val orgName: String,
    val canEdit: Boolean,
    val cursor: String,
    /** When the server last answered (ms since epoch). */
    val receivedAt: Long,
    val notes: List<OrgNote>,
)

object OrgNotes {
    /** One note as the server sends it after a save, checked. */
    fun parseNote(json: JsonElement?): OrgNote? {
        val value = DeposJson.obj(json) ?: return null
        val ulid = value.str("ulid") ?: return null
        val ecosystem = value.str("ecosystem") ?: return null
        val noteKey = value.str("noteKey") ?: return null
        val displayName = value.str("displayName") ?: return null
        val humanText = value.str("humanText", DeposJson.TEXT) ?: return null
        val updatedAt = value.str("updatedAt") ?: return null
        val rawFields = value.list("fields") ?: return null
        val updatedByName = if (value.isNull("updatedByName")) null else value.str("updatedByName") ?: return null
        val fields = rawFields.map { item ->
            val field = item as? JsonObject ?: return null
            OrgNoteField(field.str("key") ?: return null, field.str("value", DeposJson.TEXT) ?: return null)
        }
        val rawScope = value.get("scope") as? JsonObject ?: return null
        val scope = when (rawScope.str("kind")) {
            "all" -> OrgNoteScope.All
            "repos" -> {
                val ulids = rawScope.list("repositoryUlids") ?: return null
                OrgNoteScope.Repos(ulids.map { item -> DeposJson.stringOf(item) ?: return null })
            }
            else -> return null
        }
        return OrgNote(ulid, ecosystem, noteKey, displayName, humanText, fields, scope, updatedAt, updatedByName)
    }

    /** The answer of `GET /api/extension/organizations/<ulid>/notes`, checked; null when it has another shape. */
    fun parseSync(json: JsonElement?): OrgNotesSync? {
        val value = DeposJson.obj(json) ?: return null
        val organization = value.get("organization") as? JsonObject ?: return null
        val orgUlid = organization.str("ulid") ?: return null
        val orgName = organization.str("name") ?: return null
        val cursor = value.str("cursor") ?: return null
        val canEdit = value.bool("canEdit") ?: return null
        val full = value.bool("full") ?: return null
        val more = value.bool("more") ?: return null
        val rawChanges = value.list("changes") ?: return null
        val changes = rawChanges.map { item ->
            val change = item as? JsonObject ?: return null
            when (change.str("kind")) {
                "upsert" -> OrgNoteChange.Upsert(parseNote(change.get("note")) ?: return null)
                "delete" -> OrgNoteChange.Delete(
                    change.str("ulid") ?: return null,
                    change.str("ecosystem") ?: return null,
                    change.str("noteKey") ?: return null,
                )
                else -> return null
            }
        }
        return OrgNotesSync(orgUlid, orgName, canEdit, full, changes, cursor, more)
    }

    /** A snapshot read back from disk, checked like a server answer: the file may be old or damaged. */
    fun parseSnapshot(json: JsonElement?): OrgNotesSnapshot? {
        val value = DeposJson.obj(json) ?: return null
        val orgUlid = value.str("orgUlid") ?: return null
        val orgName = value.str("orgName") ?: return null
        val cursor = value.str("cursor") ?: return null
        val canEdit = value.bool("canEdit") ?: return null
        val receivedAt = value.number("receivedAt") ?: return null
        val notes = (value.list("notes") ?: return null).map { parseNote(it) ?: return null }
        return OrgNotesSnapshot(orgUlid, orgName, canEdit, cursor, receivedAt, notes)
    }

    fun snapshotJson(snapshot: OrgNotesSnapshot): String = JsonObject().apply {
        addProperty("orgUlid", snapshot.orgUlid)
        addProperty("orgName", snapshot.orgName)
        addProperty("canEdit", snapshot.canEdit)
        addProperty("cursor", snapshot.cursor)
        addProperty("receivedAt", snapshot.receivedAt)
        add("notes", JsonArray().apply { snapshot.notes.forEach { add(noteJson(it)) } })
    }.toString()

    fun noteJson(note: OrgNote): JsonObject = JsonObject().apply {
        addProperty("ulid", note.ulid)
        addProperty("ecosystem", note.ecosystem)
        addProperty("noteKey", note.noteKey)
        addProperty("displayName", note.displayName)
        addProperty("humanText", note.humanText)
        add("fields", fieldsJson(note.fields))
        add("scope", JsonObject().apply {
            when (val scope = note.scope) {
                OrgNoteScope.All -> addProperty("kind", "all")
                is OrgNoteScope.Repos -> {
                    addProperty("kind", "repos")
                    add("repositoryUlids", JsonArray().apply { scope.repositoryUlids.forEach(::add) })
                }
            }
        })
        addProperty("updatedAt", note.updatedAt)
        if (note.updatedByName == null) add("updatedByName", JsonNull.INSTANCE) else addProperty("updatedByName", note.updatedByName)
    }

    fun fieldsJson(fields: List<OrgNoteField>): JsonArray = JsonArray().apply {
        fields.forEach { field ->
            add(JsonObject().apply {
                addProperty("key", field.key)
                addProperty("value", field.value)
            })
        }
    }

    /** The agent layer of an org note: one `- key: value` line per field. */
    fun fieldsToAgentText(fields: List<OrgNoteField>): String =
        fields.joinToString("\n") { "- ${it.key}: ${it.value.replace(Regex("[\\r\\n]+"), " ")}" }

    private val agentField = Regex("^\\s*[-*]\\s+([a-z][a-z0-9_-]*)\\s*:\\s*(.*)$", RegexOption.IGNORE_CASE)

    /**
     * The fields of an agent layer the user wrote. An org note holds fields only, so
     * prose lines are left out; `dropped` counts them so the IDE can say so.
     */
    fun agentTextToFields(agent: String): Pair<List<OrgNoteField>, Int> {
        val fields = agent.split('\n').mapNotNull { line ->
            agentField.matchEntire(line)?.let { OrgNoteField(it.groupValues[1].lowercase(), it.groupValues[2].trim()) }
        }
        val nonEmpty = agent.split(Regex("\\r?\\n")).count { it.isNotBlank() }
        return fields to (nonEmpty - fields.size)
    }

    /**
     * A line of an org note's human text that the notes format would read as a
     * heading is escaped (`\#`), so the text stays inside its section.
     */
    internal fun escapeHeadings(text: String): String = text.split(Regex("\\r?\\n")).joinToString("\n") { line ->
        if (Regex("^\\s{0,3}#").containsMatchIn(line)) line.replaceFirst("#", "\\#") else line
    }

    /** `composeSectionBody` of `src/core/serialize.ts`: the human layer, then the agent block. */
    internal fun sectionBody(human: String, agent: String): String {
        val out = mutableListOf<String>()
        val humanText = human.trim()
        val agentText = agent.trim()
        if (humanText.isNotEmpty()) out.addAll(humanText.split(Regex("\\r?\\n")))
        if (agentText.isNotEmpty()) {
            if (out.isNotEmpty()) out.add("")
            out.add(NotesCore.AGENT_NOTES_HEADING)
            out.add("")
            out.addAll(agentText.split(Regex("\\r?\\n")))
        }
        return out.joinToString("\n")
    }
}

/**
 * The copy of one organization's org notes. Not thread-safe on its own: [OrgContext]
 * guards every use with its lock.
 */
class OrgNotesCopy(val orgUlid: String, snapshot: OrgNotesSnapshot? = null) {
    private val byKey = LinkedHashMap<String, OrgNote>()

    /** Bumped on every change: the version of the notes text built from this copy. */
    var version = 0
        private set
    var orgName: String = snapshot?.orgName.orEmpty()
        private set
    var canEdit: Boolean = snapshot?.canEdit ?: false
        private set
    var cursor: String = snapshot?.cursor.orEmpty()
    var receivedAt: Long = snapshot?.receivedAt ?: 0
        private set

    init {
        snapshot?.notes?.forEach { byKey[DeposJson.lookupKey(it.ecosystem, it.noteKey)] = it }
    }

    /** True once the copy has been filled from the server at least once. */
    val loaded: Boolean get() = cursor.isNotEmpty()

    /** Apply one page of a sync, in order. True when anything the user sees changed. */
    fun apply(page: OrgNotesSync, now: Long): Boolean {
        var changed = page.full && byKey.isNotEmpty()
        if (page.full) byKey.clear()
        if (orgName != page.orgName || canEdit != page.canEdit) changed = true
        orgName = page.orgName
        canEdit = page.canEdit
        for (change in page.changes) {
            when (change) {
                is OrgNoteChange.Upsert -> {
                    byKey[DeposJson.lookupKey(change.note.ecosystem, change.note.noteKey)] = change.note
                    changed = true
                }
                is OrgNoteChange.Delete -> {
                    val key = DeposJson.lookupKey(change.ecosystem, change.noteKey)
                    // Only the note that was deleted: a newer note of the same package stays.
                    if (byKey[key]?.ulid == change.ulid) {
                        byKey.remove(key)
                        changed = true
                    }
                }
            }
        }
        cursor = page.cursor
        receivedAt = now
        if (changed) version++
        return changed
    }

    /** A note the server just saved, ahead of the next sync. */
    fun put(note: OrgNote) {
        byKey[DeposJson.lookupKey(note.ecosystem, note.noteKey)] = note
        version++
    }

    fun remove(ecosystem: String, noteKey: String) {
        if (byKey.remove(DeposJson.lookupKey(ecosystem, noteKey)) != null) version++
    }

    fun snapshot(): OrgNotesSnapshot = OrgNotesSnapshot(orgUlid, orgName, canEdit, cursor, receivedAt, byKey.values.toList())

    /** The org note of a package, if its scope covers the repository. */
    fun note(ecosystem: ManifestKind, name: String, repoUlid: String): OrgNote? {
        val note = byKey[DeposJson.lookupKey(ecosystem.id, ManifestRegistry.normalizeName(name, ecosystem))]
        return note?.takeIf { it.covers(repoUlid) }
    }

    /**
     * The org notes of one ecosystem that cover a repository, as the text of a notes
     * file. The IDE reads it wherever it would read DEPENDENCY-NOTES.md, so every view
     * shows org notes through the same core code. It is never written to disk.
     */
    fun notesText(ecosystem: ManifestKind, repoUlid: String): String {
        val notes = byKey.values
            .filter { it.ecosystem == ecosystem.id && it.covers(repoUlid) }
            .sortedWith { a, b -> a.displayName.compareTo(b.displayName) }
        val lines = mutableListOf<String>()
        lines.add("---")
        if (ecosystem == ManifestKind.NPM) {
            lines.add("format: ${NotesCore.FORMAT_VERSION}")
        } else {
            lines.add("format: ${NotesCore.FORMAT_VERSION_V2}")
            lines.add("ecosystem: ${ecosystem.id}")
        }
        lines.add("lang: en")
        lines.add("---")
        lines.add("")
        lines.add("<!-- Notes of ${orgName.replace("-->", "")}, from Depos. Read-only: change them in the note editor or in Depos. -->")
        lines.add("")
        lines.add(NotesCore.DEFAULT_TITLE)
        for (note in notes) {
            lines.add("")
            lines.add("## ${note.displayName.replace(Regex("[\\r\\n]+"), " ").trim()}")
            lines.add("")
            val body = OrgNotes.sectionBody(OrgNotes.escapeHeadings(note.humanText), OrgNotes.fieldsToAgentText(note.fields))
            if (body.isNotEmpty()) lines.addAll(body.split('\n'))
        }
        return lines.joinToString("\n") + "\n"
    }
}
