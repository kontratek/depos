package dev.pacmon.jetbrains.ui

import com.intellij.codeInsight.hints.BlockConstraints
import com.intellij.codeInsight.hints.HorizontalConstraints
import com.intellij.codeInsight.hints.InlayHintsSink
import com.intellij.codeInsight.hints.presentation.InlayPresentation
import com.intellij.codeInsight.hints.presentation.RootInlayPresentation
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.util.ui.UIUtil
import dev.pacmon.jetbrains.editor.DependencyPsi
import dev.pacmon.jetbrains.editor.PacmonInlayHintsProvider
import dev.pacmon.jetbrains.editor.PacmonLinePainter
import dev.pacmon.jetbrains.service.PacmonProjectService
import dev.pacmon.jetbrains.settings.Decorations
import dev.pacmon.jetbrains.settings.InlineSources
import dev.pacmon.jetbrains.settings.MonorepoModes
import dev.pacmon.jetbrains.settings.NoteButtons
import dev.pacmon.jetbrains.settings.NoteEntries
import java.awt.Font

class PacmonUiTest : BasePlatformTestCase() {
    // The light project — and with it the settings service — is shared between
    // test classes, so every class that writes a setting starts from defaults
    // rather than from whatever the class before it left behind.
    override fun setUp() {
        super.setUp()
        project.getService(PacmonProjectService::class.java).apply {
            resetViewSettings()
            state.monorepoMode = MonorepoModes.NEAREST
        }
    }

    private class RecordingSink : InlayHintsSink {
        var inlineOffset: Int? = null

        override fun addInlineElement(
            offset: Int,
            relatesToPrecedingText: Boolean,
            presentation: InlayPresentation,
            placeAtTheEndOfLine: Boolean,
        ) {
            inlineOffset = offset
        }

        override fun addBlockElement(
            offset: Int,
            relatesToPrecedingText: Boolean,
            showAbove: Boolean,
            priority: Int,
            presentation: InlayPresentation,
        ) = Unit

        override fun addInlineElement(
            offset: Int,
            presentation: RootInlayPresentation<*>,
            constraints: HorizontalConstraints?,
        ) = Unit

        override fun addBlockElement(
            logicalLine: Int,
            showAbove: Boolean,
            presentation: RootInlayPresentation<*>,
            constraints: BlockConstraints?,
        ) = Unit
    }

    fun testLinePainterShowsAnItalicPreviewOnlyForDocumentedDependencies() {
        val packageJson = myFixture.tempDirFixture.createFile(
            "package.json",
            """
            {
              "dependencies": {
                "vue": "^3",
                "react": "^19"
              }
            }
            """.trimIndent(),
        )
        myFixture.configureFromExistingVirtualFile(packageJson)
        val psi = myFixture.file
        myFixture.tempDirFixture.createFile(
            ".depos/DEPENDENCY-NOTES.md",
            "## vue\n\nFrontend framework\n",
        )
        val dependencies = DependencyPsi.all(psi).associateBy { it.name }
        val document = myFixture.editor.document
        val painter = PacmonLinePainter()
        val vueLine = document.getLineNumber(dependencies.getValue("vue").primaryRange.offset)
        val reactLine = document.getLineNumber(dependencies.getValue("react").primaryRange.offset)

        val preview = painter.getLineExtensions(project, packageJson, vueLine).single()
        assertEquals("   \u25AA Frontend framework", preview.text)
        assertEquals(Font.ITALIC, preview.fontType)
        assertEmpty(painter.getLineExtensions(project, packageJson, reactLine))
    }

    fun testInlayIconProviderOnlyRunsInPackageJson() {
        val provider = PacmonInlayHintsProvider()
        myFixture.configureByText("package.json", """{ "dependencies": { "vue": "^3" } }""")
        val dependency = DependencyPsi.all(myFixture.file).single()
        val sink = RecordingSink()
        val collector = provider.getCollectorFor(myFixture.file, myFixture.editor, provider.createSettings(), sink)
        assertNotNull(collector)
        assertFalse(collector!!.collect(myFixture.file, myFixture.editor, sink))
        assertEquals(dependency.primaryRange.offset, sink.inlineOffset)

        myFixture.configureByText("config.json", """{ "dependencies": { "vue": "^3" } }""")
        assertNull(provider.getCollectorFor(myFixture.file, myFixture.editor, provider.createSettings(), RecordingSink()))
    }

    fun testProjectUsesOneToolWindowService() {
        assertSame(
            project.getService(PacmonToolWindowService::class.java),
            project.getService(PacmonToolWindowService::class.java),
        )
    }

    fun testDashboardCoverageMatchesTheActivePackageAndKeepsItsContext() {
        val packageJson = myFixture.tempDirFixture.createFile(
            "packages/app/package.json",
            """{ "dependencies": { "vue": "^3", "react": "^19" } }""",
        )
        myFixture.tempDirFixture.createFile(
            "packages/app/.depos/DEPENDENCY-NOTES.md",
            "## vue\n\nFrontend framework\n",
        )
        myFixture.configureFromExistingVirtualFile(packageJson)
        val dashboard = PacmonDashboardPanel(project)
        dashboard.refresh()

        val coverage = dashboard.coverageForTest()
        assertEquals("1 of 2", coverage.ratio)
        assertTrue(coverage.packagePath.endsWith("packages/app/package.json"))
        assertEquals(50, coverage.percent)
        assertEquals("1 dependency has no note yet.", coverage.status)
        assertTrue(coverage.barVisible)

        myFixture.configureByText("README.txt", "project")
        dashboard.refresh()
        assertEquals(coverage.packagePath, dashboard.coverageForTest().packagePath)
    }

    fun testDashboardCoverageReadsZigDependenciesAndNotes() {
        val manifest = myFixture.tempDirFixture.createFile(
            "apps/zig/build.zig.zon",
            ".{ .dependencies = .{ .known_folders = .{}, .ziglyph = .{ .lazy = true } } }",
        )
        myFixture.tempDirFixture.createFile(
            "apps/zig/.depos/zig/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: zig\nlang: en\n---\n# Dependency Notes\n\n## known_folders\n\nPaths\n",
        )
        myFixture.configureFromExistingVirtualFile(manifest)
        val dashboard = PacmonDashboardPanel(project)
        dashboard.refresh()

        val coverage = dashboard.coverageForTest()
        assertEquals("1 of 2", coverage.ratio)
        assertTrue(coverage.packagePath.endsWith("apps/zig/build.zig.zon"))
        assertEquals(50, coverage.percent)
        assertEquals("1 dependency has no note yet.", coverage.status)
    }

    fun testDashboardCoverageReadsGleamDependenciesAndNotes() {
        val manifest = myFixture.tempDirFixture.createFile(
            "apps/gleam/gleam.toml",
            "[dependencies]\ngleam_stdlib = \"1\"\ngleam_http = { version = \"4\" }",
        )
        myFixture.tempDirFixture.createFile(
            "apps/gleam/.depos/gleam/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: gleam\nlang: en\n---\n# Dependency Notes\n\n## gleam_stdlib\n\nStandard library\n",
        )
        myFixture.configureFromExistingVirtualFile(manifest)
        val dashboard = PacmonDashboardPanel(project)
        dashboard.refresh()

        val coverage = dashboard.coverageForTest()
        assertEquals("1 of 2", coverage.ratio)
        assertTrue(coverage.packagePath.endsWith("apps/gleam/gleam.toml"))
        assertEquals(50, coverage.percent)
        assertEquals("1 dependency has no note yet.", coverage.status)
    }

    fun testDashboardCoverageAggregatesCentralAndProjectNugetDependencies() {
        myFixture.tempDirFixture.createFile(
            "Directory.Packages.props",
            """
            <Project><ItemGroup>
              <PackageVersion Include="Newtonsoft.Json" />
              <GlobalPackageReference Include="Nerdbank.GitVersioning" />
            </ItemGroup></Project>
            """.trimIndent(),
        )
        val manifest = myFixture.tempDirFixture.createFile(
            "src/App.csproj",
            """
            <Project><ItemGroup>
              <PackageReference Include="newtonsoft.json" />
              <PackageReference Include="Serilog" />
            </ItemGroup></Project>
            """.trimIndent(),
        )
        myFixture.tempDirFixture.createFile(
            ".depos/nuget/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: nuget\nlang: en\n---\n# Dependency Notes\n\n## NEWTONSOFT.JSON\n\nJSON\n",
        )
        myFixture.configureFromExistingVirtualFile(manifest)
        val dashboard = PacmonDashboardPanel(project)
        dashboard.refresh()

        val coverage = dashboard.coverageForTest()
        assertEquals("1 of 3", coverage.ratio)
        assertEquals(33, coverage.percent)
        assertEquals("2 dependencies have no note yet.", coverage.status)
    }

    fun testDashboardWritesEveryChoiceAndResetsThemAllTogether() {
        myFixture.configureByText("package.json", """{ "dependencies": { "vue": "^3" } }""")
        val service = project.getService(PacmonProjectService::class.java)
        val dashboard = PacmonDashboardPanel(project)
        dashboard.refresh()

        // Ticked out of order; the stored list is canonical all the same, so it
        // reads identically however the boxes were reached.
        dashboard.setNoteButtonForTest(NoteButtons.LIGHTBULB, true)
        dashboard.setNoteButtonForTest(NoteButtons.LINK, false)
        dashboard.setNoteButtonForTest(NoteButtons.CODE_LENS, true)
        assertEquals(
            listOf(NoteButtons.ICON_LEFT, NoteButtons.CODE_LENS, NoteButtons.LIGHTBULB),
            service.noteButtons(),
        )

        dashboard.selectChoiceForTest("noteEntry", NoteEntries.PEEK)
        dashboard.selectChoiceForTest("decorations", Decorations.BADGE)
        dashboard.selectChoiceForTest("inlineSource", InlineSources.AI_ONLY)
        assertEquals(NoteEntries.PEEK, service.noteEntry())
        assertEquals(Decorations.BADGE, service.decorations())
        assertEquals(InlineSources.AI_ONLY, service.state.inlineSource)

        // One radio per group: picking "badge" must have let go of "preview".
        dashboard.selectChoiceForTest("decorations", Decorations.OFF)
        assertEquals(Decorations.OFF, service.decorations())

        dashboard.resetForTest()
        assertEquals(NoteButtons.DEFAULT, service.noteButtons())
        assertEquals(NoteEntries.PANEL, service.noteEntry())
        assertEquals(Decorations.PREVIEW, service.decorations())
        assertEquals(InlineSources.HUMAN_FIRST, service.state.inlineSource)
    }

    fun testEveryChoiceThatShowsASampleCanBuildOne() {
        // The samples are built once, while the panel is, so a choice that
        // cannot draw itself takes the whole tool window down with it.
        for (id in NoteButtons.ALL) {
            assertNotNull("No sample for the $id click target", NoteExamples.forClickTarget(id))
        }
        for (value in Decorations.ALL) {
            assertNotNull("No sample for the $value note marker", NoteExamples.forMarker(value))
        }
        // "off" draws the dependency line and nothing after it — the absence is
        // the point, so it must still produce a sample rather than nothing.
        assertNotNull(NoteExamples.forMarker(Decorations.OFF))
    }

    fun testPanelAutosavesBothLayersAndCreatesAgentRules() {
        val packageJson = myFixture.tempDirFixture.createFile(
            "package.json",
            """{ "dependencies": { "vue": "^3" } }""",
        )
        val panel = PacmonToolWindowPanel(project)
        try {
            panel.showTarget(PacmonTarget(packageJson, "vue", "dependencies"))
            panel.setLayersForTest("Frontend framework", "- purpose: UI\n- runtime: client")

            val service = project.getService(PacmonProjectService::class.java)
            var note = service.noteFor(packageJson, "vue")
            var attempts = 0
            while (note == null && attempts++ < 20) {
                Thread.sleep(100)
                UIUtil.dispatchAllInvocationEvents()
                note = service.noteFor(packageJson, "vue")
            }

            assertEquals("Frontend framework", note?.layers?.human)
            assertEquals("- purpose: UI\n- runtime: client", note?.layers?.agent)
            val rulesPath = project.basePath?.replace('\\', '/') + "/.depos/AGENT-RULES.md"
            assertNotNull(com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(rulesPath))
        } finally {
            panel.dispose()
        }
    }

    fun testSavingAnExistingCrLfNotesFileDoesNotPassCrLfToTheDocument() {
        val packageJson = myFixture.tempDirFixture.createFile(
            "package.json",
            """{ "dependencies": { "vue": "^3" } }""",
        )
        val notesFile = myFixture.tempDirFixture.createFile(
            ".depos/DEPENDENCY-NOTES.md",
            "---\r\nformat: dependency-notes/1\r\nlang: en\r\n---\r\n\r\n" +
                "# Dependency Notes\r\n\r\n## vue\r\n\r\nold note\r\n",
        )

        project.getService(PacmonProjectService::class.java)
            .saveNoteLayers(packageJson, "vue", "new note", "- purpose: UI framework")

        val saved = String(notesFile.contentsToByteArray(), Charsets.UTF_8)
        assertTrue(saved.contains("\r\n"))
        assertFalse(Regex("(?<!\\r)\\n").containsMatchIn(saved))
        assertTrue(saved.contains("new note\r\n\r\n### Agent notes\r\n"))
    }

    fun testExternalChangeDoesNotOverwriteDirtyPanel() {
        val packageJson = myFixture.tempDirFixture.createFile(
            "package.json",
            """{ "dependencies": { "vue": "^3" } }""",
        )
        val panel = PacmonToolWindowPanel(project)
        try {
            panel.showTarget(PacmonTarget(packageJson, "vue", "dependencies"))
            panel.setLayersForTest("local edit", "")
            val notesPath = "${packageJson.parent.path}/.depos/DEPENDENCY-NOTES.md"
            panel.externalNotesChanged(setOf(notesPath))
            UIUtil.dispatchAllInvocationEvents()
            assertTrue(panel.hasConflictForTest())

            panel.saveForTest()
            assertEquals(
                "local edit",
                project.getService(PacmonProjectService::class.java).noteFor(packageJson, "vue")?.layers?.human,
            )
        } finally {
            panel.dispose()
        }
    }
}
