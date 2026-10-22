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
    private val expiry = "2099-01-01T00:00:00.000Z"
    private val after = Instant.parse(expiry).toEpochMilli()

    private fun answer(policies: String = defaultPolicies, pagePath: String = "/dashboard/$org/dependencies") =
        """{"organization":{"ulid":"$org","name":"Kontra"},"repository":{"ulid":"01HREPO","fullName":"kontratek/api"},
          |"dependencyPagePath":"$pagePath","policies":$policies,"extra":true}""".trimMargin()

    private val defaultPolicies = """[{"ecosystem":"npm","mode":"enforce","decisions":[
        |{"noteKey":"express","decision":"allow","reason":"The HTTP layer.","expiresAt":"$expiry"},
        |{"noteKey":"left-pad","decision":"deny","reason":"Use String.padStart.","expiresAt":null}]},
        |{"ecosystem":"python","mode":"audit","decisions":[{"noteKey":"django-rest","decision":"allow","reason":"","expiresAt":null}]}]""".trimMargin()

    private fun layer() = OrgLayer(OrgLayers.parse(JsonParser.parseString(answer()))!!)

    @Test
    fun `the full answer is read, extra keys dropped`() {
        val data = OrgLayers.parse(JsonParser.parseString(answer()))
        assertNotNull(data)
        assertEquals("Kontra", data!!.orgName)
        assertEquals(2, data.policies.size)
    }

    @Test
    fun `an answer of another shape is refused whole`() {
        for (text in listOf("null", "[]", "\"x\"")) assertNull(text, OrgLayers.parse(JsonParser.parseString(text)))
        assertNull(OrgLayers.parse(JsonParser.parseString(answer().replace("{\"ulid\":\"$org\",\"name\":\"Kontra\"}", "null"))))
        assertNull(OrgLayers.parse(JsonParser.parseString(answer(pagePath = "https://evil.example/x"))))
        assertNull(OrgLayers.parse(JsonParser.parseString(answer(pagePath = "//evil.example/x"))))
        assertNull(OrgLayers.parse(JsonParser.parseString(answer(defaultPolicies.replace("\"enforce\"", "\"block\"")))))
        assertNull(OrgLayers.parse(JsonParser.parseString(answer(defaultPolicies.replace("\"deny\"", "\"maybe\"")))))
        val longReason = """[{"ecosystem":"npm","mode":"audit","decisions":[{"noteKey":"a","decision":"deny","reason":"${"x".repeat(100_001)}","expiresAt":null}]}]"""
        assertNull(OrgLayers.parse(JsonParser.parseString(answer(longReason))))
    }

    @Test
    fun `allowed and denied come with their mode, reason and expiry`() {
        val layer = layer()
        assertEquals(OrgResult(OrgResult.Kind.ALLOWED, PolicyMode.ENFORCE, "The HTTP layer.", expiry), layer.result(ManifestKind.NPM, "express", 0))
        val denied = layer.result(ManifestKind.NPM, "left-pad", 0)!!
        assertEquals(OrgResult.Kind.DENIED, denied.kind)
        assertTrue(denied.isViolation)
    }

    @Test
    fun `a package without a decision is not listed, and that is a violation`() {
        val result = layer().result(ManifestKind.NPM, "react", 0)
        assertEquals(OrgResult(OrgResult.Kind.UNLISTED, PolicyMode.ENFORCE), result)
        assertTrue(result!!.isViolation)
    }

    @Test
    fun `an expired decision reads as not listed from its expiry on`() {
        val layer = layer()
        assertEquals(OrgResult.Kind.ALLOWED, layer.result(ManifestKind.NPM, "express", after - 1)?.kind)
        assertEquals(OrgResult.Kind.UNLISTED, layer.result(ManifestKind.NPM, "express", after)?.kind)
        assertEquals(OrgResult.Kind.DENIED, layer.result(ManifestKind.NPM, "left-pad", Long.MAX_VALUE)?.kind)
    }

    @Test
    fun `an ecosystem that is not audited shows nothing`() {
        assertNull(layer().result(ManifestKind.CARGO, "serde", 0))
    }

    @Test
    fun `manifest names match the stored keys`() {
        val layer = layer()
        assertEquals(OrgResult.Kind.ALLOWED, layer.result(ManifestKind.NPM, "Express", 0)?.kind)
        assertEquals(OrgResult.Kind.ALLOWED, layer.result(ManifestKind.PYTHON, "Django_Rest", 0)?.kind)
        assertFalse(layer.result(ManifestKind.PYTHON, "Django_Rest", 0)!!.isViolation)
    }

    @Test
    fun `the page path keeps a scope's slash and encodes the rest`() {
        assertEquals("/dashboard/$org/dependencies/npm/%40scope/pkg", OrgLayers.dependencyPagePath("/dashboard/$org/dependencies", ManifestKind.NPM, "@scope/pkg"))
    }

    @Test
    fun `the view says what the hover and the panel show`() {
        val received = Instant.parse("2026-10-20T10:00:00Z").toEpochMilli()
        val allowed = OrgView.of(layer(), "https://depos.example.com", received, ManifestKind.NPM, "express", { "10:00" }, 0)!!
        assertEquals("The HTTP layer.", allowed.reason)
        assertEquals("2099-01-01", allowed.expires)
        assertEquals("https://depos.example.com/dashboard/$org/dependencies/npm/express", allowed.link)
        assertEquals("Updated from Depos at 10:00", allowed.received)
        assertEquals("Allowlist: Allowed (Enforce) — Reason: The HTTP layer. · Expires 2099-01-01", allowed.line())

        val unlisted = OrgView.of(layer(), "https://depos.example.com", received, ManifestKind.NPM, "react", { "10:00" }, 0)!!
        assertNull(unlisted.reason)
        assertNull(unlisted.expires)
        assertEquals("Allowlist: Not listed (Enforce)", unlisted.line())

        assertNull(OrgView.of(layer(), "https://depos.example.com", received, ManifestKind.CARGO, "serde", { "10:00" }, 0))
    }
}
