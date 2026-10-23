package dev.pacmon.jetbrains.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class VcpkgManifestTest {
    private val manifest = """{
  // JSONC is accepted for editor tolerance.
  "dependencies": [
    "fmt",
    { "name": "OpenSSL", "host": true, "features": ["tools"] },
    { "name": "zlib", "default-features": false },
  ],
  "features": {
    "tests": {
      "description": "Test support",
      "dependencies": ["catch2", { "name": "pkgconf", "host": true }]
    }
  },
  "overrides": [{ "name": "ignored", "version": "1.0" }],
  "builtin-baseline": "deadbeef"
}"""

    @Test
    fun `matches vcpkg json only`() {
        assertEquals(ManifestKind.VCPKG, ManifestRegistry.forPath("/repo/vcpkg.json")?.kind)
        assertNull(ManifestRegistry.forPath("/repo/vcpkg-configuration.json"))
    }

    @Test
    fun `extracts root feature and host declarations`() {
        assertEquals(
            listOf(
                "dependencies:fmt:fmt",
                "dependencies:host:openssl:OpenSSL",
                "dependencies:zlib:zlib",
                "feature:tests:catch2:catch2",
                "feature:tests:host:pkgconf:pkgconf",
            ),
            VcpkgManifestAdapter.extractDependencies(manifest).map {
                "${it.scope}:${it.noteKey}:${it.displayName}"
            },
        )
    }

    @Test
    fun `returns exact package and icon source ranges`() {
        val dependencies = VcpkgManifestAdapter.extractDependencies(manifest)
        for (dependency in dependencies) {
            val range = dependency.primaryRange
            assertEquals(dependency.displayName, manifest.substring(range.offset, range.offset + range.length))
            assertTrue(manifest[dependency.iconRange.offset] in setOf('"', '{'))
            assertSame(dependency, ManifestRegistry.dependencyAtOffset(dependencies, range.offset + 1))
        }
    }

    @Test
    fun `keeps valid declarations from malformed JSON and ignores invalid entries`() {
        val malformed = "{ \"dependencies\": [\"fmt\", 42, { \"name\": \"bad name\" }, { \"name\": \"zlib\" }"
        assertEquals(
            listOf("fmt", "zlib"),
            VcpkgManifestAdapter.extractDependencies(malformed).map { it.noteKey },
        )
        assertEquals(
            listOf("fmt"),
            VcpkgManifestAdapter.extractDependencies("{ \"dependencies\": [\"fmt\" } ] }").map { it.noteKey },
        )
    }

    @Test
    fun `matches note headings case-insensitively`() {
        val notes = NotesCore.parse("---\nformat: dependency-notes/2\necosystem: vcpkg\n---\n# Dependency Notes\n\n## FMT\n\nFormatting.\n")
        val dependency = VcpkgManifestAdapter.extractDependencies("{\"dependencies\":[\"fmt\"]}").single()
        assertNotNull(NotesCore.findSection(notes, dependency.noteKey))
    }
}
