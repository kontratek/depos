using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;

namespace Depos.Core.Org;

/// <summary>One HTTP answer: status, body text and the headers Depos code reads (lower-case names).</summary>
public sealed record HttpAnswer(int Status, string Body, IReadOnlyDictionary<string, string>? Headers = null)
{
    public bool Ok => Status is >= 200 and <= 299;

    public string? Header(string name) =>
        Headers is not null && Headers.TryGetValue(name, out var value) ? value : null;
}

/// <summary>The network, as the Depos code sees it: a fake in tests, <see cref="DeposHttpClient"/> in the IDE.</summary>
public interface IDeposHttp
{
    Task<HttpAnswer> SendAsync(
        string method,
        string url,
        IReadOnlyDictionary<string, string> headers,
        string? body,
        CancellationToken cancellationToken = default);
}

/// <summary>A message for the user, from a refused sign-in or write.</summary>
public sealed class DeposException : Exception
{
    public DeposException(string message) : base(message)
    {
    }
}

/// <summary>
/// <see cref="IDeposHttp"/> over <see cref="HttpClient"/>: HTTP/1.1, a 10-second
/// timeout, and the system proxy that Visual Studio configures. <c>localhost</c>
/// is tried at each of its addresses in turn, as the JetBrains plugin does: a
/// local Depos may listen on ::1 alone, which is what Node does by default on
/// Windows.
/// </summary>
public sealed class DeposHttpClient : IDeposHttp, IDisposable
{
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);

    private readonly HttpClient client;
    private readonly string userAgent;
    private volatile string? localhostAddress;

    public DeposHttpClient(string userAgent)
    {
        this.userAgent = userAgent;
        var handler = new HttpClientHandler { UseProxy = true, AllowAutoRedirect = false };
        try
        {
            handler.DefaultProxyCredentials = CredentialCache.DefaultCredentials;
        }
        catch (PlatformNotSupportedException)
        {
            // The proxy then asks without the Windows sign-in.
        }
        client = new HttpClient(handler) { Timeout = Timeout };
    }

    public async Task<HttpAnswer> SendAsync(
        string method,
        string url,
        IReadOnlyDictionary<string, string> headers,
        string? body,
        CancellationToken cancellationToken = default)
    {
        var uri = new Uri(url);
        if (!string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase))
            return await SendToAsync(uri, method, headers, body, cancellationToken).ConfigureAwait(false);

        var addresses = await Dns.GetHostAddressesAsync("localhost").ConfigureAwait(false);
        Exception? failure = null;
        foreach (var (literal, target) in LocalhostCandidates(uri, addresses, localhostAddress))
        {
            try
            {
                var answer = await SendToAsync(target, method, headers, body, cancellationToken).ConfigureAwait(false);
                localhostAddress = literal;
                return answer;
            }
            catch (HttpRequestException error) when (IsConnectFailure(error))
            {
                failure = error;
            }
        }
        throw failure ?? new HttpRequestException("localhost has no address");
    }

    public void Dispose() => client.Dispose();

    /// <summary>
    /// <paramref name="uri"/> with its <c>localhost</c> replaced by each address,
    /// as (literal, uri) pairs, <paramref name="preferred"/> first. Path and query
    /// stay as they are.
    /// </summary>
    public static IReadOnlyList<(string Literal, Uri Target)> LocalhostCandidates(
        Uri uri,
        IEnumerable<IPAddress> addresses,
        string? preferred)
    {
        var literals = addresses
            .Select(address => address.AddressFamily == AddressFamily.InterNetworkV6
                ? "[" + address.ToString().Split('%')[0] + "]"
                : address.ToString())
            .Distinct(StringComparer.Ordinal)
            .OrderBy(literal => literal == preferred ? 0 : 1)
            .ToArray();
        var port = uri.IsDefaultPort ? string.Empty : ":" + uri.Port;
        return literals.Select(literal => (literal, new Uri($"{uri.Scheme}://{literal}{port}{uri.PathAndQuery}"))).ToArray();
    }

    private async Task<HttpAnswer> SendToAsync(
        Uri uri,
        string method,
        IReadOnlyDictionary<string, string> headers,
        string? body,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(new HttpMethod(method), uri) { Version = HttpVersion.Version11 };
        request.Headers.TryAddWithoutValidation("User-Agent", userAgent);
        string? contentType = null;
        foreach (var header in headers)
        {
            if (string.Equals(header.Key, "Content-Type", StringComparison.OrdinalIgnoreCase)) contentType = header.Value;
            else request.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }
        if (body is not null) request.Content = new StringContent(body, Encoding.UTF8, contentType ?? "application/json");
        using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var text = response.Content is null ? string.Empty : await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        var read = new Dictionary<string, string>(StringComparer.Ordinal);
        if (response.Headers.TryGetValues("ETag", out var etags)) read["etag"] = etags.First();
        return new HttpAnswer((int)response.StatusCode, text ?? string.Empty, read);
    }

    private static bool IsConnectFailure(Exception error)
    {
        for (var current = error.InnerException; current is not null; current = current.InnerException)
        {
            if (current is SocketException) return true;
            if (current is WebException { Status: WebExceptionStatus.ConnectFailure }) return true;
        }
        return false;
    }
}
