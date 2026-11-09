using Newtonsoft.Json.Linq;

namespace Depos.Core.Org;

public enum PolicyMode
{
    Audit,
    Enforce,
}

public sealed record OrgDecision(string NoteKey, bool Deny);

/// <summary><c>VersionRule</c> is <c>off</c>, <c>major</c> or <c>any</c>; anything else, or nothing, reads as <c>off</c>.</summary>
public sealed record OrgPolicy(string Ecosystem, PolicyMode Mode, IReadOnlyList<OrgDecision> Decisions, string VersionRule = "off");

/// <summary><c>Level</c> is <c>high</c>, <c>medium</c>, <c>low</c> or <c>unknown</c>.</summary>
public sealed record OrgRisk(string Level, string Version);

/// <summary>How a package of the repository stands against its newest version, at Depos's last scan.</summary>
/// <param name="UpdateKind"><c>current</c>, <c>patch</c>, <c>minor</c>, <c>major</c> or <c>ahead</c>; null when the two cannot be compared.</param>
/// <param name="Outdated">Behind further than the version rule allows: a violation.</param>
public sealed record OrgPackageVersion(
    string Ecosystem,
    string NoteKey,
    string? InstalledVersion,
    string? LatestVersion,
    string? UpdateKind,
    bool Outdated,
    OrgRisk? Risk);

public sealed record OrgContextData(
    string OrgUlid,
    string OrgName,
    string RepoUlid,
    string RepoFullName,
    string DependencyPagePath,
    IReadOnlyList<OrgPolicy> Policies)
{
    /// <summary>Empty from a Depos before the version rule.</summary>
    public IReadOnlyList<OrgPackageVersion> Packages { get; init; } = Array.Empty<OrgPackageVersion>();
}

public enum OrgResultKind
{
    Allowed,
    Denied,
    Unlisted,
}

public sealed record OrgResult(OrgResultKind Kind, PolicyMode Mode)
{
    /// <summary>A violation is shown at the manifest line: Denied or Not listed.</summary>
    public bool IsViolation => Kind != OrgResultKind.Allowed;
}

/// <summary>
/// The allowlist layer of one repository, as Depos sends it (docs/format.md, "The
/// organization layer"). A port of <c>src/ext/web/orgLayer.ts</c>. Depos decides
/// every allowlist result, and which packages break the version rule; this only
/// looks a package up.
/// </summary>
public static class OrgLayers
{
    private static readonly HashSet<string> VersionRules = new(StringComparer.Ordinal) { "off", "major", "any" };
    private static readonly HashSet<string> UpdateKinds = new(StringComparer.Ordinal) { "current", "patch", "minor", "major", "ahead" };
    private static readonly HashSet<string> RiskLevels = new(StringComparer.Ordinal) { "high", "medium", "low", "unknown" };

    /// <summary>
    /// The answer of <c>GET /api/extension/repositories/&lt;ulid&gt;/context</c>, checked; null when it has another shape.
    /// The version rule and the versions came later: without them, or with a value this version does not know, the
    /// allowlist still shows. A package entry of another shape is left out on its own.
    /// </summary>
    public static OrgContextData? Parse(JToken? json)
    {
        if (DeposJson.Obj(json) is not { } value
            || value["organization"] is not JObject organization
            || value["repository"] is not JObject repository) return null;
        var orgUlid = organization.Str("ulid");
        var orgName = organization.Str("name");
        var repoUlid = repository.Str("ulid");
        var repoFullName = repository.Str("fullName");
        var pagePath = value.Str("dependencyPagePath");
        var rawPolicies = value.List("policies");
        if (orgUlid is null || orgName is null || repoUlid is null || repoFullName is null || pagePath is null || rawPolicies is null)
            return null;
        if (!pagePath.StartsWith("/", StringComparison.Ordinal) || pagePath.StartsWith("//", StringComparison.Ordinal)) return null;
        var policies = new List<OrgPolicy>();
        foreach (var item in rawPolicies)
        {
            if (item is not JObject policy) return null;
            var ecosystem = policy.Str("ecosystem");
            PolicyMode? mode = policy.Str("mode") switch
            {
                "audit" => PolicyMode.Audit,
                "enforce" => PolicyMode.Enforce,
                _ => null,
            };
            var rawDecisions = policy.List("decisions");
            if (ecosystem is null || mode is null || rawDecisions is null) return null;
            var decisions = new List<OrgDecision>();
            foreach (var raw in rawDecisions)
            {
                if (raw is not JObject decision) return null;
                // Decisions have no reason or expiry any more. Depos still sends empty ones
                // for older releases; they are not read, and an answer without them is accepted.
                var noteKey = decision.Str("noteKey");
                bool? deny = decision.Str("decision") switch
                {
                    "allow" => false,
                    "deny" => true,
                    _ => null,
                };
                if (noteKey is null || deny is null) return null;
                decisions.Add(new OrgDecision(noteKey, deny.Value));
            }
            var versionRule = policy.Str("versionRule") is { } rule && VersionRules.Contains(rule) ? rule : "off";
            policies.Add(new OrgPolicy(ecosystem, mode.Value, decisions, versionRule));
        }
        var packages = new List<OrgPackageVersion>();
        foreach (var raw in value.List("packages") ?? new JArray())
        {
            if (PackageVersionOf(raw) is { } package) packages.Add(package);
        }
        return new OrgContextData(orgUlid, orgName, repoUlid, repoFullName, pagePath, policies) { Packages = packages };
    }

    /// <summary>False for a value of another type; a missing or null one is null.</summary>
    private static bool TryOptionalText(JObject entry, string name, out string? text)
    {
        text = null;
        if (entry[name] is null || entry.IsNull(name)) return true;
        text = entry.Str(name);
        return text is not null;
    }

    private static OrgPackageVersion? PackageVersionOf(JToken raw)
    {
        if (raw is not JObject entry || entry.Str("ecosystem") is not { } ecosystem || entry.Str("noteKey") is not { } noteKey) return null;
        if (!TryOptionalText(entry, "installedVersion", out var installed) || !TryOptionalText(entry, "latestVersion", out var latest)) return null;
        var updateKind = entry.Str("updateKind") is { } kind && UpdateKinds.Contains(kind) ? kind : null;
        OrgRisk? risk = null;
        if (entry["risk"] is JObject rawRisk
            && rawRisk.Str("level") is { } level && RiskLevels.Contains(level)
            && rawRisk.Str("version") is { } version)
            risk = new OrgRisk(level, version);
        return new OrgPackageVersion(ecosystem, noteKey, installed, latest, updateKind, entry.Bool("outdated") == true, risk);
    }

    /// <summary><c>&lt;base&gt;/&lt;ecosystem&gt;/&lt;key&gt;</c>; a key with slashes keeps them (a catch-all route).</summary>
    public static string DependencyPagePath(string basePath, string ecosystem, string name)
    {
        var key = DeposEcosystems.NormalizeName(name, ecosystem);
        var encoded = string.Join("/", key.Split('/').Select(DeposUri.EncodeComponent));
        return $"{basePath}/{DeposUri.EncodeComponent(ecosystem)}/{encoded}";
    }
}

/// <summary>
/// Lookups by ecosystem and key. Keys are normalized the way Depos stores them,
/// so a manifest name finds its entry.
/// </summary>
public sealed class OrgLayer
{
    private readonly Dictionary<string, PolicyMode> modes = new(StringComparer.Ordinal);
    private readonly Dictionary<string, OrgDecision> decisions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, OrgPackageVersion> versions = new(StringComparer.Ordinal);

    public OrgLayer(OrgContextData data)
    {
        Data = data;
        foreach (var policy in data.Policies)
        {
            modes[policy.Ecosystem] = policy.Mode;
            foreach (var decision in policy.Decisions) decisions[DeposJson.LookupKey(policy.Ecosystem, decision.NoteKey)] = decision;
        }
        foreach (var version in data.Packages) versions[DeposJson.LookupKey(version.Ecosystem, version.NoteKey)] = version;
    }

    public OrgContextData Data { get; }

    /// <summary>null: the ecosystem is not audited, nothing is shown.</summary>
    public OrgResult? Result(string ecosystem, string name)
    {
        if (!modes.TryGetValue(ecosystem, out var mode)) return null;
        if (!decisions.TryGetValue(DeposJson.LookupKey(ecosystem, DeposEcosystems.NormalizeName(name, ecosystem)), out var decision))
            return new OrgResult(OrgResultKind.Unlisted, mode);
        return new OrgResult(decision.Deny ? OrgResultKind.Denied : OrgResultKind.Allowed, mode);
    }

    /// <summary>The package's versions and risk at Depos's last scan; null when Depos knows none.</summary>
    public OrgPackageVersion? Version(string ecosystem, string name) =>
        versions.TryGetValue(DeposJson.LookupKey(ecosystem, DeposEcosystems.NormalizeName(name, ecosystem)), out var version) ? version : null;

    /// <summary>
    /// An Allowed package that breaks the version rule: marked at its line. A Denied or
    /// Not listed one is marked for that, once, as Depos counts it.
    /// </summary>
    public bool IsOutdated(string ecosystem, string name) =>
        Result(ecosystem, name)?.Kind == OrgResultKind.Allowed && Version(ecosystem, name)?.Outdated == true;

    /// <summary>Path of the package's page in Depos, below the server origin.</summary>
    public string DependencyPath(string ecosystem, string name) => OrgLayers.DependencyPagePath(Data.DependencyPagePath, ecosystem, name);
}

/// <summary>What Quick Info and the note editor show from Depos for one package.</summary>
/// <param name="Kind">null when the package's ecosystem is not audited.</param>
/// <param name="Version">The installed and newest version at Depos's last scan, when Depos knows one.</param>
/// <param name="Outdated">Allowed, but further behind than the version rule allows.</param>
/// <param name="RiskLevel">"High", "Medium", "Low" or "Unknown".</param>
public sealed record OrgView(
    OrgResultKind? Kind,
    string? Result,
    string? Mode,
    string? Version,
    bool Outdated,
    string? Risk,
    string? RiskLevel,
    string Link,
    string Received)
{
    /// <summary><c>Allowlist: Denied (Enforce)</c>; null when not audited.</summary>
    public string? Line() => Result is not null && Mode is not null ? DeposStrings.OrgAllowlistLine(Result, Mode) : null;

    /// <summary>The lines Quick Info shows, in order, without the time.</summary>
    public IReadOnlyList<string> Lines()
    {
        var lines = new List<string>();
        if (Line() is { } line) lines.Add(line);
        if (Outdated && Mode is not null) lines.Add(DeposStrings.OrgOutdatedLine(Mode));
        if (Version is not null) lines.Add(Version);
        if (Risk is not null) lines.Add(Risk);
        return lines;
    }

    /// <summary>The badge's tooltip: the lines, one per line.</summary>
    public string Tooltip() => string.Join(Environment.NewLine, Lines());

    /// <summary>The note editor's badge: the result, Outdated, or the risk level.</summary>
    public string BadgeText() =>
        Outdated ? DeposStrings.OrgResultOutdated
        : Result ?? (RiskLevel is not null ? DeposStrings.OrgRiskBadge(RiskLevel) : DeposStrings.OrgBadgeDepos);

    /// <summary>null when Depos has nothing for the package: its ecosystem is not audited and it has no version or risk.</summary>
    public static OrgView? Of(
        OrgLayer layer,
        string origin,
        long receivedAt,
        string ecosystem,
        string name,
        Func<long, string> formatTime)
    {
        var result = layer.Result(ecosystem, name);
        var version = layer.Version(ecosystem, name);
        if (result is null && version is null) return null;
        var text = result?.Kind switch
        {
            OrgResultKind.Allowed => DeposStrings.OrgResultAllowed,
            OrgResultKind.Denied => DeposStrings.OrgResultDenied,
            OrgResultKind.Unlisted => DeposStrings.OrgResultUnlisted,
            _ => null,
        };
        var versionLine = version is null
            ? null
            : DeposStrings.OrgVersionLine(version.InstalledVersion, version.LatestVersion, version.UpdateKind is { } kind ? DeposStrings.OrgBehind(kind) : null);
        var riskLevel = version?.Risk is { } risk ? DeposStrings.OrgRiskLevel(risk.Level) : null;
        return new OrgView(
            result?.Kind,
            text,
            result is null ? null : result.Mode == PolicyMode.Enforce ? DeposStrings.OrgModeEnforce : DeposStrings.OrgModeAudit,
            string.IsNullOrEmpty(versionLine) ? null : versionLine,
            layer.IsOutdated(ecosystem, name),
            version?.Risk is { } r ? DeposStrings.OrgRiskLine(riskLevel!, r.Version) : null,
            riskLevel,
            origin + layer.DependencyPath(ecosystem, name),
            DeposStrings.OrgReceived(formatTime(receivedAt)));
    }
}
