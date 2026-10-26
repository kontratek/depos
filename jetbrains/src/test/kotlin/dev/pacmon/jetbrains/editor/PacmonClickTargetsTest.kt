package dev.pacmon.jetbrains.editor

import com.intellij.codeInsight.hints.BlockConstraints
import com.intellij.codeInsight.hints.HorizontalConstraints
import com.intellij.codeInsight.hints.InlayHintsSink
import com.intellij.codeInsight.hints.presentation.InlayPresentation
import com.intellij.codeInsight.hints.presentation.RootInlayPresentation
import com.intellij.codeInsight.intention.IntentionActionBean
import com.intellij.openapi.extensions.ExtensionPointName
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.openapi.vfs.VirtualFile
import dev.pacmon.jetbrains.service.PacmonProjectService
import dev.pacmon.jetbrains.settings.Decorations
import dev.pacmon.jetbrains.settings.NoteButtons

/**
 * The five click targets and the three note-marker choices the Depos tool
 * window offers, each drawn only when it is turned on — the JetBrains side of
 * the VS Code extension's `pacmon.noteButtons` and `pacmon.decorations`.
 */
class PacmonClickTargetsTest : BasePlatformTestCase() {
    private class RecordingSink : InlayHintsSink {
        val inline = mutableListOf<Pair<Int, Boolean>>()
        var blocks = 0

        override fun addInlineElement(
            offset: Int,
            relatesToPrecedingText: Boolean,
            presentation: InlayPresentation,
            placeAtTheEndOfLine: Boolean,
        ) {
            inline.add(offset to placeAtTheEndOfLine)
        }

        override fun addBlockElement(
            offset: Int,
            relatesToPrecedingText: Boolean,
            showAbove: Boolean,
            priority: Int,
            presentation: InlayPresentation,
        ) {
            blocks++
        }

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

    // The light project — and with it the settings service — is shared between
    // test classes, so every class that writes a setting starts from defaults
    // rather than from whatever the class before it left behind.
    override fun setUp() {
        super.setUp()
        service().resetViewSettings()
    }

    private fun service() = project.getService(PacmonProjectService::class.java)

    private fun collect(vararg buttons: String): RecordingSink {
        service().setNoteButtons(buttons.toList())
        val provider = PacmonInlayHintsProvider()
        val sink = RecordingSink()
        val collector = provider.getCollectorFor(myFixture.file, myFixture.editor, provider.createSettings(), sink)
            ?: return sink
        collector.collect(myFixture.file, myFixture.editor, sink)
        return sink
    }

    private fun configurePackageJson(): VirtualFile {
        myFixture.configureByText(
            "package.json",
            """
            {
              "dependencies": {
                "vue": "^3"
              }
            }
            """.trimIndent(),
        )
        return myFixture.file.virtualFile
    }

    fun testEachInlayClickTargetIsDrawnOnlyWhenItIsTurnedOn() {
        configurePackageJson()
        val dependency = DependencyPsi.all(myFixture.file).single()

        val icon = collect(NoteButtons.ICON_LEFT)
        assertEquals(listOf(dependency.iconRange.offset to false), icon.inline)
        assertEquals(0, icon.blocks)

        val lens = collect(NoteButtons.CODE_LENS)
        assertEmpty(lens.inline)
        assertEquals(1, lens.blocks)

        val chip = collect(NoteButtons.INLAY_HINT)
        val lineEnd = myFixture.editor.document.getLineEndOffset(
            myFixture.editor.document.getLineNumber(dependency.primaryRange.offset),
        )
        assertEquals(listOf(lineEnd to true), chip.inline)
        assertEquals(0, chip.blocks)

        val all = collect(NoteButtons.ICON_LEFT, NoteButtons.CODE_LENS, NoteButtons.INLAY_HINT)
        assertEquals(2, all.inline.size)
        assertEquals(1, all.blocks)
    }

    fun testNoInlayCollectorAtAllWhenEveryInlayTargetIsOff() {
        configurePackageJson()
        // "link" and "lightbulb" are the two targets that are not inlays, so
        // the provider must step aside entirely rather than walk the file.
        service().setNoteButtons(listOf(NoteButtons.LINK, NoteButtons.LIGHTBULB))
        val provider = PacmonInlayHintsProvider()
        assertNull(
            provider.getCollectorFor(myFixture.file, myFixture.editor, provider.createSettings(), RecordingSink()),
        )
    }

    fun testCtrlClickTargetFollowsTheLinkSettingAndOnlyTheNameHalf() {
        configurePackageJson()
        val dependency = DependencyPsi.all(myFixture.file).single()
        val nameOffset = dependency.primaryRange.offset + 1
        val versionOffset = myFixture.file.text.indexOf("^3")
        val handler = PacmonNoteDeclarationHandler()

        service().setNoteButtons(listOf(NoteButtons.LINK))
        val targets = handler.getGotoDeclarationTargets(
            myFixture.file.findElementAt(nameOffset),
            nameOffset,
            myFixture.editor,
        )
        assertEquals(1, targets?.size)
        val target = targets!!.single() as com.intellij.pom.Navigatable
        assertTrue(target.canNavigate())
        // Claiming no file is what keeps go-to-declaration from "navigating" by
        // moving the caret onto the name that was just clicked.
        assertNull(targets.single().containingFile)

        assertNull(
            handler.getGotoDeclarationTargets(
                myFixture.file.findElementAt(versionOffset),
                versionOffset,
                myFixture.editor,
            ),
        )

        service().setNoteButtons(listOf(NoteButtons.ICON_LEFT))
        assertNull(
            handler.getGotoDeclarationTargets(myFixture.file.findElementAt(nameOffset), nameOffset, myFixture.editor),
        )
    }

    fun testLightbulbFollowsItsSettingAndTheCaretLine() {
        configurePackageJson()
        val dependency = DependencyPsi.all(myFixture.file).single()
        val intention = PacmonAddNoteIntention()

        service().setNoteButtons(listOf(NoteButtons.LIGHTBULB))
        myFixture.editor.caretModel.moveToOffset(dependency.primaryRange.offset + 1)
        assertTrue(intention.isAvailable(project, myFixture.editor, myFixture.file))
        assertEquals("Add a Depos note for vue", intention.text)

        myFixture.editor.caretModel.moveToOffset(0)
        assertFalse(intention.isAvailable(project, myFixture.editor, myFixture.file))

        service().setNoteButtons(listOf(NoteButtons.ICON_LEFT))
        myFixture.editor.caretModel.moveToOffset(dependency.primaryRange.offset + 1)
        assertFalse(intention.isAvailable(project, myFixture.editor, myFixture.file))
    }

    fun testLightbulbIsRegisteredOnceForEveryLanguage() {
        // IntelliJ 2026.3 throws when one intention class is registered more than once.
        val registrations = ExtensionPointName<IntentionActionBean>("com.intellij.intentionAction").extensionList
            .filter { it.className == PacmonAddNoteIntention::class.java.name }
        assertEquals(1, registrations.size)
        assertNull(registrations.single().language)
    }

    fun testNoteMarkersShowThePreview_thenTheBareBadge_thenNothing() {
        val packageJson = myFixture.tempDirFixture.createFile(
            "package.json",
            """{ "dependencies": { "vue": "^3" } }""",
        )
        myFixture.tempDirFixture.createFile(".depos/DEPENDENCY-NOTES.md", "## vue\n\nFrontend framework\n")
        myFixture.configureFromExistingVirtualFile(packageJson)
        val line = myFixture.editor.document.getLineNumber(
            DependencyPsi.all(myFixture.file).single().primaryRange.offset,
        )
        val painter = PacmonLinePainter()

        service().state.decorations = Decorations.PREVIEW
        assertEquals(
            "   ▪ Frontend framework",
            painter.getLineExtensions(project, packageJson, line).single().text,
        )

        // The badge is the marker AND the word, the way the VS Code extension
        // writes it — the marker on its own reads as a stray character.
        service().state.decorations = Decorations.BADGE
        assertEquals("   ▪ note", painter.getLineExtensions(project, packageJson, line).single().text)

        service().state.decorations = Decorations.OFF
        assertEmpty(painter.getLineExtensions(project, packageJson, line))
    }

    fun testNugetProjectAndCentralManifestUseInlaysDecorationsLinksAndHover() {
        val central = myFixture.tempDirFixture.createFile(
            "Directory.Packages.props",
            "<Project><PackageVersion Include=\"Newtonsoft.Json\" /></Project>",
        )
        val projectFile = myFixture.tempDirFixture.createFile(
            "src/App.csproj",
            "<Project><PackageReference Include=\"newtonsoft.json\" /></Project>",
        )
        myFixture.tempDirFixture.createFile(
            ".depos/nuget/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: nuget\nlang: en\n---\n# Dependency Notes\n\n## NEWTONSOFT.JSON\n\nJSON serialization\n",
        )
        val documentation = PacmonDocumentationProvider()
        val handler = PacmonNoteDeclarationHandler()

        for (manifest in listOf(projectFile, central)) {
            myFixture.configureFromExistingVirtualFile(manifest)
            val dependency = DependencyPsi.all(myFixture.file).single()
            assertEquals(listOf(dependency.iconRange.offset to false), collect(NoteButtons.ICON_LEFT).inline)
            val line = myFixture.editor.document.getLineNumber(dependency.primaryRange.offset)
            assertEquals(
                "   ▪ JSON serialization",
                PacmonLinePainter().getLineExtensions(project, manifest, line).single().text,
            )

            service().setNoteButtons(listOf(NoteButtons.LINK))
            val offset = dependency.primaryRange.offset + 1
            assertEquals(
                1,
                handler.getGotoDeclarationTargets(
                    myFixture.file.findElementAt(offset),
                    offset,
                    myFixture.editor,
                )?.size,
            )
            val element = documentation.getCustomDocumentationElement(
                myFixture.editor,
                myFixture.file,
                myFixture.file.findElementAt(offset),
                offset,
            )
            assertTrue(documentation.generateHoverDoc(element!!, null)!!.contains("JSON serialization"))
        }
    }

    fun testEveryEcosystemUsesTheSameInlayLinkAndDecorationSurfaces() {
        val cargo = myFixture.tempDirFixture.createFile("Cargo.toml", "[dependencies]\nserde = \"1\"\n")
        myFixture.tempDirFixture.createFile(
            ".depos/cargo/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: cargo\nlang: en\n---\n# Dependency Notes\n\n## serde\n\nSerialization\n",
        )
        myFixture.configureFromExistingVirtualFile(cargo)
        val cargoDependency = DependencyPsi.all(myFixture.file).single()
        service().setNoteButtons(listOf(NoteButtons.ICON_LEFT, NoteButtons.LINK))
        assertEquals(listOf(cargoDependency.iconRange.offset to false), collect(NoteButtons.ICON_LEFT).inline)
        val cargoLine = myFixture.editor.document.getLineNumber(cargoDependency.primaryRange.offset)
        assertEquals("   ▪ Serialization", PacmonLinePainter().getLineExtensions(project, cargo, cargoLine).single().text)

        val pom = myFixture.tempDirFixture.createFile(
            "pom.xml",
            """
            <project><dependencies>
              <dependency>
                <groupId>org.example</groupId>
                <artifactId>core</artifactId>
              </dependency>
            </dependencies></project>
            """.trimIndent(),
        )
        myFixture.tempDirFixture.createFile(
            ".depos/maven/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: maven\nlang: en\n---\n# Dependency Notes\n\n## org.example:core\n\nCore library\n",
        )
        myFixture.configureFromExistingVirtualFile(pom)
        val mavenDependency = DependencyPsi.all(myFixture.file).single()
        assertEquals(myFixture.file.text.indexOf("<dependency>"), mavenDependency.iconRange.offset)
        assertEquals(listOf(mavenDependency.iconRange.offset to false), collect(NoteButtons.ICON_LEFT).inline)
        assertTrue(
            myFixture.editor.document.getLineNumber(mavenDependency.iconRange.offset) !=
                myFixture.editor.document.getLineNumber(mavenDependency.primaryRange.offset),
        )
        val handler = PacmonNoteDeclarationHandler()
        service().setNoteButtons(listOf(NoteButtons.LINK))
        for (value in listOf("org.example", "core")) {
            val offset = myFixture.file.text.indexOf(value) + 1
            assertEquals(
                1,
                handler.getGotoDeclarationTargets(
                    myFixture.file.findElementAt(offset),
                    offset,
                    myFixture.editor,
                )?.size,
            )
        }

        val gradle = myFixture.tempDirFixture.createFile(
            "build.gradle.kts",
            """
            dependencies {
                implementation("org.slf4j:slf4j-api:2.0.17")
            }
            """.trimIndent(),
        )
        myFixture.tempDirFixture.createFile(
            ".depos/gradle/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: gradle\nlang: en\n---\n# Dependency Notes\n\n## org.slf4j:slf4j-api\n\nLogging facade\n",
        )
        myFixture.configureFromExistingVirtualFile(gradle)
        val gradleDependency = DependencyPsi.all(myFixture.file).single()
        assertEquals(myFixture.file.text.indexOf("implementation"), gradleDependency.iconRange.offset)
        assertEquals(listOf(gradleDependency.iconRange.offset to false), collect(NoteButtons.ICON_LEFT).inline)
        val gradleLine = myFixture.editor.document.getLineNumber(gradleDependency.primaryRange.offset)
        assertEquals(
            "   \u25AA Logging facade",
            PacmonLinePainter().getLineExtensions(project, gradle, gradleLine).single().text,
        )
        service().setNoteButtons(listOf(NoteButtons.LINK))
        val artifactOffset = myFixture.file.text.indexOf("slf4j-api") + 1
        assertEquals(
            1,
            handler.getGotoDeclarationTargets(
                myFixture.file.findElementAt(artifactOffset),
                artifactOffset,
                myFixture.editor,
            )?.size,
        )

        val mix = myFixture.tempDirFixture.createFile(
            "mix.exs",
            "defmodule Demo.MixProject do\n  defp deps, do: [{:phoenix, \"~> 1.8\"}]\nend",
        )
        myFixture.tempDirFixture.createFile(
            ".depos/mix/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: mix\nlang: en\n---\n# Dependency Notes\n\n## phoenix\n\nWeb framework\n",
        )
        myFixture.configureFromExistingVirtualFile(mix)
        val mixDependency = DependencyPsi.all(myFixture.file).single()
        service().setNoteButtons(listOf(NoteButtons.ICON_LEFT, NoteButtons.LINK))
        assertEquals(listOf(mixDependency.iconRange.offset to false), collect(NoteButtons.ICON_LEFT).inline)
        val mixLine = myFixture.editor.document.getLineNumber(mixDependency.primaryRange.offset)
        assertEquals(
            "   \u25AA Web framework",
            PacmonLinePainter().getLineExtensions(project, mix, mixLine).single().text,
        )
        val mixOffset = myFixture.file.text.indexOf(":phoenix") + 2
        val mixElement = myFixture.file.findElementAt(mixOffset) ?: myFixture.file
        service().setNoteButtons(listOf(NoteButtons.LINK))
        assertEquals(
            1,
            handler.getGotoDeclarationTargets(
                mixElement,
                mixOffset,
                myFixture.editor,
            )?.size,
        )
    }

    fun testZigUsesInlayLinkDecorationAndHoverSurfacesWithoutZigBrains() {
        val manifest = myFixture.tempDirFixture.createFile(
            "build.zig.zon",
            ".{ .dependencies = .{ .known_folders = .{ .path = \"../known-folders\" } } }",
        )
        myFixture.tempDirFixture.createFile(
            ".depos/zig/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: zig\nlang: en\n---\n# Dependency Notes\n\n## known_folders\n\nFilesystem paths\n",
        )
        myFixture.configureFromExistingVirtualFile(manifest)
        val dependency = DependencyPsi.all(myFixture.file).single()
        val offset = dependency.primaryRange.offset + 2

        assertEquals(listOf(dependency.iconRange.offset to false), collect(NoteButtons.ICON_LEFT).inline)
        val line = myFixture.editor.document.getLineNumber(dependency.primaryRange.offset)
        assertEquals("   \u25AA Filesystem paths", PacmonLinePainter().getLineExtensions(project, manifest, line).single().text)

        service().setNoteButtons(listOf(NoteButtons.LINK))
        val element = myFixture.file.findElementAt(offset) ?: myFixture.file
        assertEquals(
            1,
            PacmonNoteDeclarationHandler().getGotoDeclarationTargets(element, offset, myFixture.editor)?.size,
        )

        val documentation = PacmonDocumentationProvider()
        val target = documentation.getCustomDocumentationElement(myFixture.editor, myFixture.file, element, offset)
        assertNotNull(target)
        assertTrue(documentation.generateHoverDoc(target!!, element).orEmpty().contains("Filesystem paths"))
    }

    fun testGleamUsesInlayLinkDecorationAndHoverSurfacesWithoutGleamTooling() {
        val manifest = myFixture.tempDirFixture.createFile(
            "gleam.toml",
            "[dependencies]\ngleam_stdlib = \">= 0.44.0 and < 2.0.0\"",
        )
        myFixture.tempDirFixture.createFile(
            ".depos/gleam/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: gleam\nlang: en\n---\n# Dependency Notes\n\n## gleam_stdlib\n\nStandard library\n",
        )
        myFixture.configureFromExistingVirtualFile(manifest)
        val dependency = DependencyPsi.all(myFixture.file).single()
        val offset = dependency.primaryRange.offset + 2

        assertEquals(listOf(dependency.iconRange.offset to false), collect(NoteButtons.ICON_LEFT).inline)
        val line = myFixture.editor.document.getLineNumber(dependency.primaryRange.offset)
        assertEquals("   \u25AA Standard library", PacmonLinePainter().getLineExtensions(project, manifest, line).single().text)

        service().setNoteButtons(listOf(NoteButtons.LINK))
        val element = myFixture.file.findElementAt(offset) ?: myFixture.file
        assertEquals(
            1,
            PacmonNoteDeclarationHandler().getGotoDeclarationTargets(element, offset, myFixture.editor)?.size,
        )

        val documentation = PacmonDocumentationProvider()
        val target = documentation.getCustomDocumentationElement(myFixture.editor, myFixture.file, element, offset)
        assertNotNull(target)
        assertTrue(documentation.generateHoverDoc(target!!, element).orEmpty().contains("Standard library"))
    }
}
