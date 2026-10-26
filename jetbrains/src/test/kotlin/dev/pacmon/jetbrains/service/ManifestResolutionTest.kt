package dev.pacmon.jetbrains.service

import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import dev.pacmon.jetbrains.action.PacmonCommands
import dev.pacmon.jetbrains.core.ManifestKind
import dev.pacmon.jetbrains.settings.MonorepoModes

class ManifestResolutionTest : BasePlatformTestCase() {
    override fun setUp() {
        super.setUp()
        service().state.monorepoMode = MonorepoModes.NEAREST
    }

    private fun service() = project.getService(PacmonProjectService::class.java)

    private fun create(path: String, text: String): VirtualFile = myFixture.tempDirFixture.createFile(path, text)

    private fun text(file: VirtualFile): String =
        FileDocumentManager.getInstance().getDocument(file)?.text ?: String(file.contentsToByteArray()).replace("\r\n", "\n")

    private val cargoToml = "[dependencies]\nserde = \"1\""

    // ── .depos/, and .pacmon/ from before Pacmon became Depos ──────────────────

    fun testNotesUnderPacmonAreStillRead() {
        val cargo = create("Cargo.toml", cargoToml)
        val notes = create(".pacmon/cargo/DEPENDENCY-NOTES.md", "## serde\n\nlegacy\n")

        assertEquals(notes.path, service().resolveNotesFile(cargo)?.path)
        assertEquals("legacy", service().noteFor(cargo, "serde")?.layers?.human)
        assertEquals(ManifestKind.CARGO, service().notesKind(notes))
        assertEquals(listOf("serde"), service().dependenciesForNotes(notes).map { it.name })
        assertEquals(cargo.path, service().manifestBesideNotes(notes)?.path)
        assertNull(service().shadowingNotesFile(notes))
        assertEquals(".pacmon/cargo/DEPENDENCY-NOTES.md", service().notesRelativePathFor(cargo))
    }

    fun testDeposWinsOverPacmonAtTheSameLevel() {
        val cargo = create("Cargo.toml", cargoToml)
        val legacy = create(".pacmon/cargo/DEPENDENCY-NOTES.md", "## serde\n\nlegacy\n")
        val current = create(".depos/cargo/DEPENDENCY-NOTES.md", "## serde\n\ncurrent\n")

        assertEquals(current.path, service().resolveNotesFile(cargo)?.path)
        assertEquals("current", service().noteFor(cargo, "serde")?.layers?.human)
        assertEquals(current.path, service().shadowingNotesFile(legacy)?.path)
        assertNull(service().shadowingNotesFile(current))
        assertEquals(".depos/cargo/DEPENDENCY-NOTES.md", service().displayPath(current))
    }

    fun testTheNearestLevelWinsWhicheverDirectoryItUses() {
        val cargo = create("crates/app/Cargo.toml", cargoToml)
        val root = create(".depos/cargo/DEPENDENCY-NOTES.md", "## serde\n\nroot\n")
        val near = create("crates/app/.pacmon/cargo/DEPENDENCY-NOTES.md", "## serde\n\nnear\n")

        assertEquals(near.path, service().resolveNotesFile(cargo)?.path)
        service().state.monorepoMode = MonorepoModes.ROOT_ONLY
        assertEquals(root.path, service().resolveNotesFile(cargo)?.path)
    }

    fun testAFreshRepositoryWritesItsFirstNoteToDepos() {
        val cargo = create("Cargo.toml", cargoToml)
        assertEquals(".depos", service().notesDirForManifest(cargo))
        assertEquals(".depos/cargo/DEPENDENCY-NOTES.md", service().notesRelativePathFor(cargo))

        val created = service().saveNoteLayers(cargo, "serde", "Serialization", "")

        assertEquals("${cargo.parent.path}/.depos/cargo/DEPENDENCY-NOTES.md", created.path)
        assertTrue(text(created).contains("rules in .depos/AGENT-RULES.md"))
    }

    /** The npm notes are in .pacmon/: a first Rust note goes there too, where a teammate on Pacmon still sees it. */
    fun testARepositoryOnPacmonKeepsItsNewNotesThere() {
        create(".pacmon/DEPENDENCY-NOTES.md", "## vue\n\nnpm\n")
        val cargo = create("Cargo.toml", cargoToml)
        assertEquals(".pacmon", service().notesDirForManifest(cargo))
        assertEquals(".pacmon/cargo/DEPENDENCY-NOTES.md", service().notesRelativePathFor(cargo))
        assertEquals("${cargo.parent.path}/.pacmon/cargo/DEPENDENCY-NOTES.md", service().creationTargetPath(cargo))

        val created = service().saveNoteLayers(cargo, "serde", "Serialization", "")

        assertEquals("${cargo.parent.path}/.pacmon/cargo/DEPENDENCY-NOTES.md", created.path)
        val text = text(created)
        assertTrue(text, text.contains("rules in .pacmon/AGENT-RULES.md"))
        assertTrue(text, text.contains("format: dependency-notes/2\necosystem: cargo"))
        assertNull(cargo.parent.findChild(".depos"))
    }

    /** Only a nested package has notes, and nothing is at the root: the index finds them. */
    fun testAMonorepoOnPacmonKeepsANewPackagesFirstNoteThere() {
        create("apps/web/.pacmon/DEPENDENCY-NOTES.md", "## vue\n\nnpm\n")
        val cargo = create("apps/api/Cargo.toml", cargoToml)

        val created = service().saveNoteLayers(cargo, "serde", "Serialization", "")

        assertEquals("${cargo.parent.path}/.pacmon/cargo/DEPENDENCY-NOTES.md", created.path)
    }

    fun testAnythingUnderDeposDecidesForDepos() {
        create(".pacmon/DEPENDENCY-NOTES.md", "## vue\n\nnpm\n")
        create("apps/api/.depos/cargo/DEPENDENCY-NOTES.md", "## serde\n\ncargo\n")
        val gleam = create("gleam.toml", "[dependencies]\ngleam_stdlib = \"1\"")
        assertEquals(".depos", service().notesDirForManifest(gleam))
    }

    fun testAgentRulesAtTheRootDecideForTheirDirectory() {
        create(".pacmon/AGENT-RULES.md", "rules\n")
        val cargo = create("Cargo.toml", cargoToml)
        assertEquals(".pacmon", service().notesDirForManifest(cargo))
    }

    fun testNotesInExcludedDirectoriesDecideNothing() {
        create("node_modules/some-package/.pacmon/DEPENDENCY-NOTES.md", "## left-pad\n\nvendored\n")
        val cargo = create("Cargo.toml", cargoToml)
        assertEquals(".depos", service().notesDirForManifest(cargo))
    }

    fun testAgentRulesAreWrittenForTheRepositorysDirectory() {
        val root = create("Cargo.toml", cargoToml).parent
        WriteCommandAction.runWriteCommandAction(project) {
            service().writeAgentRules(root, ".pacmon", overwrite = true)
            service().writeAgentRules(root, ".depos", overwrite = true)
        }
        val legacy = text(root.findFileByRelativePath(".pacmon/AGENT-RULES.md")!!)
        val current = text(root.findFileByRelativePath(".depos/AGENT-RULES.md")!!)

        assertTrue(legacy.contains("`.pacmon/DEPENDENCY-NOTES.md`"))
        assertTrue(legacy.contains("`.pacmon/cargo/DEPENDENCY-NOTES.md`"))
        assertFalse(legacy.contains(".depos/"))
        assertTrue(current.contains("`.depos/DEPENDENCY-NOTES.md`"))
        assertFalse(current.contains(".pacmon/"))
        // Only the directory changes: the format reference is the same page.
        assertTrue(legacy.contains("https://depos.dev/format/"))
        assertTrue(current.contains("https://depos.dev/format/"))
    }

    /** Formatting a .pacmon/ file keeps its header there: two versions in one team must not take turns at it. */
    fun testFormattingKeepsTheHeaderOfTheFilesOwnDirectory() {
        val packageJson = create("package.json", """{"dependencies":{"vue":"3"}}""")
        val notes = create(".pacmon/DEPENDENCY-NOTES.md", "# Dependency Notes\n\n## vue\n\nFrontend\n")
        val editors = FileEditorManager.getInstance(project)
        editors.openFiles.forEach(editors::closeFile)

        PacmonCommands.formatNotesFile(project, packageJson)

        val text = text(notes)
        assertTrue(text, text.contains("rules in .pacmon/AGENT-RULES.md"))
        assertFalse(text, text.contains(".depos/"))
        assertTrue(text, text.startsWith("---\nformat: dependency-notes/1\n"))
    }

    fun testManifestsResolveOnlyTheirOwnNotesNamespace() {
        val npm = myFixture.tempDirFixture.createFile("package.json", """{"dependencies":{"vue":"3"}}""")
        val cargo = myFixture.tempDirFixture.createFile("Cargo.toml", "[dependencies]\nserde = \"1\"")
        val maven = myFixture.tempDirFixture.createFile(
            "pom.xml",
            "<project><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId></dependency></dependencies></project>",
        )
        val gradle = myFixture.tempDirFixture.createFile(
            "build.gradle.kts",
            "dependencies { implementation(\"g:a:1\") }",
        )
        val mix = myFixture.tempDirFixture.createFile(
            "mix.exs",
            "defmodule Demo.MixProject do\n  defp deps, do: [{:phoenix, \"~> 1.8\"}]\nend",
        )
        val gleam = myFixture.tempDirFixture.createFile("gleam.toml", "[dependencies]\ngleam_stdlib = \"1\"")
        val zig = myFixture.tempDirFixture.createFile(
            "build.zig.zon",
            ".{ .dependencies = .{ .known_folders = .{ .path = \"../known-folders\" } } }",
        )
        val python = myFixture.tempDirFixture.createFile("pyproject.toml", "[project]\ndependencies = [\"requests>=2\"]")
        val nuget = myFixture.tempDirFixture.createFile(
            "App.csproj",
            "<Project><ItemGroup><PackageReference Include=\"Newtonsoft.Json\" /></ItemGroup></Project>",
        )
        val go = myFixture.tempDirFixture.createFile("go.mod", "module m\n\nrequire github.com/spf13/cobra v1.8.1\n")
        myFixture.tempDirFixture.createFile(".depos/DEPENDENCY-NOTES.md", "## vue\n\nnpm\n")
        myFixture.tempDirFixture.createFile(".depos/go/DEPENDENCY-NOTES.md", "## github.com/spf13/cobra\n\ngo\n")
        myFixture.tempDirFixture.createFile(".depos/cargo/DEPENDENCY-NOTES.md", "## serde\n\ncargo\n")
        myFixture.tempDirFixture.createFile(".depos/maven/DEPENDENCY-NOTES.md", "## g:a\n\nmaven\n")
        myFixture.tempDirFixture.createFile(".depos/gradle/DEPENDENCY-NOTES.md", "## g:a\n\ngradle\n")
        myFixture.tempDirFixture.createFile(".depos/mix/DEPENDENCY-NOTES.md", "## phoenix\n\nmix\n")
        myFixture.tempDirFixture.createFile(".depos/gleam/DEPENDENCY-NOTES.md", "## gleam_stdlib\n\ngleam\n")
        myFixture.tempDirFixture.createFile(".depos/zig/DEPENDENCY-NOTES.md", "## known_folders\n\nzig\n")
        myFixture.tempDirFixture.createFile(".depos/python/DEPENDENCY-NOTES.md", "## requests\n\npython\n")
        myFixture.tempDirFixture.createFile(".depos/nuget/DEPENDENCY-NOTES.md", "## newtonsoft.json\n\nnuget\n")

        assertTrue(service().resolveNotesFile(npm)!!.path.endsWith(".depos/DEPENDENCY-NOTES.md"))
        assertTrue(service().resolveNotesFile(cargo)!!.path.endsWith(".depos/cargo/DEPENDENCY-NOTES.md"))
        assertTrue(service().resolveNotesFile(maven)!!.path.endsWith(".depos/maven/DEPENDENCY-NOTES.md"))
        assertTrue(service().resolveNotesFile(gradle)!!.path.endsWith(".depos/gradle/DEPENDENCY-NOTES.md"))
        assertTrue(service().resolveNotesFile(mix)!!.path.endsWith(".depos/mix/DEPENDENCY-NOTES.md"))
        assertTrue(service().resolveNotesFile(gleam)!!.path.endsWith(".depos/gleam/DEPENDENCY-NOTES.md"))
        assertTrue(service().resolveNotesFile(zig)!!.path.endsWith(".depos/zig/DEPENDENCY-NOTES.md"))
        assertTrue(service().resolveNotesFile(python)!!.path.endsWith(".depos/python/DEPENDENCY-NOTES.md"))
        assertTrue(service().resolveNotesFile(nuget)!!.path.endsWith(".depos/nuget/DEPENDENCY-NOTES.md"))
        assertEquals("cargo", service().noteFor(cargo, "serde")?.layers?.human)
        assertEquals("mix", service().noteFor(mix, "phoenix")?.layers?.human)
        assertEquals("gleam", service().noteFor(gleam, "gleam_stdlib")?.layers?.human)
        assertEquals("zig", service().noteFor(zig, "known_folders")?.layers?.human)
        assertEquals("python", service().noteFor(python, "requests")?.layers?.human)
        assertEquals("nuget", service().noteFor(nuget, "Newtonsoft.Json")?.layers?.human)
        assertTrue(service().resolveNotesFile(go)!!.path.endsWith(".depos/go/DEPENDENCY-NOTES.md"))
        assertEquals("go", service().noteFor(go, "github.com/spf13/cobra")?.layers?.human)
        assertNull(service().noteFor(cargo, "vue"))
    }

    fun testNearestAndRootOnlyAreAppliedPerEcosystem() {
        val cargo = myFixture.tempDirFixture.createFile("crates/app/Cargo.toml", "[dependencies]\nserde = \"1\"")
        val rootNotes = myFixture.tempDirFixture.createFile(".depos/cargo/DEPENDENCY-NOTES.md", "## serde\n\nroot\n")
        val nearNotes = myFixture.tempDirFixture.createFile("crates/app/.depos/cargo/DEPENDENCY-NOTES.md", "## serde\n\nnear\n")

        assertEquals(nearNotes.path, service().resolveNotesFile(cargo)?.path)
        service().state.monorepoMode = MonorepoModes.ROOT_ONLY
        assertEquals(rootNotes.path, service().resolveNotesFile(cargo)?.path)
    }

    fun testSavingEcosystemNotesCreatesV2Frontmatter() {
        val cargo = myFixture.tempDirFixture.createFile("Cargo.toml", "[dependencies]\nserde = \"1\"")
        val maven = myFixture.tempDirFixture.createFile(
            "pom.xml",
            "<project><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId></dependency></dependencies></project>",
        )
        val cargoNotes = service().saveNoteLayers(cargo, "serde", "Serialization", "")
        val mavenNotes = service().saveNoteLayers(maven, "g:a", "Library", "")
        val gradle = myFixture.tempDirFixture.createFile(
            "build.gradle",
            "dependencies { implementation 'g:a:1' }",
        )
        val gradleNotes = service().saveNoteLayers(gradle, "g:a", "Library", "")
        val mix = myFixture.tempDirFixture.createFile(
            "mix.exs",
            "defmodule Demo.MixProject do\n  defp deps, do: [{:phoenix, \"~> 1.8\"}]\nend",
        )
        val mixNotes = service().saveNoteLayers(mix, "phoenix", "Framework", "")
        val gleam = myFixture.tempDirFixture.createFile(
            "gleam.toml",
            "[dependencies]\ngleam_stdlib = \"1\"",
        )
        val gleamNotes = service().saveNoteLayers(gleam, "gleam_stdlib", "Standard library", "")
        val zig = myFixture.tempDirFixture.createFile(
            "build.zig.zon",
            ".{ .dependencies = .{ .known_folders = .{ .path = \"../known-folders\" } } }",
        )
        val zigNotes = service().saveNoteLayers(zig, "known_folders", "Filesystem paths", "")
        val python = myFixture.tempDirFixture.createFile(
            "pyproject.toml",
            "[project]\ndependencies = [\"requests>=2\"]",
        )
        val pythonNotes = service().saveNoteLayers(python, "requests", "HTTP client", "")
        val nuget = myFixture.tempDirFixture.createFile(
            "App.csproj",
            "<Project><PackageReference Include=\"Newtonsoft.Json\" /></Project>",
        )
        val nugetNotes = service().saveNoteLayers(nuget, "Newtonsoft.Json", "JSON serialization", "")

        assertTrue(cargoNotes.path.endsWith(".depos/cargo/DEPENDENCY-NOTES.md"))
        assertTrue(String(cargoNotes.contentsToByteArray()).replace("\r\n", "\n").contains("format: dependency-notes/2\necosystem: cargo"))
        assertTrue(mavenNotes.path.endsWith(".depos/maven/DEPENDENCY-NOTES.md"))
        assertTrue(String(mavenNotes.contentsToByteArray()).replace("\r\n", "\n").contains("format: dependency-notes/2\necosystem: maven"))
        assertTrue(gradleNotes.path.endsWith(".depos/gradle/DEPENDENCY-NOTES.md"))
        assertTrue(String(gradleNotes.contentsToByteArray()).replace("\r\n", "\n").contains("format: dependency-notes/2\necosystem: gradle"))
        assertTrue(mixNotes.path.endsWith(".depos/mix/DEPENDENCY-NOTES.md"))
        assertTrue(String(mixNotes.contentsToByteArray()).replace("\r\n", "\n").contains("format: dependency-notes/2\necosystem: mix"))
        assertTrue(gleamNotes.path.endsWith(".depos/gleam/DEPENDENCY-NOTES.md"))
        assertTrue(String(gleamNotes.contentsToByteArray()).replace("\r\n", "\n").contains("format: dependency-notes/2\necosystem: gleam"))
        assertTrue(zigNotes.path.endsWith(".depos/zig/DEPENDENCY-NOTES.md"))
        assertTrue(String(zigNotes.contentsToByteArray()).replace("\r\n", "\n").contains("format: dependency-notes/2\necosystem: zig"))
        assertTrue(pythonNotes.path.endsWith(".depos/python/DEPENDENCY-NOTES.md"))
        assertTrue(String(pythonNotes.contentsToByteArray()).replace("\r\n", "\n").contains("format: dependency-notes/2\necosystem: python"))
        assertTrue(nugetNotes.path.endsWith(".depos/nuget/DEPENDENCY-NOTES.md"))
        assertTrue(String(nugetNotes.contentsToByteArray()).replace("\r\n", "\n").contains("format: dependency-notes/2\necosystem: nuget"))
        assertNull(cargo.parent.findChild(".depos")?.findChild("DEPENDENCY-NOTES.md"))
    }

    fun testZigNearestAndRootOnlyResolutionStaysInItsNamespace() {
        val zig = myFixture.tempDirFixture.createFile(
            "apps/zig-app/build.zig.zon",
            ".{ .dependencies = .{ .known_folders = .{ .path = \"../known-folders\" } } }",
        )
        val rootNotes = myFixture.tempDirFixture.createFile(
            ".depos/zig/DEPENDENCY-NOTES.md",
            "## known_folders\n\nroot\n",
        )
        val nearNotes = myFixture.tempDirFixture.createFile(
            "apps/zig-app/.depos/zig/DEPENDENCY-NOTES.md",
            "## known_folders\n\nnear\n",
        )
        myFixture.tempDirFixture.createFile("apps/zig-app/.depos/cargo/DEPENDENCY-NOTES.md", "## known_folders\n\ncargo\n")

        assertEquals(nearNotes.path, service().resolveNotesFile(zig)?.path)
        assertEquals("near", service().noteFor(zig, "known_folders")?.layers?.human)
        service().state.monorepoMode = MonorepoModes.ROOT_ONLY
        assertEquals(rootNotes.path, service().resolveNotesFile(zig)?.path)
        assertEquals("root", service().noteFor(zig, "known_folders")?.layers?.human)
    }

    fun testGleamNearestAndRootOnlyResolutionStaysInItsNamespace() {
        val gleam = myFixture.tempDirFixture.createFile(
            "apps/gleam-app/gleam.toml",
            "[dependencies]\nshared_gleam = \"~> 1.0\"",
        )
        val rootNotes = myFixture.tempDirFixture.createFile(
            ".depos/gleam/DEPENDENCY-NOTES.md",
            "## shared_gleam\n\nroot\n",
        )
        val nearNotes = myFixture.tempDirFixture.createFile(
            "apps/gleam-app/.depos/gleam/DEPENDENCY-NOTES.md",
            "## shared_gleam\n\nnear\n",
        )
        myFixture.tempDirFixture.createFile(
            "apps/gleam-app/.depos/cargo/DEPENDENCY-NOTES.md",
            "## shared_gleam\n\ncargo\n",
        )

        assertEquals(nearNotes.path, service().resolveNotesFile(gleam)?.path)
        assertEquals("near", service().noteFor(gleam, "shared_gleam")?.layers?.human)
        service().state.monorepoMode = MonorepoModes.ROOT_ONLY
        assertEquals(rootNotes.path, service().resolveNotesFile(gleam)?.path)
        assertEquals("root", service().noteFor(gleam, "shared_gleam")?.layers?.human)
    }

    fun testDefaultManifestUsesActiveThenRootPriority() {
        val npm = myFixture.tempDirFixture.createFile("package.json", "{}")
        val cargo = myFixture.tempDirFixture.createFile("Cargo.toml", "[dependencies]")
        myFixture.tempDirFixture.createFile("pom.xml", "<project/>")
        val editors = FileEditorManager.getInstance(project)
        editors.openFiles.forEach(editors::closeFile)
        assertEquals(npm.path, service().defaultManifest()?.path)

        myFixture.configureFromExistingVirtualFile(cargo)
        assertEquals(cargo.path, service().defaultManifest()?.path)
    }

    fun testGradleNotesPreferKotlinThenGroovyManifestBesideThem() {
        val notes = myFixture.tempDirFixture.createFile(
            ".depos/gradle/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: gradle\n---\n# Dependency Notes\n",
        )
        val groovy = myFixture.tempDirFixture.createFile("build.gradle", "dependencies {}")
        assertEquals(groovy.path, service().manifestBesideNotes(notes)?.path)
        val kotlin = myFixture.tempDirFixture.createFile("build.gradle.kts", "dependencies {}")
        assertEquals(kotlin.path, service().manifestBesideNotes(notes)?.path)
    }

    fun testSharedAncestorNotesSeeAllResolvingCargoManifests() {
        val notes = myFixture.tempDirFixture.createFile(".depos/cargo/DEPENDENCY-NOTES.md", "## serde\n\nSerialization\n")
        myFixture.tempDirFixture.createFile("crates/a/Cargo.toml", "[dependencies]\nserde = \"1\"")
        myFixture.tempDirFixture.createFile("crates/b/Cargo.toml", "[dependencies]\ntokio = \"1\"")
        assertEquals(setOf("serde", "tokio"), service().dependenciesForNotes(notes).map { it.name }.toSet())
    }

    fun testSharedAncestorNotesSeeAllResolvingUmbrellaMixManifests() {
        val notes = myFixture.tempDirFixture.createFile(".depos/mix/DEPENDENCY-NOTES.md", "## phoenix\n\nFramework\n")
        myFixture.tempDirFixture.createFile("apps/web/mix.exs", "defp deps, do: [{:phoenix, \"~> 1.8\"}]")
        myFixture.tempDirFixture.createFile("apps/accounts/mix.exs", "defp deps, do: [{:ecto_sql, \"~> 3.13\"}]")
        assertEquals(setOf("phoenix", "ecto_sql"), service().dependenciesForNotes(notes).map { it.name }.toSet())
    }

    fun testSplitRequirementsShareProjectPythonNotesAndPreferPyproject() {
        val notes = myFixture.tempDirFixture.createFile(
            ".depos/python/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: python\n---\n# Dependency Notes\n",
        )
        val pyproject = myFixture.tempDirFixture.createFile(
            "pyproject.toml",
            "[project]\ndependencies = [\"requests>=2\"]",
        )
        val requirements = myFixture.tempDirFixture.createFile("requirements/dev.txt", "pytest>=8\n")

        assertEquals(notes.path, service().resolveNotesFile(requirements)?.path)
        assertEquals(setOf("requests", "pytest"), service().dependenciesForNotes(notes).map { it.name }.toSet())
        assertEquals(pyproject.path, service().manifestBesideNotes(notes)?.path)
    }

    fun testZigPackageCacheManifestsAreExcludedFromNotesDiscovery() {
        val notes = myFixture.tempDirFixture.createFile(
            ".depos/zig/DEPENDENCY-NOTES.md",
            "## real_dep\n\nApplication dependency\n",
        )
        myFixture.tempDirFixture.createFile(
            "apps/demo/build.zig.zon",
            ".{ .dependencies = .{ .real_dep = .{ .path = \"../real\" } } }",
        )
        for (directory in listOf("zig-pkg", ".zig-cache", "zig-cache", "zig-out")) {
            myFixture.tempDirFixture.createFile(
                "$directory/downloaded/build.zig.zon",
                ".{ .dependencies = .{ .cached_dep = .{ .path = \"../cached\" } } }",
            )
        }

        assertEquals(listOf("real_dep"), service().dependenciesForNotes(notes).map { it.name })
    }

    fun testGoVendorAndTestdataManifestsAreExcludedFromNotesDiscovery() {
        val notes = myFixture.tempDirFixture.createFile(
            ".depos/go/DEPENDENCY-NOTES.md",
            "## github.com/example/real\n\nApplication dependency\n",
        )
        myFixture.tempDirFixture.createFile("go.mod", "module m\n\nrequire github.com/example/real v1.0.0\n")
        for (directory in listOf("vendor/github.com/example/vendored", "internal/testdata/sample")) {
            myFixture.tempDirFixture.createFile(
                "$directory/go.mod",
                "module x\n\nrequire github.com/example/ignored v1.0.0\n",
            )
        }

        assertEquals(listOf("github.com/example/real"), service().dependenciesForNotes(notes).map { it.name })
    }

    fun testManifestWatcherInvalidatesTheWorkspaceIndex() {
        val notes = myFixture.tempDirFixture.createFile(".depos/cargo/DEPENDENCY-NOTES.md", "## serde\n\nSerialization\n")
        assertEmpty(service().dependenciesForNotes(notes))

        myFixture.tempDirFixture.createFile("crates/new/Cargo.toml", "[dependencies]\nserde = \"1\"")

        assertEquals(listOf("serde"), service().dependenciesForNotes(notes).map { it.name })
    }

    fun testNugetUsesTheClosestCentralManifestForResolutionAndCreation() {
        val rootCentral = myFixture.tempDirFixture.createFile(
            "Directory.Packages.props",
            "<Project><PackageVersion Include=\"Root.Package\" /></Project>",
        )
        val nestedCentral = myFixture.tempDirFixture.createFile(
            "apps/dotnet/Directory.Packages.props",
            "<Project><PackageVersion Include=\"Nested.Package\" /></Project>",
        )
        val rootProject = myFixture.tempDirFixture.createFile(
            "apps/root/App.csproj",
            "<Project><PackageReference Include=\"Root.Package\" /></Project>",
        )
        val nestedProject = myFixture.tempDirFixture.createFile(
            "apps/dotnet/src/App.csproj",
            "<Project><PackageReference Include=\"Nested.Package\" /></Project>",
        )
        val rootNotes = myFixture.tempDirFixture.createFile(
            ".depos/nuget/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: nuget\n---\n# Dependency Notes\n",
        )
        val nestedNotes = myFixture.tempDirFixture.createFile(
            "apps/dotnet/.depos/nuget/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: nuget\n---\n# Dependency Notes\n\n## nested.package\n\nShared note\n",
        )

        assertEquals(rootNotes.path, service().resolveNotesFile(rootCentral)?.path)
        assertEquals(rootNotes.path, service().resolveNotesFile(rootProject)?.path)
        assertEquals(nestedNotes.path, service().resolveNotesFile(nestedCentral)?.path)
        assertEquals(nestedNotes.path, service().resolveNotesFile(nestedProject)?.path)
        assertEquals("Shared note", service().noteFor(nestedCentral, "Nested.Package")?.layers?.human)
        assertEquals("Shared note", service().noteFor(nestedProject, "Nested.Package")?.layers?.human)

        service().state.monorepoMode = MonorepoModes.ROOT_ONLY
        assertEquals(rootNotes.path, service().resolveNotesFile(nestedProject)?.path)

    }

    fun testFirstNugetNoteIsCreatedBesideTheClosestCentralManifest() {
        myFixture.tempDirFixture.createFile(
            "apps/fresh/Directory.Packages.props",
            "<Project><PackageVersion Include=\"Fresh.Package\" /></Project>",
        )
        val freshProject = myFixture.tempDirFixture.createFile(
            "apps/fresh/src/App.vbproj",
            "<Project><PackageReference Include=\"Fresh.Package\" /></Project>",
        )

        val created = service().saveNoteLayers(freshProject, "Fresh.Package", "Fresh dependency", "")

        assertTrue(created.path.endsWith("apps/fresh/.depos/nuget/DEPENDENCY-NOTES.md"))
        assertTrue(
            String(created.contentsToByteArray()).replace("\r\n", "\n")
                .contains("format: dependency-notes/2\necosystem: nuget"),
        )
    }

    fun testNugetCoverageAggregatesBeforeNotesExistAndPrefersCentralCasing() {
        myFixture.tempDirFixture.createFile(
            "Directory.Packages.props",
            """
            <Project><ItemGroup>
              <PackageVersion Include="Newtonsoft.Json" />
              <GlobalPackageReference Include="Nerdbank.GitVersioning" />
            </ItemGroup></Project>
            """.trimIndent(),
        )
        val projectFile = myFixture.tempDirFixture.createFile(
            "src/App.csproj",
            """
            <Project><ItemGroup>
              <PackageReference Include="newtonsoft.json" />
              <PackageReference Include="Serilog" />
            </ItemGroup></Project>
            """.trimIndent(),
        )
        myFixture.tempDirFixture.createFile(
            "tests/Tests.fsproj",
            "<Project><PackageReference Include=\"SERILOG\" /></Project>",
        )

        val dependencies = service().dependenciesForCoverage(projectFile)
        assertEquals(
            listOf("Newtonsoft.Json", "Nerdbank.GitVersioning", "Serilog"),
            dependencies.map { it.displayName },
        )
        assertEquals("centralVersion", dependencies.first().section)
    }

    fun testNugetDiscoveryExcludesBinAndObj() {
        val notes = myFixture.tempDirFixture.createFile(
            ".depos/nuget/DEPENDENCY-NOTES.md",
            "---\nformat: dependency-notes/2\necosystem: nuget\n---\n# Dependency Notes\n",
        )
        myFixture.tempDirFixture.createFile(
            "src/App.csproj",
            "<Project><PackageReference Include=\"Real.Package\" /></Project>",
        )
        myFixture.tempDirFixture.createFile(
            "src/bin/Generated.csproj",
            "<Project><PackageReference Include=\"Bin.Package\" /></Project>",
        )
        myFixture.tempDirFixture.createFile(
            "src/obj/Generated.vbproj",
            "<Project><PackageReference Include=\"Obj.Package\" /></Project>",
        )

        assertEquals(listOf("Real.Package"), service().dependenciesForNotes(notes).map { it.displayName })
    }
}
