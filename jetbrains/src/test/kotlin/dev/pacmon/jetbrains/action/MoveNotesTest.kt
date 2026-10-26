package dev.pacmon.jetbrains.action

import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.Notification
import com.intellij.notification.Notifications
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.TestDialog
import com.intellij.openapi.ui.TestDialogManager
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.ui.UIUtil
import dev.pacmon.jetbrains.core.ManifestKind
import dev.pacmon.jetbrains.core.NotesCore
import dev.pacmon.jetbrains.service.PacmonProjectService
import dev.pacmon.jetbrains.settings.MonorepoModes

/** "Move Notes to .depos/": the counterpart of `src/ext/commands/moveNotes.ts`. */
class MoveNotesTest : BasePlatformTestCase() {
    override fun setUp() {
        super.setUp()
        service().state.monorepoMode = MonorepoModes.NEAREST
        // The light project is shared between tests: the suggestion is made once per project.
        PropertiesComponent.getInstance(project).unsetValue("depos.moveNotesSuggested")
    }

    private fun service() = project.getService(PacmonProjectService::class.java)

    private fun create(path: String, text: String): VirtualFile = myFixture.tempDirFixture.createFile(path, text)

    private fun text(file: VirtualFile): String =
        FileDocumentManager.getInstance().getDocument(file)?.text ?: String(file.contentsToByteArray()).replace("\r\n", "\n")

    /** Runs [block] with every dialog answered by [answer]; returns the messages the dialogs showed. */
    private fun dialogs(answer: Int = Messages.OK, block: () -> Unit): List<String> {
        val shown = mutableListOf<String>()
        val previous = TestDialogManager.setTestDialog(TestDialog { message -> shown.add(message); answer })
        try {
            block()
        } finally {
            TestDialogManager.setTestDialog(previous)
        }
        return shown
    }

    fun testMovesEveryPacmonDirectoryAndWhatPointsIntoThem() {
        val packageJson = create("package.json", """{"dependencies":{"vue":"3"}}""")
        val root = packageJson.parent
        create(".pacmon/DEPENDENCY-NOTES.md", NotesCore.newNotesFile("vue", "Frontend", dir = ".pacmon"))
        create(
            ".pacmon/cargo/DEPENDENCY-NOTES.md",
            NotesCore.newNotesFile("serde", "Serialization", ecosystem = ManifestKind.CARGO, dir = ".pacmon"),
        )
        create(".pacmon/AGENT-RULES.md", "Notes in `.pacmon/DEPENDENCY-NOTES.md`.\n")
        create("apps/web/package.json", """{"dependencies":{"react":"19"}}""")
        create("apps/web/.pacmon/DEPENDENCY-NOTES.md", NotesCore.newNotesFile("react", "UI", dir = ".pacmon"))
        create("node_modules/some-package/.pacmon/DEPENDENCY-NOTES.md", "## left-pad\n\nvendored\n")
        create("AGENTS.md", "# AGENTS\n\nintro\n\n<!-- pacmon:start -->\nold\n<!-- pacmon:end -->\n")
        create("CLAUDE.md", "# Claude\n\nno block here\n")

        assertEquals(
            listOf(".pacmon", "apps/web/.pacmon"),
            MoveNotes.legacyDirectories(project).map { service().displayPath(it) },
        )

        val shown = dialogs { MoveNotes.moveToDepos(project, confirmed = true) }

        assertEmpty(shown)
        assertNull(root.findChild(".pacmon"))
        assertNull(root.findFileByRelativePath("apps/web/.pacmon"))
        val notes = root.findFileByRelativePath(".depos/DEPENDENCY-NOTES.md")!!
        for (moved in listOf(notes, root.findFileByRelativePath(".depos/cargo/DEPENDENCY-NOTES.md")!!,
            root.findFileByRelativePath("apps/web/.depos/DEPENDENCY-NOTES.md")!!)) {
            val text = text(moved)
            assertTrue(moved.path, text.contains("rules in .depos/AGENT-RULES.md"))
            assertFalse(moved.path, text.contains(".pacmon/"))
        }
        assertTrue(text(notes).contains("## vue\n\nFrontend\n"))
        // Dependencies of dependencies are not the repository's.
        assertNotNull(root.findFileByRelativePath("node_modules/some-package/.pacmon/DEPENDENCY-NOTES.md"))
        // The rules, from the plugin's own copy, for .depos/.
        val rules = text(root.findFileByRelativePath(".depos/AGENT-RULES.md")!!)
        assertTrue(rules.contains("`.depos/DEPENDENCY-NOTES.md`"))
        assertFalse(rules.contains(".pacmon/"))
        // The pointer block, in the file that had one; the other is left alone.
        val agents = text(root.findChild("AGENTS.md")!!)
        assertTrue(agents, agents.startsWith("# AGENTS\n\nintro\n\n<!-- depos:start -->"))
        assertTrue(agents.contains("`.depos/AGENT-RULES.md`"))
        assertFalse(agents.contains("pacmon:"))
        assertEquals("# Claude\n\nno block here\n", text(root.findChild("CLAUDE.md")!!))
        // The notes are read from their new place, and the next first note goes there too.
        assertEquals(notes.path, service().resolveNotesFile(packageJson)?.path)
        assertEquals(".depos", service().notesDirForManifest(create("Cargo.toml", "[dependencies]\nserde = \"1\"")))
    }

    fun testAsksFirst() {
        val legacy = create(".pacmon/DEPENDENCY-NOTES.md", "## vue\n\nFrontend\n")
        create("apps/web/.pacmon/DEPENDENCY-NOTES.md", "## react\n\nUI\n")

        val shown = dialogs(answer = Messages.CANCEL) { MoveNotes.moveToDepos(project) }

        assertEquals(listOf(MoveNotes.confirm(2)), shown)
        assertEquals(
            "Move 2 .pacmon/ directories to .depos/? Versions from before Depos read .pacmon/ only: " +
                "move once everyone working here has updated.",
            MoveNotes.confirm(2),
        )
        assertEquals(
            "Move the .pacmon/ directory to .depos/? Versions from before Depos read .pacmon/ only: " +
                "move once everyone working here has updated.",
            MoveNotes.confirm(1),
        )
        assertTrue(legacy.isValid)
        assertEquals(".pacmon", legacy.parent.name)
        assertNull(legacy.parent.parent.findChild(".depos"))
    }

    fun testMovesAfterTheQuestionIsAnswered() {
        val legacy = create(".pacmon/DEPENDENCY-NOTES.md", "## vue\n\nFrontend\n")

        val shown = dialogs { MoveNotes.moveToDepos(project) }

        assertEquals(listOf(MoveNotes.confirm(1)), shown)
        assertEquals(".depos", legacy.parent.name)
    }

    fun testRefusesWhenADeposDirectoryIsAlreadyBesideOne() {
        val legacy = create(".pacmon/DEPENDENCY-NOTES.md", "## vue\n\nold\n")
        create(".depos/DEPENDENCY-NOTES.md", "## vue\n\nnew\n")

        val shown = dialogs { MoveNotes.moveToDepos(project) }

        assertEquals(
            listOf("Depos: a .depos/ directory already exists beside .pacmon. Merge the two by hand, then run Move Notes to .depos/ again."),
            shown,
        )
        assertEquals(".pacmon", legacy.parent.name)
    }

    fun testSaysSoWhenThereIsNothingToMove() {
        create(".depos/DEPENDENCY-NOTES.md", "## vue\n\nnew\n")

        val shown = dialogs { MoveNotes.moveToDepos(project) }

        assertEquals(listOf(MoveNotes.NONE), shown)
    }

    fun testOffersTheMoveOncePerProjectForANotesFileUnderPacmon() {
        val legacy = create(".pacmon/DEPENDENCY-NOTES.md", "## vue\n\nFrontend\n")
        val current = create("apps/web/.depos/DEPENDENCY-NOTES.md", "## react\n\nUI\n")
        val shown = mutableListOf<String>()
        project.messageBus.connect(testRootDisposable).subscribe(Notifications.TOPIC, object : Notifications {
            override fun notify(notification: Notification) {
                shown.add(notification.content)
            }
        })

        MoveNotesSuggestion(project).fileOpened(FileEditorManager.getInstance(project), current)
        UIUtil.dispatchAllInvocationEvents()
        assertEmpty(shown)

        MoveNotesSuggestion(project).fileOpened(FileEditorManager.getInstance(project), legacy)
        MoveNotes.suggest(project, legacy)
        UIUtil.dispatchAllInvocationEvents()
        assertEquals(listOf(MoveNotes.SUGGEST), shown)
        assertTrue(PropertiesComponent.getInstance(project).getBoolean("depos.moveNotesSuggested"))
    }
}
