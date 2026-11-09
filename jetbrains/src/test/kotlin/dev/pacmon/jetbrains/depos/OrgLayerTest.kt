package dev.pacmon.jetbrains.depos

import com.google.gson.JsonParser
import dev.pacmon.jetbrains.core.ManifestKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** The counterpart of `src/test/unit/orgLayer.test.ts`. */
class OrgLayerTest {
    private val org = "01HORG0000000000000000000O"

    private fun answer(policies: String = defaultPolicies, pagePath: String = "/dashboard/$org/dependencies") =
        """{"organization":{"ulid":"$org","name":"Kontra"},"repository":{"ulid":"01HREPO","fullName":"kontratek/api"},
          |"dependencyPagePath":"$pagePath","policies":$policies,"extra":true}""".trimMargin()

    private val defaultPolicies = """[{"ecosystem":"npm","mode":"enforce","decisions":[
        |{"noteKey":"express","decision":"allow"},
        |{"noteKey":"left-pad","decision":"deny"}]},
        |{"ecosystem":"python","mode":"audit","decisions":[{"noteKey":"django-rest","decision":"allow"}]}]""".trimMargin()

    private fun layer() = OrgLayer(OrgLayers.parse(JsonParser.parseString(answer()))!!)

    @Test
    fun `the full answer is read, extra keys dropped`() {
        val data = OrgLayers.parse(JsonParser.parseString(answer()))
        assertNotNull(data)
        assertEquals("Kontra", data!!.orgName)
        assertEquals(2, data.policies.size)
    }

    @Test
    fun `the empty reason and expiry that Depos still sends for older releases are accepted`() {
        val old = defaultPolicies.replace("\"decision\":\"allow\"}", "\"decision\":\"allow\",\"reason\":\"\",\"expiresAt\":null}")
        val data = OrgLayers.parse(JsonParser.parseString(answer(old)))
        assertEquals(OrgLayers.parse(JsonParser.parseString(answer())), data)
    }

    @Test
    fun `an answer of another shape is refused whole`() {
        for (text in listOf("null", "[]", "\"x\"")) assertNull(text, OrgLayers.parse(JsonParser.parseString(text)))
        assertNull(OrgLayers.parse(JsonParser.parseString(answer().replace("{\"ulid\":\"$org\",\"name\":\"Kontra\"}", "null"))))
        assertNull(OrgLayers.parse(JsonParser.parseString(answer(pagePath = "https://evil.example/x"))))
        assertNull(OrgLayers.parse(JsonParser.parseString(answer(pagePath = "//evil.example/x"))))
        assertNull(OrgLayers.parse(JsonParser.parseString(answer(defaultPolicies.replace("\"enforce\"", "\"block\"")))))
        assertNull(OrgLayers.parse(JsonParser.parseString(answer(defaultPolicies.replace("\"deny\"", "\"maybe\"")))))
        val longKey = """[{"ecosystem":"npm","mode":"audit","decisions":[{"noteKey":"${"x".repeat(1_001)}","decision":"deny"}]}]"""
        assertNull(OrgLayers.parse(JsonParser.parseString(answer(longKey))))
    }

    @Test
    fun `allowed and denied come with their mode`() {
        val layer = layer()
        assertEquals(OrgResult(OrgResult.Kind.ALLOWED, PolicyMode.ENFORCE), layer.result(ManifestKind.NPM, "express"))
        val denied = layer.result(ManifestKind.NPM, "left-pad")!!
        assertEquals(OrgResult.Kind.DENIED, denied.kind)
        assertTrue(denied.isViolation)
    }

    @Test
    fun `a package without a decision is not listed, and that is a violation`() {
        val result = layer().result(ManifestKind.NPM, "react")
        assertEquals(OrgResult(OrgResult.Kind.UNLISTED, PolicyMode.ENFORCE), result)
        assertTrue(result!!.isViolation)
    }

    @Test
    fun `an ecosystem that is not audited shows nothing`() {
        assertNull(layer().result(ManifestKind.CARGO, "serde"))
    }

    @Test
    fun `manifest names match the stored keys`() {
        val layer = layer()
        assertEquals(OrgResult.Kind.ALLOWED, layer.result(ManifestKind.NPM, "Express")?.kind)
        assertEquals(OrgResult.Kind.ALLOWED, layer.result(ManifestKind.PYTHON, "Django_Rest")?.kind)
        assertFalse(layer.result(ManifestKind.PYTHON, "Django_Rest")!!.isViolation)
    }

    @Test
    fun `the page path keeps a scope's slash and encodes the rest`() {
        assertEquals("/dashboard/$org/dependencies/npm/%40scope/pkg", OrgLayers.dependencyPagePath("/dashboard/$org/dependencies", ManifestKind.NPM, "@scope/pkg"))
    }

    @Test
    fun `the view says what the hover and the panel show`() {
        val received = Instant.parse("2026-10-20T10:00:00Z").toEpochMilli()
        val allowed = OrgView.of(layer(), "https://depos.example.com", received, ManifestKind.NPM, "express", { "10:00" })!!
        assertEquals("https://depos.example.com/dashboard/$org/dependencies/npm/express", allowed.link)
        assertEquals("Updated from Depos at 10:00", allowed.received)
        assertEquals("Allowlist: Allowed (Enforce)", allowed.line())

        val unlisted = OrgView.of(layer(), "https://depos.example.com", received, ManifestKind.NPM, "react", { "10:00" })!!
        assertEquals("Allowlist: Not listed (Enforce)", unlisted.line())

        assertNull(OrgView.of(layer(), "https://depos.example.com", received, ManifestKind.CARGO, "serde", { "10:00" }))
    }

    private val packages = """[
        |{"ecosystem":"npm","noteKey":"express","installedVersion":"4.18.2","latestVersion":"5.1.0","updateKind":"major","outdated":true,"risk":{"level":"medium","version":"4.18.2"}},
        |{"ecosystem":"npm","noteKey":"left-pad","installedVersion":"1.0.0","latestVersion":"2.0.0","updateKind":"major","outdated":true,"risk":null},
        |{"ecosystem":"cargo","noteKey":"serde","installedVersion":null,"latestVersion":"1.0.200","updateKind":null,"outdated":false,"risk":{"level":"high","version":"1.0.200"}}]""".trimMargin()

    private fun versioned(): OrgLayer {
        val text = answer(defaultPolicies.replaceFirst("\"mode\":\"enforce\"", "\"mode\":\"enforce\",\"versionRule\":\"major\""))
            .replace(",\"extra\":true}", ",\"extra\":true,\"packages\":$packages}")
        return OrgLayer(OrgLayers.parse(JsonParser.parseString(text))!!)
    }

    @Test
    fun `the version rule and the versions are read, and an older answer without them still is`() {
        val data = versioned().data
        assertEquals(listOf("major", "off"), data.policies.map { it.versionRule })
        assertEquals(3, data.packages.size)
        assertEquals(emptyList<OrgPackageVersion>(), OrgLayers.parse(JsonParser.parseString(answer()))!!.packages)
    }

    @Test
    fun `a version entry or value that is not understood is left out on its own`() {
        val odd = """[{"ecosystem":"npm","noteKey":"express","installedVersion":42},
            |{"ecosystem":"npm","noteKey":"zod","installedVersion":"1.0.0","latestVersion":null,"updateKind":"sideways","outdated":"yes","risk":{"level":"severe","version":"1.0.0"}},null]""".trimMargin()
        val text = answer(defaultPolicies.replaceFirst("\"mode\":\"enforce\"", "\"mode\":\"enforce\",\"versionRule\":\"minor-only\""))
            .replace(",\"extra\":true}", ",\"packages\":$odd}")
        val data = OrgLayers.parse(JsonParser.parseString(text))!!
        assertEquals("off", data.policies[0].versionRule)
        assertEquals(listOf(OrgPackageVersion("npm", "zod", "1.0.0", null, null, false, null)), data.packages)
    }

    @Test
    fun `only an Allowed package is marked for the version rule`() {
        val layer = versioned()
        assertTrue(layer.isOutdated(ManifestKind.NPM, "Express"))
        assertFalse(layer.isOutdated(ManifestKind.NPM, "left-pad"))
        assertFalse(layer.isOutdated(ManifestKind.NPM, "react"))
    }

    @Test
    fun `the view shows the versions and the risk, in any mode`() {
        val outdated = OrgView.of(versioned(), "https://depos.example.com", 0, ManifestKind.NPM, "express", { "10:00" })!!
        assertEquals(
            listOf(
                "Allowlist: Allowed (Enforce)",
                "Version rule: not met (Enforce)",
                "Installed at last scan: 4.18.2 · Latest: 5.1.0 (a major version behind)",
                "Risk: Medium (4.18.2)",
                "Updated from Depos at 10:00",
            ),
            outdated.lines(),
        )
        assertEquals("Outdated", outdated.badgeText())

        val notAudited = OrgView.of(versioned(), "https://depos.example.com", 0, ManifestKind.CARGO, "serde", { "10:00" })!!
        assertNull(notAudited.kind)
        assertEquals(listOf("Latest: 1.0.200", "Risk: High (1.0.200)"), notAudited.lines(withTime = false))
        assertEquals("High risk", notAudited.badgeText())
    }
}
