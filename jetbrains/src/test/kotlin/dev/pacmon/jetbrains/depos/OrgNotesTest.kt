package dev.pacmon.jetbrains.depos

import com.google.gson.JsonParser
import dev.pacmon.jetbrains.core.ManifestKind
import dev.pacmon.jetbrains.core.NotesCore
import dev.pacmon.jetbrains.core.NotesLint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The counterpart of `src/test/unit/orgNotes.test.ts`. */
class OrgNotesTest {
    private val repo = "01HREPO0000000000000000000"

    private fun note(
        ulid: String,
        name: String,
        human: String = "Why $name.",
        ecosystem: String = "npm",
        fields: String = "[]",
        scope: String = """{"kind":"all"}""",
    ) = """{"ulid":"$ulid","ecosystem":"$ecosystem","noteKey":"${name.lowercase()}","displayName":"$name",
        |"humanText":${JsonParser.parseString("\"" + human.replace("\n", "\\n") + "\"")},"fields":$fields,
        |"scope":$scope,"updatedAt":"2026-10-01T10:00:00.000Z","updatedByName":"Ada"}""".trimMargin()

    private fun sync(changes: String, full: Boolean = true, canEdit: Boolean = true, cursor: String = "2026-10-01T10:00:00.000Z|01H") =
        """{"organization":{"ulid":"01HORG","name":"Kontra"},"canEdit":$canEdit,"full":$full,"changes":[$changes],"cursor":"$cursor","more":false}"""

    private fun parse(text: String) = OrgNotes.parseSync(JsonParser.parseString(text))

    @Test
    fun `a sync answer is read`() {
        val page = parse(sync("""{"kind":"upsert","note":${note("u1", "express")}},{"kind":"delete","ulid":"u2","ecosystem":"npm","noteKey":"lodash"}"""))
        assertNotNull(page)
        assertEquals(2, page!!.changes.size)
        assertEquals("Kontra", page.orgName)
        assertTrue(page.canEdit)
    }

    @Test
    fun `an answer of another shape is refused whole`() {
        assertNull(OrgNotes.parseSync(JsonParser.parseString("null")))
        assertNull(parse(sync("").replace("\"canEdit\":true", "\"canEdit\":\"yes\"")))
        assertNull(parse(sync("""{"kind":"rename"}""")))
        assertNull(parse(sync("""{"kind":"upsert","note":${note("u1", "express", scope = """{"kind":"some"}""")}}""")))
        assertNull(parse(sync("""{"kind":"upsert","note":${note("u1", "express", human = "x".repeat(100_001))}}""")))
    }

    @Test
    fun `a copy is loaded from its first page on`() {
        val copy = OrgNotesCopy("01HORG")
        assertFalse(copy.loaded)
        assertTrue(copy.apply(parse(sync(""))!!, 42))
        assertTrue(copy.loaded)
        assertTrue(copy.canEdit)
        assertEquals(42, copy.receivedAt)
    }

    @Test
    fun `a full sync replaces the copy`() {
        val copy = OrgNotesCopy("01HORG")
        copy.apply(parse(sync("""{"kind":"upsert","note":${note("u1", "lodash")}}"""))!!, 1)
        copy.apply(parse(sync("""{"kind":"upsert","note":${note("u2", "express")}}"""))!!, 2)
        assertNull(copy.note(ManifestKind.NPM, "lodash", repo))
        assertNotNull(copy.note(ManifestKind.NPM, "express", repo))
    }

    @Test
    fun `a delete removes only the note it names`() {
        val copy = OrgNotesCopy("01HORG")
        copy.apply(parse(sync("""{"kind":"upsert","note":${note("old", "express")}}"""))!!, 1)
        copy.apply(parse(sync("""{"kind":"delete","ulid":"old","ecosystem":"npm","noteKey":"express"},{"kind":"upsert","note":${note("new", "express")}}""", full = false))!!, 2)
        assertEquals("new", copy.note(ManifestKind.NPM, "express", repo)?.ulid)
        // A late delete of the old note must not take the newer one with it.
        copy.apply(parse(sync("""{"kind":"delete","ulid":"old","ecosystem":"npm","noteKey":"express"}""", full = false))!!, 3)
        assertEquals("new", copy.note(ManifestKind.NPM, "express", repo)?.ulid)
    }

    @Test
    fun `a manifest name finds its note the way Depos stores it`() {
        val copy = OrgNotesCopy("01HORG")
        copy.apply(parse(sync("""{"kind":"upsert","note":${note("u1", "express")}},{"kind":"upsert","note":{"ulid":"u2","ecosystem":"python","noteKey":"django-rest","displayName":"django-rest","humanText":"x","fields":[],"scope":{"kind":"all"},"updatedAt":"t","updatedByName":null}}"""))!!, 1)
        assertNotNull(copy.note(ManifestKind.NPM, "Express", repo))
        assertNotNull(copy.note(ManifestKind.PYTHON, "django.rest", repo))
    }

    @Test
    fun `a note scoped to other repositories is not this one's`() {
        val copy = OrgNotesCopy("01HORG")
        copy.apply(parse(sync("""{"kind":"upsert","note":${note("u1", "express", scope = """{"kind":"repos","repositoryUlids":["01HOTHER"]}""")}}"""))!!, 1)
        assertNull(copy.note(ManifestKind.NPM, "express", repo))
        assertNotNull(copy.note(ManifestKind.NPM, "express", "01HOTHER"))
    }

    @Test
    fun `a snapshot round-trips, and a damaged one is refused`() {
        val copy = OrgNotesCopy("01HORG")
        copy.apply(parse(sync("""{"kind":"upsert","note":${note("u1", "express", fields = """[{"key":"purpose","value":"HTTP"}]""")}}"""))!!, 7)
        val text = OrgNotes.snapshotJson(copy.snapshot())
        val back = OrgNotes.parseSnapshot(JsonParser.parseString(text))
        assertNotNull(back)
        assertEquals(copy.snapshot(), back)
        assertTrue(OrgNotesCopy("01HORG", back).loaded)
        assertNull(OrgNotes.parseSnapshot(JsonParser.parseString(text.replace("\"humanText\"", "\"human\""))))
    }

    @Test
    fun `the notes text reads back as a notes file with no problems`() {
        val copy = OrgNotesCopy("01HORG")
        copy.apply(parse(sync(listOf(
            """{"kind":"upsert","note":${note("u1", "lodash")}}""",
            """{"kind":"upsert","note":${note("u2", "express", human = "Router.\n# not a title\n  ## not a section", fields = """[{"key":"purpose","value":"HTTP\nAPI"},{"key":"owner","value":"platform"}]""")}}""",
            """{"kind":"upsert","note":${note("u3", "serde", ecosystem = "cargo")}}""",
            """{"kind":"upsert","note":${note("u4", "axios", scope = """{"kind":"repos","repositoryUlids":["01HOTHER"]}""")}}""",
        ).joinToString(",")))!!, 1)

        val text = copy.notesText(ManifestKind.NPM, repo)
        val model = NotesCore.parse(text)
        assertEquals(listOf("express", "lodash"), model.sections.map { it.name })
        val layers = NotesCore.layers(model, NotesCore.findSection(model, "express")!!)
        assertEquals("Router.\n\\# not a title\n  \\## not a section", layers.human)
        assertEquals("- purpose: HTTP API\n- owner: platform", layers.agent)
        assertTrue(text.contains("<!-- Notes of Kontra, from Depos."))
        assertTrue(NotesLint.lint(model, listOf("express", "lodash"), ManifestKind.NPM).none { it.message().contains("heading") })

        val cargo = copy.notesText(ManifestKind.CARGO, repo)
        assertTrue(cargo, cargo.startsWith("---\nformat: dependency-notes/2\necosystem: cargo\nlang: en\n---\n"))
    }

    @Test
    fun `agent lines that are not fields are counted, not kept`() {
        val (fields, dropped) = OrgNotes.agentTextToFields("- purpose: HTTP\nSome prose.\n\n- Owner: platform")
        assertEquals(listOf(OrgNoteField("purpose", "HTTP"), OrgNoteField("owner", "platform")), fields)
        assertEquals(1, dropped)
        assertEquals("- purpose: a b\n- owner: x", OrgNotes.fieldsToAgentText(listOf(OrgNoteField("purpose", "a\nb"), OrgNoteField("owner", "x"))))
    }
}
