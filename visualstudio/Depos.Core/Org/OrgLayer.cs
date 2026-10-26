using System.Globalization;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace Depos.Core.Org;

public enum PolicyMode
{
    Audit,
    Enforce,
}

public sealed record OrgDecision(string NoteKey, bool Deny, string Reason, string? ExpiresAt);

public sealed record OrgPolicy(string Ecosystem, PolicyMode Mode, IReadOnlyList<OrgDecision> Decisions);

public sealed record OrgContextData(
    string OrgUlid,
    string OrgName,
    string RepoUlid,
    string RepoFullName,
    string DependencyPagePath,
    IReadOnlyList<OrgPolicy> Policies);

public enum OrgResultKind
{
    Allowed,
    Denied,
    Unlisted,
}

public sealed record OrgResult(OrgResultKind Kind, PolicyMode Mode, string Reason = "", string? ExpiresAt = null)
{
    /// <summary>A violation is shown at the manifest line: Denied or Not listed.</summary>
    public bool IsViolation => Kind != OrgResultKind.Allowed;
}

/// <summary>
/// The allowlist layer of one repository, as Depos sends it (docs/format.md, "The
/// organization layer"). A port of <c>src/ext/web/orgLayer.ts</c>. Depos decides
/// every allowlist result; this only looks a package up.
/// </summary>
public static class OrgLayers
{
    private static readonly Regex DateOnly = new("^\\d{4}-\\d{2}-\\d{2}$");
    private static readonly Regex DateTimeWithZone = new("^\\d{4}-\\d{2}-\\d{2}T[0-9:.]+(Z|[+-]\\d{2}:\\d{2})$", RegexOptions.IgnoreCase);

    /// <summary>The answer of <c>GET /api/extension/repositories/&lt;ulid&gt;/context</c>, checked; null when it has another shape.</summary>
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
                var noteKey = decision.Str("noteKey");
                var reason = decision.Str("reason", DeposJson.Text);
                bool? deny = decision.Str("decision") switch
                {
                    "allow" => false,
                    "deny" => true,
                    _ => null,
                };
                if (noteKey is null || reason is null || deny is null) return null;
                string? expiresAt = null;
                if (!decision.IsNull("expiresAt"))
                {
                    expiresAt = decision.Str("expiresAt");
                    if (expiresAt is null) return null;
                }
                decisions.Add(new OrgDecision(noteKey, deny.Value, reason, expiresAt));
            }
            policies.Add(new OrgPolicy(ecosystem, mode.Value, decisions));
        }
        return new OrgContextData(orgUlid, orgName, repoUlid, repoFullName, pagePath, policies);
    }

    /// <summary><c>&lt;base&gt;/&lt;ecosystem&gt;/&lt;key&gt;</c>; a key with slashes keeps them (a catch-all route).</summary>
    public static string DependencyPagePath(string basePath, string ecosystem, string name)
    {
        var key = DeposEcosystems.NormalizeName(name, ecosystem);
        var encoded = string.Join("/", key.Split('/').Select(DeposUri.EncodeComponent));
        return $"{basePath}/{DeposUri.EncodeComponent(ecosystem)}/{encoded}";
    }

    /// <summary><c>Date.parse</c> of an ISO time or date; null when it is neither, which never expires.</summary>
    public static long? EpochMillis(string value)
    {
        if (DateOnly.IsMatch(value)
            && DateTime.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var date))
            return new DateTimeOffset(date, TimeSpan.Zero).ToUnixTimeMilliseconds();
        if (DateTimeWithZone.IsMatch(value)
            && DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var time))
            return time.ToUnixTimeMilliseconds();
        return null;
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

    public OrgLayer(OrgContextData data)
    {
        Data = data;
        foreach (var policy in data.Policies)
        {
            modes[policy.Ecosystem] = policy.Mode;
            foreach (var decision in policy.Decisions) decisions[DeposJson.LookupKey(policy.Ecosystem, decision.NoteKey)] = decision;
        }
    }

    public OrgContextData Data { get; }

    /// <summary>
    /// null: the ecosystem is not audited, nothing is shown. A decision that has
    /// expired since the copy was received reads as Not listed: Depos no longer
    /// counts it.
    /// </summary>
    public OrgResult? Result(string ecosystem, string name, long now)
    {
        if (!modes.TryGetValue(ecosystem, out var mode)) return null;
        decisions.TryGetValue(DeposJson.LookupKey(ecosystem, DeposEcosystems.NormalizeName(name, ecosystem)), out var decision);
        var expiry = decision?.ExpiresAt is { } expiresAt ? OrgLayers.EpochMillis(expiresAt) : null;
        if (decision is null || expiry <= now) return new OrgResult(OrgResultKind.Unlisted, mode);
        return new OrgResult(decision.Deny ? OrgResultKind.Denied : OrgResultKind.Allowed, mode, decision.Reason, decision.ExpiresAt);
    }

    /// <summary>Path of the package's page in Depos, below the server origin.</summary>
    public string DependencyPath(string ecosystem, string name) => OrgLayers.DependencyPagePath(Data.DependencyPagePath, ecosystem, name);
}

/// <summary>What the hover and the note editor show of the allowlist for one package.</summary>
public sealed record OrgView(
    OrgResultKind Kind,
    string Result,
    string Mode,
    string? Reason,
    string? Expires,
    string Link,
    string Received)
{
    /// <summary><c>Allowlist: Denied (Enforce)</c>, then the reason and the expiry when there are any.</summary>
    public string Line()
    {
        var line = DeposStrings.OrgAllowlistLine(Result, Mode);
        if (Reason is not null) line += " — " + DeposStrings.OrgReason(Reason);
        if (Expires is not null) line += " · " + DeposStrings.OrgExpires(Expires);
        return line;
    }

    /// <summary>The badge's tooltip: the line, its parts on their own.</summary>
    public string Tooltip()
    {
        var parts = new List<string> { DeposStrings.OrgAllowlistLine(Result, Mode) };
        if (Reason is not null) parts.Add(DeposStrings.OrgReason(Reason));
        if (Expires is not null) parts.Add(DeposStrings.OrgExpires(Expires));
        return string.Join(" · ", parts);
    }

    /// <summary>null when the package's ecosystem is not audited.</summary>
    public static OrgView? Of(
        OrgLayer layer,
        string origin,
        long receivedAt,
        string ecosystem,
        string name,
        Func<long, string> formatTime,
        long now)
    {
        if (layer.Result(ecosystem, name, now) is not { } result) return null;
        var text = result.Kind switch
        {
            OrgResultKind.Allowed => DeposStrings.OrgResultAllowed,
            OrgResultKind.Denied => DeposStrings.OrgResultDenied,
            _ => DeposStrings.OrgResultUnlisted,
        };
        var unlisted = result.Kind == OrgResultKind.Unlisted;
        return new OrgView(
            result.Kind,
            text,
            result.Mode == PolicyMode.Enforce ? DeposStrings.OrgModeEnforce : DeposStrings.OrgModeAudit,
            !unlisted && result.Reason.Length > 0 ? result.Reason : null,
            !unlisted && result.ExpiresAt is { } expires ? (expires.Length > 10 ? expires.Substring(0, 10) : expires) : null,
            origin + layer.DependencyPath(ecosystem, name),
            DeposStrings.OrgReceived(formatTime(receivedAt)));
    }
}
