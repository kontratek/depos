namespace Depos.Core.Org;

public enum DeposUrlProblem
{
    None,
    Empty,
    Invalid,
    Insecure,
}

/// <summary>An address checked: the origin, or why there is none.</summary>
public readonly record struct DeposUrl(string? Origin, DeposUrlProblem Problem)
{
    public bool Ok => Origin is not null;
}

/// <summary>
/// The address of Depos, from the "Depos address" option. A port of
/// <c>src/ext/web/serverUrl.ts</c>: only the origin is kept, and plain http is
/// allowed only for this machine.
/// </summary>
public static class DeposServerUrl
{
    /// <summary>A local Depos, until there is a public one. The same default as the other editors.</summary>
    public const string Default = "http://localhost:3000";

    private static readonly HashSet<string> LocalHosts = new(StringComparer.Ordinal) { "localhost", "127.0.0.1", "[::1]" };

    public static DeposUrl Parse(string? raw)
    {
        var value = raw?.Trim() ?? string.Empty;
        if (value.Length == 0) return new DeposUrl(null, DeposUrlProblem.Empty);
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return new DeposUrl(null, DeposUrlProblem.Invalid);
        var scheme = uri.Scheme.ToLowerInvariant();
        if (scheme != "http" && scheme != "https") return new DeposUrl(null, DeposUrlProblem.Invalid);
        if (uri.UserInfo.Length > 0) return new DeposUrl(null, DeposUrlProblem.Invalid);
        var host = uri.Host.ToLowerInvariant();
        if (host.Length == 0) return new DeposUrl(null, DeposUrlProblem.Invalid);
        if (scheme == "http" && !LocalHosts.Contains(host)) return new DeposUrl(null, DeposUrlProblem.Insecure);
        var port = uri.IsDefaultPort ? string.Empty : ":" + uri.Port;
        return new DeposUrl($"{scheme}://{host}{port}", DeposUrlProblem.None);
    }

    /// <summary><c>host[:port]</c> of an origin, for the status line.</summary>
    public static string Host(string origin)
    {
        var index = origin.IndexOf("://", StringComparison.Ordinal);
        return index < 0 ? origin : origin.Substring(index + 3);
    }
}
