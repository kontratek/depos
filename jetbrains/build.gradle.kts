import org.commonmark.parser.Parser
import org.commonmark.renderer.html.HtmlRenderer
import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.models.ProductRelease
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

buildscript {
    repositories {
        mavenCentral()
    }
    dependencies {
        // Renders the CHANGELOG section into the change notes, below.
        classpath("org.commonmark:commonmark:0.24.0")
    }
}

plugins {
    id("org.jetbrains.kotlin.jvm")
    id("org.jetbrains.intellij.platform")
}

group = "dev.pacmon"

// One version for the whole repository: the Release workflow raises it in
// package.json and the plugin follows. The Marketplace refuses a version it
// already has, so this is also what keeps a re-run from uploading twice.
val packageJson = providers.fileContents(layout.projectDirectory.file("../package.json")).asText
val pluginVersion = Regex("(?m)^ {2}\"version\": \"([^\"]+)\"").find(packageJson.get())!!.groupValues[1]
version = pluginVersion

// The listing shows this version's CHANGELOG section as its change notes, rendered
// to HTML. Between releases package.json still names the last release, so a local
// build carries that release's notes; "Unreleased" is the fallback for a version
// that has no section of its own. Rendered here, at configuration time, into a
// plain String: a provider mapped in this script would carry a reference to the
// script, which the configuration cache cannot store. The file read is still
// tracked as a build input.
val changeNotesHtml: String = run {
    val lines = providers.fileContents(layout.projectDirectory.file("../CHANGELOG.md")).asText.get().lines()
    fun section(isHeading: (String) -> Boolean): String? {
        val start = lines.indexOfFirst(isHeading)
        if (start < 0) return null
        return lines.drop(start + 1).takeWhile { !it.startsWith("## ") }.joinToString("\n").trim().ifEmpty { null }
    }
    val heading = "## $pluginVersion"
    val markdown = section { it.startsWith(heading) && it.drop(heading.length).firstOrNull()?.isLetterOrDigit() != true }
        ?: section { it.trim() == "## Unreleased" }
        ?: ""
    HtmlRenderer.builder().build().render(Parser.builder().build().parse(markdown)).trim()
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2025.2.6.2")
        bundledModule("com.intellij.modules.json")
        testFramework(TestFrameworkType.Platform)
    }
    implementation("org.commonmark:commonmark:0.24.0")
    testImplementation("junit:junit:4.13.2")
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_21
        freeCompilerArgs.add("-Xjvm-default=all")
    }
}

intellijPlatform {
    pluginConfiguration {
        changeNotes = changeNotesHtml
        ideaVersion {
            sinceBuild = "252"
        }
    }
    publishing {
        // A Permanent Token from the Marketplace profile ("My Tokens"), held in the
        // JETBRAINS_TOKEN repository secret; see docs/releasing.md. Only publishPlugin
        // reads it, so every other task runs without one.
        token = providers.environmentVariable("JETBRAINS_TOKEN")
    }
    pluginVerification {
        ides {
            // The build target is always verified. Without the property below, so is the
            // newest release of every IDE branch after it for IntelliJ IDEA and Rider: one
            // plugin.xml serves every product, and the Marketplace verifies the full
            // matrix after an upload. recommended() would add every EAP branch as well,
            // and each IDE is 1.2 GB to download and 3.5 GB unpacked, so a laptop short
            // of disk runs `./gradlew verifyPlugin -Ppacmon.verify=current`. Raise
            // sinceBuild here together with ideaVersion.sinceBuild above.
            current()
            if (providers.gradleProperty("pacmon.verify").orNull != "current") {
                select {
                    types = listOf(IntelliJPlatformType.IntellijIdeaCommunity)
                    channels = listOf(ProductRelease.Channel.RELEASE)
                    sinceBuild = "253"
                }
                select {
                    types = listOf(IntelliJPlatformType.Rider)
                    channels = listOf(ProductRelease.Channel.RELEASE)
                    sinceBuild = "252"
                }
                select {
                    types = listOf(IntelliJPlatformType.RubyMine)
                    channels = listOf(ProductRelease.Channel.RELEASE)
                    sinceBuild = "252"
                }
                select {
                    types = listOf(IntelliJPlatformType.PhpStorm)
                    channels = listOf(ProductRelease.Channel.RELEASE)
                    sinceBuild = "252"
                }
                select {
                    types = listOf(IntelliJPlatformType.CLion)
                    channels = listOf(ProductRelease.Channel.RELEASE)
                    sinceBuild = "252"
                }
            }
        }
    }
}

tasks.test {
    useJUnit()
}

tasks.processResources {
    from("../assets/AGENT-RULES.md") {
        into("pacmon")
    }
}
