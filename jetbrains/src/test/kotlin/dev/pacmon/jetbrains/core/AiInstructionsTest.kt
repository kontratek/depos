package dev.pacmon.jetbrains.core

import org.junit.Assert.assertTrue
import org.junit.Test

class AiInstructionsTest {
    @Test
    fun `generated block names the notes file of every ecosystem`() {
        val block = AiInstructions.block()
        assertTrue(block.contains("`.pacmon/DEPENDENCY-NOTES.md` for npm"))
        for ((directory, ecosystem) in listOf(
            "cargo" to "Rust", "maven" to "Maven", "gradle" to "Gradle", "mix" to "Mix", "gleam" to "Gleam",
            "zig" to "Zig", "python" to "Python", "ruby" to "Ruby", "go" to "Go", "nuget" to ".NET/NuGet",
            "vcpkg" to "vcpkg", "conan" to "Conan", "composer" to "PHP/Composer",
        )) {
            assertTrue(ecosystem, block.contains("`.pacmon/$directory/DEPENDENCY-NOTES.md` for $ecosystem"))
        }
    }
}
