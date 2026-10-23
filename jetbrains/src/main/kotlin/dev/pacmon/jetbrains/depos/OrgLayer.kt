package dev.pacmon.jetbrains.depos

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import dev.pacmon.jetbrains.core.ManifestKind
import dev.pacmon.jetbrains.core.ManifestRegistry
import dev.pacmon.jetbrains.depos.DeposJson.isNull
import dev.pacmon.jetbrains.depos.DeposJson.list
import dev.pacmon.jetbrains.depos.DeposJson.str
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset

/**
 * The allowlist layer of one repository, as Depos sends it (docs/format.md, "The
 * organization layer"). A port of `src/ext/web/orgLayer.ts`.
 *
 * Depos decides every allowlist result. This only looks a package up: a governed
 * ecosystem lists its decided packages, every other package of it is Not listed,
 * and an ecosystem that is not listed is not audited.
 */

enum class PolicyMode { AUDIT, ENFORCE }

data class OrgDecision(val noteKey: String, val deny: Boolean, val reason: String, val expiresAt: String?)

data class OrgPolicy(val ecosystem: String, val mode: PolicyMode, val decisions: List<OrgDecision>)

data class OrgContextData(
    val orgUlid: String,
    val orgName: String,
    val repoUlid: String,
    val repoFullName: String,
    val dependencyPagePath: String,
    val policies: List<OrgPolicy>,
)

data class OrgResult(val kind: Kind, val mode: PolicyMode, val reason: String = "", val expiresAt: String? = null) {
    enum class Kind { ALLOWED, DENIED, UNLISTED }

    /** A violation is shown at the manifest line: Denied or Not listed. */
    val isViolation: Boolean get() = kind != Kind.ALLOWED
}

object OrgLayers {
    /** The answer of `GET /api/extension/repositories/<ulid>/context`, checked; null when it has another shape. */
    fun parse(json: JsonElement?): OrgContextData? {
        val value = DeposJson.obj(json) ?: return null
        val organization = value.get("organization") as? JsonObject ?: return null
        val repository = value.get("repository") as? JsonObject ?: return null
        val orgUlid = organization.str("ulid") ?: return null
        val orgName = organization.str("name") ?: return null
        val repoUlid = repository.str("ulid") ?: return null
        val repoFullName = repository.str("fullName") ?: return null
        val pagePath = value.str("dependencyPagePath") ?: return null
        if (!pagePath.startsWith("/") || pagePath.startsWith("//")) return null
        val policies = (value.list("policies") ?: return null).map { item ->
            val policy = item as? JsonObject ?: return null
            val ecosystem = policy.str("ecosystem") ?: return null
            val mode = when (policy.str("mode")) {
                "audit" -> PolicyMode.AUDIT
                "enforce" -> PolicyMode.ENFORCE
                else -> return null
            }
            val decisions = (policy.list("decisions") ?: return null).map { raw ->
                val decision = raw as? JsonObject ?: return null
                val noteKey = decision.str("noteKey") ?: return null
                val reason = decision.str("reason", DeposJson.TEXT) ?: return null
                val deny = when (decision.str("decision")) {
                    "allow" -> false
                    "deny" -> true
                    else -> return null
                }
                val expiresAt = if (decision.isNull("expiresAt")) null else decision.str("expiresAt") ?: return null
                OrgDecision(noteKey, deny, reason, expiresAt)
            }
            OrgPolicy(ecosystem, mode, decisions)
        }
        return OrgContextData(orgUlid, orgName, repoUlid, repoFullName, pagePath, policies)
    }

    /** `<base>/<ecosystem>/<key>`; `@scope/pkg` and Go module paths keep their slashes (a catch-all route). */
    fun dependencyPagePath(base: String, ecosystem: ManifestKind, name: String): String {
        val key = ManifestRegistry.normalizeName(name, ecosystem)
        val encoded = key.split('/').joinToString("/") { encodeUriComponent(it) }
        return "$base/${encodeUriComponent(ecosystem.id)}/$encoded"
    }

    /** `Date.parse` of an ISO time or date; null when it is neither, which never expires. */
    internal fun epochMillis(value: String): Long? =
        runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
            ?: runCatching { OffsetDateTime.parse(value).toInstant().toEpochMilli() }.getOrNull()
            ?: runCatching { LocalDate.parse(value).atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli() }.getOrNull()
}

/**
 * Lookups by ecosystem and key. Keys are normalized the way Depos stores them, so a
 * manifest name finds its entry.
 */
class OrgLayer(val data: OrgContextData) {
    private val modes = HashMap<String, PolicyMode>()
    private val decisions = HashMap<String, OrgDecision>()

    init {
        for (policy in data.policies) {
            modes[policy.ecosystem] = policy.mode
            for (decision in policy.decisions) decisions[DeposJson.lookupKey(policy.ecosystem, decision.noteKey)] = decision
        }
    }

    /**
     * null: the ecosystem is not audited, nothing is shown. A decision that has expired
     * since the copy was received reads as Not listed: Depos no longer counts it.
     */
    fun result(ecosystem: ManifestKind, name: String, now: Long = System.currentTimeMillis()): OrgResult? {
        val mode = modes[ecosystem.id] ?: return null
        val decision = decisions[DeposJson.lookupKey(ecosystem.id, ManifestRegistry.normalizeName(name, ecosystem))]
        val expired = decision?.expiresAt?.let(OrgLayers::epochMillis)?.let { it <= now } == true
        if (decision == null || expired) return OrgResult(OrgResult.Kind.UNLISTED, mode)
        val kind = if (decision.deny) OrgResult.Kind.DENIED else OrgResult.Kind.ALLOWED
        return OrgResult(kind, mode, decision.reason, decision.expiresAt)
    }

    /** Path of the package's page in Depos, below the server origin. */
    fun dependencyPath(ecosystem: ManifestKind, name: String): String =
        OrgLayers.dependencyPagePath(data.dependencyPagePath, ecosystem, name)
}

/** What the quick documentation and the note editor show of the allowlist for one package. */
data class OrgView(
    val kind: OrgResult.Kind,
    /** "Allowed", "Denied" or "Not listed". */
    val result: String,
    val mode: String,
    val reason: String?,
    val expires: String?,
    /** The package's page in Depos. */
    val link: String,
    val received: String,
) {
    /** `Allowlist: Denied (Enforce)`, then the reason and the expiry when there are any. */
    fun line(): String = buildString {
        append(DeposStrings.orgAllowlistLine(result, mode))
        reason?.let { append(" — ").append(DeposStrings.orgReason(it)) }
        expires?.let { append(" · ").append(DeposStrings.orgExpires(it)) }
    }

    companion object {
        /** null when the package's ecosystem is not audited. */
        fun of(
            layer: OrgLayer,
            origin: String,
            receivedAt: Long,
            kind: ManifestKind,
            name: String,
            formatTime: (Long) -> String,
            now: Long = System.currentTimeMillis(),
        ): OrgView? {
            val result = layer.result(kind, name, now) ?: return null
            val text = when (result.kind) {
                OrgResult.Kind.ALLOWED -> DeposStrings.orgResultAllowed
                OrgResult.Kind.DENIED -> DeposStrings.orgResultDenied
                OrgResult.Kind.UNLISTED -> DeposStrings.orgResultUnlisted
            }
            val unlisted = result.kind == OrgResult.Kind.UNLISTED
            return OrgView(
                kind = result.kind,
                result = text,
                mode = if (result.mode == PolicyMode.ENFORCE) DeposStrings.orgModeEnforce else DeposStrings.orgModeAudit,
                reason = result.reason.takeIf { !unlisted && it.isNotEmpty() },
                expires = result.expiresAt?.takeIf { !unlisted }?.take(10),
                link = origin + layer.dependencyPath(kind, name),
                received = DeposStrings.orgReceived(formatTime(receivedAt)),
            )
        }
    }
}
