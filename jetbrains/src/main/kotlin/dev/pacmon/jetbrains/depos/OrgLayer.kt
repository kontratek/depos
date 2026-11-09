package dev.pacmon.jetbrains.depos

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import dev.pacmon.jetbrains.core.ManifestKind
import dev.pacmon.jetbrains.core.ManifestRegistry
import dev.pacmon.jetbrains.depos.DeposJson.bool
import dev.pacmon.jetbrains.depos.DeposJson.isNull
import dev.pacmon.jetbrains.depos.DeposJson.list
import dev.pacmon.jetbrains.depos.DeposJson.str

/**
 * The allowlist layer of one repository, as Depos sends it (docs/format.md, "The
 * organization layer"). A port of `src/ext/web/orgLayer.ts`.
 *
 * Depos decides every allowlist result. This only looks a package up: a governed
 * ecosystem lists its decided packages, every other package of it is Not listed,
 * and an ecosystem that is not listed is not audited. The same goes for the version
 * rule: Depos says which packages break it, on the versions of its last scan.
 */

enum class PolicyMode { AUDIT, ENFORCE }

data class OrgDecision(val noteKey: String, val deny: Boolean)

/** `off`, `major` or `any`; anything else, or nothing, reads as `off`. */
data class OrgPolicy(val ecosystem: String, val mode: PolicyMode, val decisions: List<OrgDecision>, val versionRule: String = "off")

data class OrgRisk(val level: String, val version: String)

/** How a package of the repository stands against its newest version, at Depos's last scan. */
data class OrgPackageVersion(
    val ecosystem: String,
    val noteKey: String,
    val installedVersion: String?,
    val latestVersion: String?,
    /** `current`, `patch`, `minor`, `major` or `ahead`; null when the two cannot be compared. */
    val updateKind: String?,
    /** Behind further than the version rule allows: a violation. */
    val outdated: Boolean,
    /** Its level is `high`, `medium`, `low` or `unknown`. */
    val risk: OrgRisk?,
)

data class OrgContextData(
    val orgUlid: String,
    val orgName: String,
    val repoUlid: String,
    val repoFullName: String,
    val dependencyPagePath: String,
    val policies: List<OrgPolicy>,
    val packages: List<OrgPackageVersion> = emptyList(),
)

data class OrgResult(val kind: Kind, val mode: PolicyMode) {
    enum class Kind { ALLOWED, DENIED, UNLISTED }

    /** A violation is shown at the manifest line: Denied or Not listed. */
    val isViolation: Boolean get() = kind != Kind.ALLOWED
}

object OrgLayers {
    private val VERSION_RULES = setOf("off", "major", "any")
    private val UPDATE_KINDS = setOf("current", "patch", "minor", "major", "ahead")
    private val RISK_LEVELS = setOf("high", "medium", "low", "unknown")

    /**
     * The answer of `GET /api/extension/repositories/<ulid>/context`, checked; null when it has another shape.
     * The version rule and the versions came later: without them, or with a value this version does not know,
     * the allowlist still shows. A package entry of another shape is left out on its own.
     */
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
                // Decisions have no reason or expiry any more. Depos still sends empty ones
                // for older releases; they are not read, and an answer without them is accepted.
                val noteKey = decision.str("noteKey") ?: return null
                val deny = when (decision.str("decision")) {
                    "allow" -> false
                    "deny" -> true
                    else -> return null
                }
                OrgDecision(noteKey, deny)
            }
            val versionRule = policy.str("versionRule")?.takeIf { it in VERSION_RULES } ?: "off"
            OrgPolicy(ecosystem, mode, decisions, versionRule)
        }
        val packages = value.list("packages")?.mapNotNull { packageVersionOf(it) }.orEmpty()
        return OrgContextData(orgUlid, orgName, repoUlid, repoFullName, pagePath, policies, packages)
    }

    /** null for a value that is missing or null; [invalid] for one of another type. */
    private fun JsonObject.optionalText(name: String, invalid: String): String? =
        if (!has(name) || isNull(name)) null else str(name) ?: invalid

    private fun packageVersionOf(item: JsonElement): OrgPackageVersion? {
        val entry = item as? JsonObject ?: return null
        val ecosystem = entry.str("ecosystem") ?: return null
        val noteKey = entry.str("noteKey") ?: return null
        val invalid = "\u0000"
        val installed = entry.optionalText("installedVersion", invalid)
        val latest = entry.optionalText("latestVersion", invalid)
        if (installed == invalid || latest == invalid) return null
        val risk = (entry.get("risk") as? JsonObject)?.let { risk ->
            val level = risk.str("level")?.takeIf { it in RISK_LEVELS }
            val version = risk.str("version")
            if (level != null && version != null) OrgRisk(level, version) else null
        }
        return OrgPackageVersion(
            ecosystem = ecosystem,
            noteKey = noteKey,
            installedVersion = installed,
            latestVersion = latest,
            updateKind = entry.str("updateKind")?.takeIf { it in UPDATE_KINDS },
            outdated = entry.bool("outdated") == true,
            risk = risk,
        )
    }

    /** `<base>/<ecosystem>/<key>`; `@scope/pkg` and Go module paths keep their slashes (a catch-all route). */
    fun dependencyPagePath(base: String, ecosystem: ManifestKind, name: String): String {
        val key = ManifestRegistry.normalizeName(name, ecosystem)
        val encoded = key.split('/').joinToString("/") { encodeUriComponent(it) }
        return "$base/${encodeUriComponent(ecosystem.id)}/$encoded"
    }
}

/**
 * Lookups by ecosystem and key. Keys are normalized the way Depos stores them, so a
 * manifest name finds its entry.
 */
class OrgLayer(val data: OrgContextData) {
    private val modes = HashMap<String, PolicyMode>()
    private val decisions = HashMap<String, OrgDecision>()
    private val versions = HashMap<String, OrgPackageVersion>()

    init {
        for (policy in data.policies) {
            modes[policy.ecosystem] = policy.mode
            for (decision in policy.decisions) decisions[DeposJson.lookupKey(policy.ecosystem, decision.noteKey)] = decision
        }
        for (version in data.packages) versions[DeposJson.lookupKey(version.ecosystem, version.noteKey)] = version
    }

    /** null: the ecosystem is not audited, nothing is shown. */
    fun result(ecosystem: ManifestKind, name: String): OrgResult? {
        val mode = modes[ecosystem.id] ?: return null
        val decision = decisions[DeposJson.lookupKey(ecosystem.id, ManifestRegistry.normalizeName(name, ecosystem))]
            ?: return OrgResult(OrgResult.Kind.UNLISTED, mode)
        val kind = if (decision.deny) OrgResult.Kind.DENIED else OrgResult.Kind.ALLOWED
        return OrgResult(kind, mode)
    }

    /** The package's versions and risk at Depos's last scan; null when Depos knows none. */
    fun version(ecosystem: ManifestKind, name: String): OrgPackageVersion? =
        versions[DeposJson.lookupKey(ecosystem.id, ManifestRegistry.normalizeName(name, ecosystem))]

    /**
     * An Allowed package that breaks the version rule: marked at its line. A Denied or
     * Not listed one is marked for that, once, as Depos counts it.
     */
    fun isOutdated(ecosystem: ManifestKind, name: String): Boolean =
        result(ecosystem, name)?.kind == OrgResult.Kind.ALLOWED && version(ecosystem, name)?.outdated == true

    /** Path of the package's page in Depos, below the server origin. */
    fun dependencyPath(ecosystem: ManifestKind, name: String): String =
        OrgLayers.dependencyPagePath(data.dependencyPagePath, ecosystem, name)
}

/** What the quick documentation and the note editor show from Depos for one package. */
data class OrgView(
    /** null when the package's ecosystem is not audited. */
    val kind: OrgResult.Kind?,
    /** "Allowed", "Denied" or "Not listed"; null when not audited. */
    val result: String?,
    val mode: String?,
    /** The installed and newest version at Depos's last scan, when Depos knows one. */
    val version: String?,
    /** Allowed, but further behind than the version rule allows. */
    val outdated: Boolean,
    val risk: String?,
    /** "High", "Medium", "Low" or "Unknown". */
    val riskLevel: String?,
    /** The package's page in Depos. */
    val link: String,
    val received: String,
) {
    /** `Allowlist: Denied (Enforce)`; null when not audited. */
    fun line(): String? = if (result != null && mode != null) DeposStrings.orgAllowlistLine(result, mode) else null

    /** The lines the quick documentation shows, in order. The note editor's badge tooltip is the same, without the time. */
    fun lines(withTime: Boolean = true): List<String> = listOfNotNull(
        line(),
        if (outdated && mode != null) DeposStrings.orgOutdatedLine(mode) else null,
        version,
        risk,
        received.takeIf { withTime },
    )

    /** The note editor's badge: the result, Outdated, or the risk level. */
    fun badgeText(): String = when {
        outdated -> DeposStrings.orgResultOutdated
        result != null -> result
        riskLevel != null -> DeposStrings.orgRiskBadge(riskLevel)
        else -> DeposStrings.orgBadgeDepos
    }

    companion object {
        /** null when Depos has nothing for the package: its ecosystem is not audited and it has no version or risk. */
        fun of(
            layer: OrgLayer,
            origin: String,
            receivedAt: Long,
            kind: ManifestKind,
            name: String,
            formatTime: (Long) -> String,
        ): OrgView? {
            val result = layer.result(kind, name)
            val version = layer.version(kind, name)
            if (result == null && version == null) return null
            val text = when (result?.kind) {
                OrgResult.Kind.ALLOWED -> DeposStrings.orgResultAllowed
                OrgResult.Kind.DENIED -> DeposStrings.orgResultDenied
                OrgResult.Kind.UNLISTED -> DeposStrings.orgResultUnlisted
                null -> null
            }
            val riskLevel = version?.risk?.let { DeposStrings.orgRiskLevel(it.level) }
            return OrgView(
                kind = result?.kind,
                result = text,
                mode = result?.let { if (it.mode == PolicyMode.ENFORCE) DeposStrings.orgModeEnforce else DeposStrings.orgModeAudit },
                version = version?.let {
                    DeposStrings.orgVersionLine(it.installedVersion, it.latestVersion, it.updateKind?.let(DeposStrings::orgBehind))
                }?.takeIf { it.isNotEmpty() },
                outdated = layer.isOutdated(kind, name),
                risk = version?.risk?.let { DeposStrings.orgRiskLine(riskLevel!!, it.version) },
                riskLevel = riskLevel,
                link = origin + layer.dependencyPath(kind, name),
                received = DeposStrings.orgReceived(formatTime(receivedAt)),
            )
        }
    }
}
