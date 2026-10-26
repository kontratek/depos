using Newtonsoft.Json.Linq;

namespace Depos.Core.Org;

/// <summary>Where the sign-in token lives: one per server origin, never logged.</summary>
public interface IDeposTokenStore
{
    string? Read(string origin);
    void Write(string origin, string? token);
}

public sealed record DeposCredentials(string Origin, string Token);

/// <summary>What a GET for org mode answered.</summary>
public abstract record FetchResult
{
    public sealed record SignedOut : FetchResult;
    public sealed record Status(string Origin, int Code) : FetchResult;
    public sealed record Unchanged(string Origin) : FetchResult;
    public sealed record Ok(string Origin, JToken? Body, string? Etag) : FetchResult;
}

/// <summary>What a write for org mode answered.</summary>
public abstract record SendResult
{
    public sealed record SignedOut : SendResult;
    public sealed record Ok(int Code, JToken? Body) : SendResult;
    public sealed record Status(int Code, string? Message) : SendResult;
}

/// <summary>The status line of the Depos group, from the address and the stored token: no request.</summary>
public readonly record struct DeposStatus(string? Host, bool Invalid, bool SignedIn);

/// <summary>A 401 while showing the connection: the sign-in has ended.</summary>
public sealed class DeposSessionEndedException : Exception
{
}

/// <summary>
/// The optional connection to Depos, the web app that holds an organization's
/// notes and allowlist. A port of <c>src/ext/web/webConnection.ts</c> and the
/// JetBrains <c>DeposConnection.kt</c>, without the user interface: Visual Studio
/// adds the browser, the progress and the messages. Signed out, nothing here
/// makes a network request.
/// </summary>
public sealed class DeposConnection
{
    private readonly IDeposTokenStore tokens;
    private readonly Func<string> address;

    public DeposConnection(IDeposHttp http, IDeposTokenStore tokens, Func<string> address)
    {
        Http = http;
        this.tokens = tokens;
        this.address = address;
    }

    /// <summary>A token was stored or removed, or the address changed: org mode is fetched again.</summary>
    public event EventHandler? Changed;

    public IDeposHttp Http { get; }

    /// <summary>The address option, checked.</summary>
    public DeposUrl Url => DeposServerUrl.Parse(address());

    /// <summary>The address option changed.</summary>
    public void AddressChanged() => Changed?.Invoke(this, EventArgs.Empty);

    public DeposStatus Status()
    {
        var url = Url;
        if (!url.Ok) return new DeposStatus(null, url.Problem != DeposUrlProblem.Empty, false);
        return new DeposStatus(DeposServerUrl.Host(url.Origin!), false, ReadToken(url.Origin!) is not null);
    }

    /// <summary>The configured origin and its token, without asking anything. null while signed out.</summary>
    public DeposCredentials? Credentials()
    {
        var url = Url;
        if (!url.Ok) return null;
        var token = ReadToken(url.Origin!);
        return token is null ? null : new DeposCredentials(url.Origin!, token);
    }

    public string? ReadToken(string origin)
    {
        var token = tokens.Read(origin);
        return string.IsNullOrEmpty(token) ? null : token;
    }

    public void StoreToken(string origin, string? token)
    {
        tokens.Write(origin, token);
        Changed?.Invoke(this, EventArgs.Empty);
    }

    private static Dictionary<string, string> AuthHeaders(string token) => new()
    {
        ["Authorization"] = "Bearer " + token,
        ["Accept"] = "application/json",
    };

    /// <summary>
    /// A GET for org mode. With <paramref name="etag"/>, an unchanged answer is a
    /// 304 and has no body. A 401 removes the token: the sign-in has ended.
    /// </summary>
    public async Task<FetchResult> FetchJsonAsync(string path, string? etag = null, CancellationToken cancellationToken = default)
    {
        var credentials = Credentials();
        if (credentials is null) return new FetchResult.SignedOut();
        var headers = AuthHeaders(credentials.Token);
        if (etag is not null) headers["If-None-Match"] = etag;
        var answer = await Http.SendAsync("GET", credentials.Origin + path, headers, null, cancellationToken).ConfigureAwait(false);
        if (answer.Status == 401)
        {
            StoreToken(credentials.Origin, null);
            return new FetchResult.SignedOut();
        }
        if (answer.Status == 304) return new FetchResult.Unchanged(credentials.Origin);
        if (!answer.Ok) return new FetchResult.Status(credentials.Origin, answer.Status);
        return new FetchResult.Ok(credentials.Origin, DeposJson.Parse(answer.Body), answer.Header("etag"));
    }

    /// <summary>
    /// A write for org mode (save or delete a note). A refused write carries the
    /// server's message, which is written for users.
    /// </summary>
    public async Task<SendResult> SendJsonAsync(string method, string path, JToken? body = null, CancellationToken cancellationToken = default)
    {
        var credentials = Credentials();
        if (credentials is null) return new SendResult.SignedOut();
        var headers = AuthHeaders(credentials.Token);
        if (body is not null) headers["Content-Type"] = "application/json";
        var answer = await Http.SendAsync(method, credentials.Origin + path, headers, body is null ? null : DeposJson.Write(body), cancellationToken)
            .ConfigureAwait(false);
        if (answer.Status == 401)
        {
            StoreToken(credentials.Origin, null);
            return new SendResult.SignedOut();
        }
        var json = DeposJson.Parse(answer.Body);
        if (answer.Ok) return new SendResult.Ok(answer.Status, json);
        var message = DeposJson.Obj(json)?.Str("message", int.MaxValue);
        if (message is not null && message.Length > 300) message = message.Substring(0, 300);
        return new SendResult.Status(answer.Status, message);
    }

    /// <summary>
    /// Ends the session on the server too, so the token stops working everywhere,
    /// then removes it here. False when there was no token.
    /// </summary>
    public async Task<bool> SignOutAsync(string origin, CancellationToken cancellationToken = default)
    {
        var token = ReadToken(origin);
        if (token is null) return false;
        try
        {
            var headers = new Dictionary<string, string> { ["Authorization"] = "Bearer " + token };
            await Http.SendAsync("POST", $"{origin}/api/extension/sign-out", headers, null, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // The local token is removed anyway; the server session then ends at its expiry.
        }
        StoreToken(origin, null);
        return true;
    }

    /// <summary>
    /// Who is signed in, and one line per folder: its organization, or why it has
    /// none. Throws <see cref="DeposSessionEndedException"/> on a 401.
    /// </summary>
    public async Task<(string Name, string Email, IReadOnlyList<string> Lines)> DescribeAsync(
        string origin,
        string token,
        IEnumerable<(string Name, string Path)> folders,
        CancellationToken cancellationToken = default)
    {
        var (status, session) = await GetAsync(origin, token, "/api/extension/session", cancellationToken).ConfigureAwait(false);
        var user = (session as JObject)?["user"] as JObject;
        var name = user?.Str("name");
        var email = user?.Str("email");
        if (name is null || email is null) throw new DeposException($"GET /api/extension/session answered HTTP {status}");
        var lines = new List<string>();
        foreach (var (folder, path) in folders)
        {
            var repo = GitRemote.RepositoryOf(path);
            if (repo is null)
            {
                lines.Add(DeposStrings.WebFolderNoRemote(folder));
                continue;
            }
            var (code, body) = await GetAsync(origin, token, "/api/extension/workspace?repository=" + DeposUri.EncodeComponent(repo), cancellationToken)
                .ConfigureAwait(false);
            var workspace = body as JObject;
            var orgName = (workspace?["organization"] as JObject)?.Str("name");
            var fullName = (workspace?["repository"] as JObject)?.Str("fullName");
            lines.Add(code == 200 && orgName is not null && fullName is not null
                ? DeposStrings.WebFolderOrg(folder, orgName, fullName)
                : DeposStrings.WebFolderNoOrg(folder, repo));
        }
        return (name, email, lines);
    }

    private async Task<(int Status, JToken? Body)> GetAsync(string origin, string token, string path, CancellationToken cancellationToken)
    {
        var answer = await Http.SendAsync("GET", origin + path, AuthHeaders(token), null, cancellationToken).ConfigureAwait(false);
        if (answer.Status == 401) throw new DeposSessionEndedException();
        return (answer.Status, answer.Ok ? DeposJson.Parse(answer.Body) : null);
    }
}
