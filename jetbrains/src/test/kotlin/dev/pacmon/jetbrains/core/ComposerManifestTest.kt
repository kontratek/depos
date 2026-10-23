package dev.pacmon.jetbrains.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerManifestTest {
    private val manifest = """{
  // JSONC is accepted for editor tolerance.
  "require": {
    "php": "^8.3",
    "ext-mbstring": "*",
    "lib-curl": ">=7.0",
    "composer-runtime-api": "^2.2",
    "Monolog/Monolog": "^3.0",
  },
  "require-dev": {
    "phpunit/phpunit": "^11.0"
  },
  "provide": { "psr/log-implementation": "3.0" },
  "replace": { "legacy/package": "self.version" },
  "conflict": { "bad/package": "<2" },
  "suggest": { "optional/package": "Optional integration" }
}"""

    @Test
    fun `matches composer json only`() {
        assertEquals(ManifestKind.COMPOSER, ManifestRegistry.forPath("/repo/composer.json")?.kind)
        assertNull(ManifestRegistry.forPath("/repo/composer.lock"))
    }

    @Test
    fun `extracts runtime development and platform requirements`() {
        assertEquals(
            listOf(
                "require:php:php",
                "require:ext-mbstring:ext-mbstring",
                "require:lib-curl:lib-curl",
                "require:composer-runtime-api:composer-runtime-api",
                "require:monolog/monolog:Monolog/Monolog",
                "require-dev:phpunit/phpunit:phpunit/phpunit",
            ),
            ComposerManifestAdapter.extractDependencies(manifest).map {
                "${it.scope}:${it.noteKey}:${it.displayName}"
            },
        )
    }

    @Test
    fun `ignores package links that do not install direct dependencies`() {
        val names = ComposerManifestAdapter.extractDependencies(manifest).map { it.noteKey }
        assertFalse("psr/log-implementation" in names)
        assertFalse("legacy/package" in names)
        assertFalse("bad/package" in names)
        assertFalse("optional/package" in names)
    }

    @Test
    fun `supports every Composer platform package family`() {
        val names = listOf(
            "php", "php-64bit", "php-ipv6", "php-zts", "php-debug", "php-future-capability", "hhvm",
            "ext-json", "lib-iconv", "composer", "composer-plugin-api", "composer-runtime-api",
        )
        val text = names.joinToString(",", prefix = "{\"require\":{", postfix = "}}") { "\"$it\":\"*\"" }
        assertEquals(names, ComposerManifestAdapter.extractDependencies(text).map { it.noteKey })
    }

    @Test
    fun `returns exact clickable package and icon ranges`() {
        val dependencies = ComposerManifestAdapter.extractDependencies(manifest)
        for (dependency in dependencies) {
            val range = dependency.primaryRange
            assertEquals(dependency.displayName, manifest.substring(range.offset, range.offset + range.length))
            assertEquals('"', manifest[dependency.iconRange.offset])
            assertSame(dependency, ManifestRegistry.dependencyAtOffset(dependencies, range.offset + 1))
        }
    }

    @Test
    fun `keeps valid declarations from malformed JSON and ignores invalid entries`() {
        val malformed = "{ \"require\": { \"vendor/one\": \"^1\", \"bad name\": \"*\", \"vendor/two\": \"^2\" "
        assertEquals(
            listOf("vendor/one", "vendor/two"),
            ComposerManifestAdapter.extractDependencies(malformed).map { it.noteKey },
        )
        assertTrue(
            ComposerManifestAdapter.extractDependencies("{ \"require\": [], \"require-dev\": { \"vendor/object\": {} } }")
                .isEmpty(),
        )
    }

    @Test
    fun `matches Composer note headings case-insensitively`() {
        val notes = NotesCore.parse(
            "---\nformat: dependency-notes/2\necosystem: composer\n---\n# Dependency Notes\n\n## MONOLOG/MONOLOG\n\nLogging.\n",
        )
        val dependency = ComposerManifestAdapter.extractDependencies("{\"require\":{\"monolog/monolog\":\"^3\"}}").single()
        assertNotNull(NotesCore.findSection(notes, dependency.noteKey))
    }
}
