package dev.pacmon.jetbrains.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GleamManifestTest {
    private val manifest = """
        name = "example"
        version = "1.0.0"

        [dependencies]
        gleam_stdlib = ">= 0.44.0 and < 2.0.0"
        gleam_http = { hex = "gleam_http", version = "~> 4.0" }
        local_package = { path = "../local_package" }
        git_package = {
          git = "https://example.test/git_package.git",
          ref = "0123456789abcdef"
        }
        "quoted.package" = "~> 1.0"

        [dev_dependencies]
        gleeunit = ">= 1.0.0 and < 2.0.0"

        [javascript]
        typescript_declarations = true
    """.trimIndent()

    @Test
    fun `matches gleam manifest but not lock or generic TOML files`() {
        assertEquals(ManifestKind.GLEAM, ManifestRegistry.forPath("/repo/gleam.toml")?.kind)
        assertNull(ManifestRegistry.forPath("/repo/manifest.toml"))
        assertNull(ManifestRegistry.forPath("/repo/config.toml"))
    }

    @Test
    fun `extracts version Hex path Git and development dependencies`() {
        assertEquals(
            listOf(
                "dependencies:gleam_stdlib",
                "dependencies:gleam_http",
                "dependencies:local_package",
                "dependencies:git_package",
                "dependencies:quoted.package",
                "dev_dependencies:gleeunit",
            ),
            GleamManifestAdapter.extractDependencies(manifest).map { "${it.scope}:${it.noteKey}" },
        )
    }

    @Test
    fun `reads the older dev-dependencies table as the same development scope`() {
        val text = "[dependencies]\ngleam_stdlib = \"~> 0.40\"\n\n[dev-dependencies]\ngleeunit = \"~> 1.0\"\n\n[dev_dependencies]\ngleeunit = \"~> 1.0\"\n"
        assertEquals(
            listOf("dependencies:gleam_stdlib", "dev_dependencies:gleeunit"),
            GleamManifestAdapter.extractDependencies(text).map { "${it.scope}:${it.noteKey}" },
        )
    }

    @Test
    fun `keeps keys clickable and uses them as marker anchors`() {
        val dependencies = GleamManifestAdapter.extractDependencies(manifest)
        val stdlib = dependencies.first()
        assertEquals(
            "gleam_stdlib",
            manifest.substring(stdlib.primaryRange.offset, stdlib.primaryRange.offset + stdlib.primaryRange.length),
        )
        assertEquals(stdlib.primaryRange, stdlib.iconRange)
        assertEquals(stdlib, ManifestRegistry.dependencyAtOffset(dependencies, stdlib.primaryRange.offset + 2))

        val quoted = dependencies.first { it.noteKey == "quoted.package" }
        assertEquals(
            "\"quoted.package\"",
            manifest.substring(quoted.primaryRange.offset, quoted.primaryRange.offset + quoted.primaryRange.length),
        )
    }

    @Test
    fun `ignores comments unrelated tables and assignment-like text in values`() {
        val text = """
            # [dependencies]
            # commented = "1"
            description = "fake = dependency"

            [repository]
            type = "github"
            repo = "not_a_dependency"

            [dependencies]
            real_package = { git = "https://example.test/fake = value.git" }

            [erlang]
            application_start_module = "ignored"
        """.trimIndent()
        assertEquals(listOf("real_package"), GleamManifestAdapter.extractDependencies(text).map { it.noteKey })
    }

    @Test
    fun `deduplicates within a scope and preserves entries before a malformed tail`() {
        val text = "[dependencies]\r\nfirst = \"1\"\r\nfirst = \"2\"\r\nbroken = {\r\n"
        val dependencies = GleamManifestAdapter.extractDependencies(text)
        assertEquals(listOf("first", "broken"), dependencies.map { it.noteKey })
        val broken = dependencies.last()
        assertEquals("broken", text.substring(broken.primaryRange.offset, broken.primaryRange.offset + broken.primaryRange.length))
    }
}
