package dev.pacmon.jetbrains.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ManifestCoreTest {
    @Test
    fun `registry matches only supported manifests in priority order`() {
        assertEquals(
            listOf("package.json", "Cargo.toml", "pom.xml", "build.gradle.kts", "build.gradle", "mix.exs", "gleam.toml", "build.zig.zon", "pyproject.toml", "requirements.txt", "Gemfile", "gems.rb", "composer.json", "Directory.Packages.props", "go.mod", "vcpkg.json", "conanfile.py", "conanfile.txt"),
            ManifestRegistry.adapters.flatMap { it.fileNames },
        )
        assertEquals(ManifestKind.NPM, ManifestRegistry.forFileName("package.json")?.kind)
        assertEquals(ManifestKind.CARGO, ManifestRegistry.forFileName("Cargo.toml")?.kind)
        assertEquals(ManifestKind.MAVEN, ManifestRegistry.forFileName("pom.xml")?.kind)
        assertEquals(ManifestKind.GRADLE, ManifestRegistry.forFileName("build.gradle.kts")?.kind)
        assertEquals(ManifestKind.GRADLE, ManifestRegistry.forFileName("build.gradle")?.kind)
        assertEquals(ManifestKind.MIX, ManifestRegistry.forFileName("mix.exs")?.kind)
        assertEquals(ManifestKind.GLEAM, ManifestRegistry.forFileName("gleam.toml")?.kind)
        assertEquals(ManifestKind.ZIG, ManifestRegistry.forFileName("build.zig.zon")?.kind)
        assertEquals(ManifestKind.PYTHON, ManifestRegistry.forFileName("pyproject.toml")?.kind)
        assertEquals(ManifestKind.PYTHON, ManifestRegistry.forFileName("requirements-dev.txt")?.kind)
        assertEquals(ManifestKind.RUBY, ManifestRegistry.forFileName("Gemfile")?.kind)
        assertEquals(ManifestKind.RUBY, ManifestRegistry.forFileName("gems.rb")?.kind)
        assertEquals(ManifestKind.RUBY, ManifestRegistry.forFileName("example.gemspec")?.kind)
        assertEquals(ManifestKind.COMPOSER, ManifestRegistry.forFileName("composer.json")?.kind)
        assertEquals(ManifestKind.NUGET, ManifestRegistry.forFileName("App.csproj")?.kind)
        assertEquals(ManifestKind.NUGET, ManifestRegistry.forFileName("App.fsproj")?.kind)
        assertEquals(ManifestKind.NUGET, ManifestRegistry.forFileName("App.vbproj")?.kind)
        assertEquals(ManifestKind.NUGET, ManifestRegistry.forFileName("Directory.Packages.props")?.kind)
        assertEquals(ManifestKind.GO, ManifestRegistry.forFileName("go.mod")?.kind)
        assertEquals(ManifestKind.VCPKG, ManifestRegistry.forFileName("vcpkg.json")?.kind)
        assertNull(ManifestRegistry.forFileName("vcpkg-configuration.json"))
        assertEquals(ManifestKind.CONAN, ManifestRegistry.forFileName("conanfile.py")?.kind)
        assertEquals(ManifestKind.CONAN, ManifestRegistry.forFileName("conanfile.txt")?.kind)
        assertNull(ManifestRegistry.forFileName("conan.lock"))
        assertNull(ManifestRegistry.forFileName("go.sum"))
        assertNull(ManifestRegistry.forFileName("Gemfile.lock"))
        assertNull(ManifestRegistry.forFileName("composer.lock"))
        assertNull(ManifestRegistry.forFileName("settings.gradle.kts"))
    }

    @Test
    fun `zig extracts URL path lazy and escaped direct dependencies with ranges`() {
        val text = """
            .{
              .name = .example,
              .version = "0.1.0",
              .dependencies = .{
                .known_folders = .{
                  .url = "https://example.test/known-folders.tar.gz",
                  .hash = "known-folders-hash",
                },
                .local_utils = .{ .path = "../local-utils" },
                .lazy_dep = .{
                  .url = "https://example.test/lazy.tar.gz",
                  .hash = "lazy-hash",
                  .lazy = true,
                },
                .@"quoted-dep" = .{ .path = "../quoted" },
              },
              .paths = .{ "build.zig", "src" },
            }
        """.trimIndent()
        val dependencies = ZigManifestAdapter.extractDependencies(text)
        assertEquals(
            listOf(
                "dependencies:known_folders",
                "dependencies:local_utils",
                "dependencies:lazy_dep",
                "dependencies:quoted-dep",
            ),
            dependencies.map { "${it.scope}:${it.noteKey}" },
        )

        val known = dependencies.first()
        assertEquals("known_folders", text.substring(known.primaryRange.offset, known.primaryRange.offset + known.primaryRange.length))
        assertEquals("known_folders", text.substring(known.sourceRanges.single().offset, known.sourceRanges.single().offset + known.sourceRanges.single().length))
        assertEquals(".", text.substring(known.iconRange.offset, known.iconRange.offset + known.iconRange.length))
        assertEquals(known, ManifestRegistry.dependencyAtOffset(dependencies, known.primaryRange.offset + 2))

        val quoted = dependencies.last()
        assertEquals("quoted-dep", text.substring(quoted.primaryRange.offset, quoted.primaryRange.offset + quoted.primaryRange.length))
        assertEquals("@\"quoted-dep\"", text.substring(quoted.sourceRanges.single().offset, quoted.sourceRanges.single().offset + quoted.sourceRanges.single().length))
    }

    @Test
    fun `zig ignores nested fields and declarations in comments strings and multiline strings`() {
        val text = """
            .{
              // .dependencies = .{ .commented = .{ .path = "x" } },
              .description = ".dependencies = .{ .string = .{} }",
              \\ .dependencies = .{ .multiline = .{} },
              .dependencies = .{
                .real = .{
                  .url = "https://example.test/.fake = .{}",
                  .hash = "hash",
                },
              },
              .other = .{ .nested = .{ .path = "not-a-dependency" } },
            }
        """.trimIndent()
        assertEquals(listOf("real"), ZigManifestAdapter.extractDependencies(text).map { it.noteKey })
    }

    @Test
    fun `zig decodes escaped identifiers and keeps the first duplicate`() {
        val text = """
            .{ .dependencies = .{
              .@"quoted\x2ddep" = .{ .path = "a" },
              .@"quoted-dep" = .{ .path = "b" },
              .@"snowman\u{2603}" = .{ .path = "c" },
            } }
        """.trimIndent()
        assertEquals(
            listOf("quoted-dep", "snowman☃"),
            ZigManifestAdapter.extractDependencies(text).map { it.noteKey },
        )
    }

    @Test
    fun `zig accepts legacy manifests and preserves fields before a malformed tail`() {
        val legacy = """
            .{
              .name = "legacy-app",
              .version = "0.1.0",
              .dependencies = .{ .legacy_dep = .{ .path = "../legacy" } },
            }
        """.trimIndent()
        assertEquals(listOf("legacy_dep"), ZigManifestAdapter.extractDependencies(legacy).map { it.noteKey })
        assertEquals(
            listOf("first", "broken"),
            ZigManifestAdapter.extractDependencies(".{ .dependencies = .{ .first = .{}, .broken = .{").map { it.noteKey },
        )
        assertTrue(ZigManifestAdapter.extractDependencies(".{ .dependencies = .{} }").isEmpty())
        assertTrue(ZigManifestAdapter.extractDependencies(".{ .name = .none }").isEmpty())
    }

    @Test
    fun `npm extracts four dependency scopes with source ranges`() {
        val text = """
            {
              // jsonc is accepted
              "dependencies": { "vue": "^3", },
              "devDependencies": { "vitest": "^4" },
              "peerDependencies": { "react": "^19" },
              "optionalDependencies": { "fsevents": "^2" },
              "scripts": { "test": "vitest" }
            }
        """.trimIndent()
        val dependencies = NpmManifestAdapter.extractDependencies(text)
        assertEquals(listOf("vue", "vitest", "react", "fsevents"), dependencies.map { it.noteKey })
        assertEquals(
            listOf("dependencies", "devDependencies", "peerDependencies", "optionalDependencies"),
            dependencies.map { it.scope },
        )
        val vue = dependencies.first()
        assertEquals("\"vue\"", text.substring(vue.primaryRange.offset, vue.primaryRange.offset + vue.primaryRange.length))
        assertEquals(vue.primaryRange, vue.iconRange)
        assertEquals(vue, ManifestRegistry.dependencyAtOffset(dependencies, vue.primaryRange.offset + 2))
    }

    @Test
    fun `cargo extracts direct target table alias and workspace declarations`() {
        val text = """
            [dependencies]
            serde = "1"
            local = { package = "upstream", version = "2" }
            "quoted.name" = { workspace = true }
            workspace-crate.workspace = true

            [dev-dependencies]
            insta = "1"

            [build-dependencies.bindgen]
            version = "0.70"

            [target.'cfg(unix)'.dependencies]
            nix = {
              version = "0.29"
            }

            [target."cfg(windows)".dependencies.windows-sys]
            version = "0.59"

            [workspace.dependencies]
            ignored = "1"
        """.trimIndent()
        val dependencies = CargoManifestAdapter.extractDependencies(text)
        assertEquals(
            listOf("serde", "local", "quoted.name", "workspace-crate", "insta", "bindgen", "nix", "windows-sys"),
            dependencies.map { it.noteKey },
        )
        assertEquals("local", dependencies[1].displayName)
        assertEquals("build-dependencies", dependencies[5].scope)
        assertEquals("target:cfg(unix)/dependencies", dependencies[6].scope)
        assertEquals("target:cfg(windows)/dependencies", dependencies[7].scope)
        dependencies.forEach { dependency ->
            assertTrue(text.substring(dependency.primaryRange.offset, dependency.primaryRange.offset + dependency.primaryRange.length).isNotBlank())
            assertEquals(dependency.primaryRange, dependency.iconRange)
        }
    }

    @Test
    fun `maven extracts project and profile dependencies and excludes managed and plugins`() {
        val text = """
            <?xml version="1.0"?>
            <m:project xmlns:m="urn:test">
              <m:dependencies>
                <m:dependency optional="true">
                  <m:groupId>org.example</m:groupId>
                  <m:artifactId><![CDATA[core-lib]]></m:artifactId>
                </m:dependency>
                <!-- retained coordinates -->
                <m:dependency>
                  <m:groupId>${'$'}{company.group}</m:groupId>
                  <m:artifactId>api&amp;client</m:artifactId>
                  <m:scope>runtime</m:scope>
                </m:dependency>
              </m:dependencies>
              <m:dependencyManagement><m:dependencies><m:dependency>
                <m:groupId>ignored</m:groupId><m:artifactId>managed</m:artifactId>
              </m:dependency></m:dependencies></m:dependencyManagement>
              <m:build><m:plugins><m:plugin><m:dependencies><m:dependency>
                <m:groupId>ignored</m:groupId><m:artifactId>plugin</m:artifactId>
              </m:dependency></m:dependencies></m:plugin></m:plugins></m:build>
              <m:profiles><m:profile><m:id>fast</m:id><m:dependencies><m:dependency>
                <m:groupId>org.junit</m:groupId><m:artifactId>junit</m:artifactId><m:scope>test</m:scope>
              </m:dependency></m:dependencies></m:profile></m:profiles>
            </m:project>
        """.trimIndent()
        val dependencies = MavenManifestAdapter.extractDependencies(text)
        assertEquals(
            listOf("org.example:core-lib", "${'$'}{company.group}:api&client", "org.junit:junit"),
            dependencies.map { it.noteKey },
        )
        assertEquals(listOf("compile", "runtime", "profile:fast/test"), dependencies.map { it.scope })
        assertEquals(2, dependencies.first().sourceRanges.size)
        assertEquals("core-lib", text.substring(
            dependencies.first().primaryRange.offset,
            dependencies.first().primaryRange.offset + dependencies.first().primaryRange.length,
        ))
        assertEquals(text.indexOf("<m:dependency optional=\"true\">"), dependencies.first().iconRange.offset)
        assertEquals("<", text.substring(
            dependencies.first().iconRange.offset,
            dependencies.first().iconRange.offset + dependencies.first().iconRange.length,
        ))
        assertNull(ManifestRegistry.dependencyAtOffset(dependencies, dependencies.first().iconRange.offset))
    }

    @Test
    fun `malformed input is safe`() {
        assertTrue(NpmManifestAdapter.extractDependencies("{\"dependencies\": {").isEmpty())
        assertTrue(CargoManifestAdapter.extractDependencies("[dependencies\nserde = {").isEmpty())
        assertTrue(MavenManifestAdapter.extractDependencies("<project><dependencies><dependency>").isEmpty())
        assertTrue(GradleManifestAdapter.extractDependencies("dependencies { implementation(\"g:a:1\")").isEmpty())
        assertTrue(MixManifestAdapter.extractDependencies("defp deps do [{:phoenix, \"~> 1.8\"}").isEmpty())
        assertTrue(GleamManifestAdapter.extractDependencies("[dependencies").isEmpty())
        assertTrue(ZigManifestAdapter.extractDependencies(".{ .dependencies =").isEmpty())
    }

    @Test
    fun `gradle extracts static module map platform alias and add declarations`() {
        val text = """
            plugins { id("java") }
            dependencies {
                val example = "ignored:string:1"
                // implementation("ignored:comment:1")
                implementation("com.google.guava:guava:33.4.0-jre")
                testImplementation 'org.junit.jupiter:junit-jupiter:5.12.0'
                api(group = "org.slf4j", name = "slf4j-api", version = version)
                runtimeOnly group: 'org.postgresql', name: 'postgresql', version: pgVersion
                implementation(platform("org.springframework.boot:spring-boot-dependencies:3.5.0"))
                implementation(libs.jackson.databind)
                add("integrationTestImplementation", "org.assertj:assertj-core:3.27.3")
                "customRuntime"("com.acme:tool:1")
                constraints { implementation("ignored:constraint:1") }
                implementation(project(":local"))
                runtimeOnly(files("libs/local.jar"))
                runtimeOnly(files("C:/libs/local.jar"))
                implementation(libs.bundles.testing)
            }
            buildscript { dependencies { classpath("ignored:plugin:1") } }
        """.trimIndent()
        val dependencies = GradleManifestAdapter.extractDependencies(text)
        assertEquals(
            listOf(
                "implementation:com.google.guava:guava",
                "testImplementation:org.junit.jupiter:junit-jupiter",
                "api:org.slf4j:slf4j-api",
                "runtimeOnly:org.postgresql:postgresql",
                "implementation:org.springframework.boot:spring-boot-dependencies",
                "implementation:libs.jackson.databind",
                "integrationTestImplementation:org.assertj:assertj-core",
                "customRuntime:com.acme:tool",
            ),
            dependencies.map { "${it.scope}:${it.noteKey}" },
        )
        val guava = dependencies.first()
        assertEquals("guava", text.substring(guava.primaryRange.offset, guava.primaryRange.offset + guava.primaryRange.length))
        assertEquals(
            "implementation",
            text.substring(guava.iconRange.offset, guava.iconRange.offset + guava.iconRange.length),
        )
        assertEquals(
            listOf("com.google.guava", "guava"),
            guava.sourceRanges.map { text.substring(it.offset, it.offset + it.length) },
        )
    }

    @Test
    fun `gradle handles multiline wrappers`() {
        val text = """
            dependencies {
                implementation(
                    enforcedPlatform(
                        "com.acme:bom:1"
                    )
                )
            }
        """.trimIndent()
        assertEquals(listOf("com.acme:bom"), GradleManifestAdapter.extractDependencies(text).map { it.noteKey })
    }

    @Test
    fun `mix extracts literal source forms scopes ranges and deduplicates`() {
        val text = """
            defmodule Example.MixProject do
              use Mix.Project
              def project, do: [app: :example, deps: deps()]
              defp deps do
                [
                  {:phoenix, "~> 1.8"},
                  {:ecto_sql, "~> 3.13", only: [:dev, :test]},
                  {:wallaby, "~> 0.30", only: :test},
                  {:nerves_system, github: "nerves-project/system", targets: [:rpi3, :rpi4]},
                  {:local_app, path: "../local_app"},
                  {:accounts, in_umbrella: true},
                  {:"quoted-dep", "~> 1.0"},
                  {:wallaby, "~> 0.30", only: :test}
                ]
              end
            end
        """.trimIndent()
        val dependencies = MixManifestAdapter.extractDependencies(text)
        assertEquals(
            listOf(
                "deps:phoenix",
                "deps:dev,test:ecto_sql",
                "deps:test:wallaby",
                "deps@rpi3,rpi4:nerves_system",
                "deps:local_app",
                "deps:accounts",
                "deps:quoted-dep",
            ),
            dependencies.map { "${it.scope}:${it.noteKey}" },
        )
        val phoenix = dependencies.first()
        assertEquals("phoenix", text.substring(phoenix.primaryRange.offset, phoenix.primaryRange.offset + phoenix.primaryRange.length))
        assertEquals(":phoenix", text.substring(phoenix.sourceRanges.first().offset, phoenix.sourceRanges.first().offset + phoenix.sourceRanges.first().length))
        assertEquals("{", text.substring(phoenix.iconRange.offset, phoenix.iconRange.offset + phoenix.iconRange.length))
        assertEquals(phoenix, ManifestRegistry.dependencyAtOffset(dependencies, text.indexOf(":phoenix") + 2))
    }

    @Test
    fun `mix supports inline lists and ignores dynamic and literal lookalikes`() {
        val staticText = "def project, do: [deps: [{:jason, \"~> 1.4\"}]]\n" +
            "defp deps(), do: [{:plug, git: \"https://example.test/plug.git\"}]"
        assertEquals(listOf("jason", "plug"), MixManifestAdapter.extractDependencies(staticText).map { it.noteKey })

        val dynamic = listOf(
            "# deps: [{:commented, \"1\"}]",
            "@deps [{:attribute, \"1\"}]",
            "@doc \"deps: [{:string, \\\"1\\\"}]\"",
            "@moduledoc \"\"\"",
            "deps: [{:heredoc, \"1\"}]",
            "\"\"\"",
            "@pattern ~r/deps: \\[\\{:sigil, \"1\"\\}\\]/",
            "defp deps do",
            "  @deps ++ [{:concatenated, \"1\"}]",
            "end",
            "defp other, do: [{:other_helper, \"1\"}]",
            "defp nested, do: [{:outer, custom: [only: :test], deps: [{:nested, \"1\"}]}]",
        ).joinToString("\n")
        assertTrue(MixManifestAdapter.extractDependencies(dynamic).isEmpty())
    }
}
