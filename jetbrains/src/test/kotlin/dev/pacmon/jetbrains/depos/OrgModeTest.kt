package dev.pacmon.jetbrains.depos

import com.google.gson.JsonParser
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.ui.EditorNotificationPanel
import dev.pacmon.jetbrains.editor.PacmonOrgModeNotificationProvider
import dev.pacmon.jetbrains.service.PacmonProjectService

/**
 * Org mode in the editor, with the local copies filled by hand as a finished
 * refresh would: the note comes from the org notes, the allowlist marks the
 * manifest line, and the notes file says it is not used.
 */
class OrgModeTest : BasePlatformTestCase() {
    private val repo = "01HREPO"

    override fun tearDown() {
        try {
            OrgContext.getInstance(project).clearForTest()
        } finally {
            super.tearDown()
        }
    }

    private fun copy(canEdit: Boolean = true): OrgNotesCopy {
        val text = """{"organization":{"ulid":"01HORG","name":"Kontra"},"canEdit":$canEdit,"full":true,"more":false,
            |"cursor":"c","changes":[{"kind":"upsert","note":{"ulid":"u1","ecosystem":"npm","noteKey":"express",
            |"displayName":"express","humanText":"The HTTP layer, from Depos.","fields":[{"key":"purpose","value":"HTTP"}],
            |"scope":{"kind":"all"},"updatedAt":"2026-10-01T10:00:00.000Z","updatedByName":"Ada"}}]}""".trimMargin()
        return OrgNotesCopy("01HORG").apply { apply(OrgNotes.parseSync(JsonParser.parseString(text))!!, 1) }
    }

    private fun layer(mode: String): OrgLayer = OrgLayer(OrgLayers.parse(JsonParser.parseString(
        """{"organization":{"ulid":"01HORG","name":"Kontra"},"repository":{"ulid":"$repo","fullName":"kontratek/api"},
          |"dependencyPagePath":"/dashboard/01HORG/dependencies","policies":[{"ecosystem":"npm","mode":"$mode","decisions":[
          |{"noteKey":"express","decision":"allow","reason":"","expiresAt":null},
          |{"noteKey":"left-pad","decision":"deny","reason":"Use padStart.","expiresAt":null}]}]}""".trimMargin(),
    ))!!)

    private fun orgMode(mode: String = "enforce", canEdit: Boolean = true) {
        val root = myFixture.tempDirFixture.getFile(".")!!.path
        OrgContext.getInstance(project).setForTest(root, "https://depos.example.com", repo, copy(canEdit), layer(mode))
    }

    private val packageJson = """{ "dependencies": { "express": "^4", "left-pad": "^1", "react": "^18" } }"""

    fun testTheNoteComesFromTheOrgNotesNotTheFile() {
        myFixture.addFileToProject(".pacmon/DEPENDENCY-NOTES.md", "# Dependency Notes\n\n## express\n\nFrom the file.\n")
        val manifest = myFixture.addFileToProject("package.json", packageJson).virtualFile
        orgMode()
        val service = project.getService(PacmonProjectService::class.java)
        val note = service.noteFor(manifest, "express")
        assertNotNull(note)
        assertEquals("The HTTP layer, from Depos.", note!!.layers.human)
        assertEquals("- purpose: HTTP", note.layers.agent)
        assertNull(note.file)
        assertEquals("Kontra", note.orgName)
        assertNull(service.noteFor(manifest, "react"))
        assertTrue(service.isOrgMode(manifest))
    }

    private fun highlights(severity: HighlightSeverity): List<Pair<String, HighlightSeverity>> {
        val file = myFixture.addFileToProject("package.json", packageJson)
        myFixture.configureFromExistingVirtualFile(file.virtualFile)
        return myFixture.doHighlighting(severity)
            .filter { it.description?.contains("Kontra") == true }
            .map { it.description to it.severity }
    }

    fun testEnforceMarksDeniedAndUnlistedPackagesAsErrors() {
        orgMode("enforce")
        val found = highlights(HighlightSeverity.WARNING)
        assertSameElements(
            found,
            "left-pad is denied in Kontra. Reason: Use padStart." to HighlightSeverity.ERROR,
            "react is not listed in the allowlist of Kontra." to HighlightSeverity.ERROR,
        )
    }

    fun testAuditMarksThemAsWarnings() {
        orgMode("audit")
        val found = highlights(HighlightSeverity.WARNING)
        assertSameElements(
            found,
            "left-pad is denied in Kontra. Reason: Use padStart." to HighlightSeverity.WARNING,
            "react is not listed in the allowlist of Kontra." to HighlightSeverity.WARNING,
        )
    }

    fun testOutsideOrgModeNothingIsMarked() {
        assertEmpty(highlights(HighlightSeverity.WARNING))
    }

    fun testTheNotesFileCarriesABannerInOrgModeOnly() {
        myFixture.addFileToProject("package.json", packageJson)
        val notes = myFixture.addFileToProject(".pacmon/DEPENDENCY-NOTES.md", "# Dependency Notes\n\n## express\n\nFrom the file.\n")
        myFixture.configureFromExistingVirtualFile(notes.virtualFile)
        val provider = PacmonOrgModeNotificationProvider()
        assertNull(provider.collectNotificationData(project, notes.virtualFile))

        orgMode()
        val banner = provider.collectNotificationData(project, notes.virtualFile)
            ?.apply(FileEditorManager.getInstance(project).selectedEditor!!) as? EditorNotificationPanel
        assertNotNull(banner)
        assertEquals(DeposStrings.orgModeNotesFile("Kontra"), banner!!.text)
    }

    fun testAMemberWhoIsNotAnAdminCannotSave() {
        val manifest = myFixture.addFileToProject("package.json", packageJson).virtualFile
        orgMode(canEdit = false)
        try {
            OrgContext.getInstance(project).saveNote(manifest, "express", "Changed.", null)
            fail("saved")
        } catch (error: DeposException) {
            assertEquals(DeposStrings.orgNoteReadOnly, error.message)
        }
    }
}
