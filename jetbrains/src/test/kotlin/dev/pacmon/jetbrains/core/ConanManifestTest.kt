package dev.pacmon.jetbrains.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ConanManifestTest {
    private val textManifest = """[requires]
zlib/1.3.1
OpenSSL/3.3.0@vendor/stable#revision

[tool_requires]
cmake/3.30.1

[test_requires]
catch2/3.7.0

[build_requires]
ninja/1.12.1

[generators]
CMakeDeps
"""

    private val recipe = """from conan import ConanFile

class Example(ConanFile):
    requires = "zlib/1.3.1", "fmt/11.0.2"
    tool_requires = ["cmake/3.30.1", "ninja/1.12.1"]
    test_requires = ("catch2/3.7.0",)
    build_requires = "legacy_tool/1.0"
    ignored = "fake/1.0"
    dynamic = get_requirements()

    def requirements(self):
        self.requires("OpenSSL/3.3.0@vendor/stable")
        self.tool_requires("meson/1.5.0", force=True)
        self.test_requires(variable)
        self.requires(f"dynamic/{self.version}")
        text = "self.requires(\"string_fake/1.0\")"
        # self.requires("comment_fake/1.0")

def unrelated():
    requires = "outside/1.0"
"""

    private fun summary(dependencies: List<DependencyEntry>) =
        dependencies.map { "${it.scope}:${it.noteKey}:${it.displayName}" }

    @Test
    fun `matches Conan recipes but not lockfiles`() {
        assertEquals(ManifestKind.CONAN, ManifestRegistry.forPath("/repo/conanfile.py")?.kind)
        assertEquals(ManifestKind.CONAN, ManifestRegistry.forPath("/repo/conanfile.txt")?.kind)
        assertNull(ManifestRegistry.forPath("/repo/conan.lock"))
    }

    @Test
    fun `extracts all supported conanfile txt sections`() {
        assertEquals(
            listOf(
                "requires:zlib:zlib",
                "requires:openssl:OpenSSL",
                "tool_requires:cmake:cmake",
                "test_requires:catch2:catch2",
                "build_requires:ninja:ninja",
            ),
            summary(ConanManifestAdapter.extractTextDependencies(textManifest)),
        )
    }

    @Test
    fun `keeps exact conanfile txt ranges with CRLF line endings`() {
        val crlf = textManifest.replace("\n", "\r\n")
        for (text in listOf(textManifest, crlf)) {
            val dependencies = ConanManifestAdapter.extractTextDependencies(text)
            assertEquals(5, dependencies.size)
            for (dependency in dependencies) {
                val range = dependency.primaryRange
                assertEquals(dependency.displayName, text.substring(range.offset, range.offset + range.length))
            }
        }
    }

    @Test
    fun `extracts literal fields and self calls without executing Python`() {
        assertEquals(
            listOf(
                "requires:zlib:zlib",
                "requires:fmt:fmt",
                "tool_requires:cmake:cmake",
                "tool_requires:ninja:ninja",
                "test_requires:catch2:catch2",
                "build_requires:legacy_tool:legacy_tool",
                "requires:openssl:OpenSSL",
                "tool_requires:meson:meson",
            ),
            summary(ConanManifestAdapter.extractPythonDependencies(recipe)),
        )
    }

    @Test
    fun `returns exact source ranges and dispatches by filename`() {
        val dependencies = ConanManifestAdapter.extractDependencies(recipe, "/repo/conanfile.py")
        assertEquals(8, dependencies.size)
        for (dependency in dependencies) {
            val range = dependency.primaryRange
            assertEquals(dependency.displayName, recipe.substring(range.offset, range.offset + range.length))
            assertTrue(recipe[dependency.iconRange.offset] in setOf('"', '\''))
            assertSame(dependency, ManifestRegistry.dependencyAtOffset(dependencies, range.offset + 1))
        }
        assertEquals(
            "zlib",
            ConanManifestAdapter.extractDependencies("[requires]\nzlib/1.3.1\n", "/repo/conanfile.txt").single().noteKey,
        )
    }

    @Test
    fun `keeps declarations before malformed Python`() {
        val malformed = "class Recipe:\n    requires = \"zlib/1.3.1\"\n    broken = \"unterminated"
        assertEquals(listOf("zlib"), ConanManifestAdapter.extractPythonDependencies(malformed).map { it.noteKey })
    }

    @Test
    fun `matches note headings case-insensitively`() {
        val notes = NotesCore.parse("---\nformat: dependency-notes/2\necosystem: conan\n---\n# Dependency Notes\n\n## ZLIB\n\nCompression.\n")
        val dependency = ConanManifestAdapter.extractTextDependencies("[requires]\nzlib/1.3.1\n").single()
        assertNotNull(NotesCore.findSection(notes, dependency.noteKey))
    }
}
