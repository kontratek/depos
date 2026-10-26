using System.Net;
using Depos.Core.Org;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Depos.Core.Tests;

/// <summary>A scripted network: answers in order, requests recorded.</summary>
internal sealed class FakeHttp : IDeposHttp
{
    private readonly Queue<HttpAnswer> answers;

    public FakeHttp(params HttpAnswer[] answers) => this.answers = new Queue<HttpAnswer>(answers);

    public List<(string Method, string Url, IReadOnlyDictionary<string, string> Headers, string? Body)> Requests { get; } = new();

    public Task<HttpAnswer> SendAsync(
        string method,
        string url,
        IReadOnlyDictionary<string, string> headers,
        string? body,
        CancellationToken cancellationToken = default)
    {
        Requests.Add((method, url, headers, body));
        if (answers.Count == 0) throw new InvalidOperationException($"No answer left for {method} {url}");
        return Task.FromResult(answers.Dequeue());
    }
}

internal sealed class MemoryTokens : IDeposTokenStore
{
    public Dictionary<string, string> Tokens { get; } = new();
    public string? Read(string origin) => Tokens.TryGetValue(origin, out var token) ? token : null;

    public void Write(string origin, string? token)
    {
        if (token is null) Tokens.Remove(origin);
        else Tokens[origin] = token;
    }
}

/// <summary>The counterpart of <c>src/test/unit/webConnection.test.ts</c> and <c>DeposConnectionCoreTest.kt</c>.</summary>
[TestClass]
public sealed class DeposConnectionTests
{
    [TestMethod]
    public void AnAddressKeepsOnlyItsOrigin()
    {
        Assert.AreEqual("https://pacmon.example.com", DeposServerUrl.Parse(" https://pacmon.example.com/some/path ").Origin);
        Assert.AreEqual("http://localhost:3000", DeposServerUrl.Parse("http://localhost:3000").Origin);
        Assert.AreEqual("http://127.0.0.1:3000", DeposServerUrl.Parse("http://127.0.0.1:3000/").Origin);
        Assert.AreEqual("http://[::1]:3000", DeposServerUrl.Parse("http://[::1]:3000").Origin);
        Assert.AreEqual("https://depos.example.com:8443", DeposServerUrl.Parse("https://Depos.Example.com:8443").Origin);
        Assert.AreEqual("https://depos.example.com", DeposServerUrl.Parse("https://depos.example.com:443").Origin);
    }

    [TestMethod]
    public void PlainHttpIsOnlyForThisMachine() =>
        Assert.AreEqual(DeposUrlProblem.Insecure, DeposServerUrl.Parse("http://pacmon.example.com").Problem);

    [TestMethod]
    public void AnEmptyOrUnusableAddressIsToldApart()
    {
        Assert.AreEqual(DeposUrlProblem.Empty, DeposServerUrl.Parse(null).Problem);
        Assert.AreEqual(DeposUrlProblem.Empty, DeposServerUrl.Parse("   ").Problem);
        foreach (var value in new[] { "pacmon.example.com", "https://user:pw@pacmon.example.com", "ftp://pacmon.example.com", "https://" })
            Assert.AreEqual(DeposUrlProblem.Invalid, DeposServerUrl.Parse(value).Problem, value);
    }

    [TestMethod]
    public void TheOriginRemoteWinsOverAnEarlierOne()
    {
        var config = "[core]\r\n\tbare = false\r\n[remote \"upstream\"]\r\n\turl = git@github.com:up/stream.git\r\n"
            + "[remote \"origin\"]\r\n\turl = https://github.com/kontratek/pacmon.git\r\n\turl = https://github.com/other/one.git\r\n";
        Assert.AreEqual("https://github.com/kontratek/pacmon.git", GitRemote.RemoteUrlFromGitConfig(config));
    }

    [TestMethod]
    public void WithoutOriginTheFirstRemoteIsUsedWithoutRemotesNothing()
    {
        Assert.AreEqual("git@github.com:a/b.git", GitRemote.RemoteUrlFromGitConfig("[remote \"fork\"]\n\turl = git@github.com:a/b.git\n"));
        Assert.IsNull(GitRemote.RemoteUrlFromGitConfig("[core]\n\tbare = false\n"));
    }

    [DataTestMethod]
    [DataRow("https://github.com/kontratek/pacmon.git", "kontratek/pacmon")]
    [DataRow("https://github.com/kontratek/pacmon", "kontratek/pacmon")]
    [DataRow("https://token@github.com/kontratek/pacmon.git", "kontratek/pacmon")]
    [DataRow("git@github.com:kontratek/pacmon.git", "kontratek/pacmon")]
    [DataRow("ssh://git@github.com/kontratek/pacmon.git", "kontratek/pacmon")]
    [DataRow("ssh://git@github.com:22/kontratek/pacmon.git", "kontratek/pacmon")]
    [DataRow("https://github.com/kontratek/pacmon.web.git", "kontratek/pacmon.web")]
    [DataRow("git@github-work:kontratek/pacmon.git", "kontratek/pacmon")]
    [DataRow("git@github.com-personal:kontratek/pacmon.git", "kontratek/pacmon")]
    public void GithubRemotesMapToOwnerAndName(string url, string expected) =>
        Assert.AreEqual(expected, GitRemote.GithubFullName(url));

    [DataTestMethod]
    [DataRow("https://gitlab.com/a/b.git")]
    [DataRow("git@bitbucket.org:a/b.git")]
    [DataRow("https://github.com/a")]
    [DataRow("/home/me/repo")]
    [DataRow("C:\\repo")]
    public void OtherHostsAndPathsAreNotGithub(string url) => Assert.IsNull(GitRemote.GithubFullName(url));

    [TestMethod]
    public void AWorktreeFileLeadsToTheCommonConfig()
    {
        var temp = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "depos-git-" + Guid.NewGuid().ToString("N"))).FullName;
        try
        {
            var common = Path.Combine(temp, "main", ".git");
            var worktreeGit = Path.Combine(common, "worktrees", "feature");
            Directory.CreateDirectory(worktreeGit);
            File.WriteAllText(Path.Combine(common, "config"), "[remote \"origin\"]\n\turl = git@github.com:kontratek/api.git\n");
            File.WriteAllText(Path.Combine(worktreeGit, "commondir"), "../..\n");
            var worktree = Directory.CreateDirectory(Path.Combine(temp, "feature", "src")).Parent!.FullName;
            File.WriteAllText(Path.Combine(worktree, ".git"), "gitdir: " + worktreeGit + "\n");

            Assert.AreEqual("kontratek/api", GitRemote.RepositoryOf(worktree));
            Assert.AreEqual(worktree, GitRemote.WorkTreeOf(Path.Combine(worktree, "src")));
        }
        finally
        {
            Directory.Delete(temp, recursive: true);
        }
    }

    [TestMethod]
    public void UriEncodingMatchesJavaScript()
    {
        Assert.AreEqual("kontratek%2Fapi", DeposUri.EncodeComponent("kontratek/api"));
        Assert.AreEqual("%40scope!*'()~-_.", DeposUri.EncodeComponent("@scope!*'()~-_."));
        Assert.AreEqual("%C3%BC%20x", DeposUri.EncodeComponent("ü x"));
        Assert.AreEqual(
            "ecosystem=nuget&packageName=Newtonsoft.Json+x&baseUpdatedAt=2026-10-01T10%3A00%3A00.000Z",
            DeposUri.EncodeQuery(new[]
            {
                new KeyValuePair<string, string>("ecosystem", "nuget"),
                new KeyValuePair<string, string>("packageName", "Newtonsoft.Json x"),
                new KeyValuePair<string, string>("baseUpdatedAt", "2026-10-01T10:00:00.000Z"),
            }));
    }

    [TestMethod]
    public void JsonDatesStayStrings()
    {
        var json = DeposJson.Obj(DeposJson.Parse("{\"updatedAt\":\"2026-10-01T10:00:00.000Z\"}"))!;
        Assert.AreEqual("2026-10-01T10:00:00.000Z", json.Str("updatedAt"));
        Assert.IsNull(DeposJson.Parse("{} trailing"));
        Assert.IsNull(DeposJson.Parse("not json"));
    }

    private sealed class FakeClock : IDeviceFlowClock
    {
        private readonly CancellationTokenSource? cancel;
        private readonly int cancelAfter;

        public FakeClock(CancellationTokenSource? cancel = null, int cancelAfter = int.MaxValue)
        {
            this.cancel = cancel;
            this.cancelAfter = cancelAfter;
        }

        public long Time { get; private set; }
        public List<long> Sleeps { get; } = new();
        public long Now() => Time;

        public Task DelayAsync(long milliseconds, CancellationToken cancellationToken)
        {
            Sleeps.Add(milliseconds);
            Time += milliseconds;
            if (Sleeps.Count > cancelAfter) cancel?.Cancel();
            return Task.CompletedTask;
        }
    }

    private static DeviceCode Code(long expiresIn = 600, long interval = 5) =>
        new("dev", "ABCD-EFGH", "https://d/device", "https://d/device?user_code=ABCD-EFGH", expiresIn, interval);

    [TestMethod]
    public async Task TheDeviceCodeIsAskedForWithThisExtensionsClientId()
    {
        var http = new FakeHttp(new HttpAnswer(200, "{\"device_code\":\"dev\",\"user_code\":\"ABCD-EFGH\",\"verification_uri\":\"https://d/device\",\"expires_in\":600,\"interval\":5}"));
        var code = await DeviceFlow.RequestDeviceCodeAsync(http, "https://d");
        Assert.AreEqual("https://d/api/auth/device/code", http.Requests.Single().Url);
        Assert.AreEqual("{\"client_id\":\"depos-visualstudio\"}", http.Requests.Single().Body);
        Assert.AreEqual("ABCD-EFGH", code.UserCode);
        Assert.AreEqual("https://d/device", code.VerificationUriComplete);
    }

    [TestMethod]
    public async Task ARefusedDeviceCodeSaysWhichStatus()
    {
        var http = new FakeHttp(new HttpAnswer(400, "{\"error\":\"invalid_client\"}"));
        var error = await Assert.ThrowsExceptionAsync<DeposException>(() => DeviceFlow.RequestDeviceCodeAsync(http, "https://d"));
        StringAssert.Contains(error.Message, "HTTP 400");
    }

    [TestMethod]
    public async Task PendingAndSlowDownWaitThenTheTokenComes()
    {
        var http = new FakeHttp(
            new HttpAnswer(400, "{\"error\":\"authorization_pending\"}"),
            new HttpAnswer(400, "{\"error\":\"slow_down\"}"),
            new HttpAnswer(200, "{\"access_token\":\"tok\",\"token_type\":\"Bearer\"}"));
        var clock = new FakeClock();
        var result = await DeviceFlow.PollForTokenAsync(http, "https://d", Code(), clock);
        Assert.AreEqual(new DevicePollResult(DevicePollKind.Token, "tok"), result);
        CollectionAssert.AreEqual(new long[] { 5000, 5000, 10000 }, clock.Sleeps);
        Assert.AreEqual(
            "{\"grant_type\":\"urn:ietf:params:oauth:grant-type:device_code\",\"device_code\":\"dev\",\"client_id\":\"depos-visualstudio\"}",
            http.Requests.Last().Body);
    }

    [TestMethod]
    public async Task DeniedAndExpiredEndTheWait()
    {
        var denied = new FakeHttp(new HttpAnswer(400, "{\"error\":\"access_denied\"}"));
        Assert.AreEqual(DevicePollKind.Denied, (await DeviceFlow.PollForTokenAsync(denied, "https://d", Code(), new FakeClock())).Kind);
        var expired = new FakeHttp(new HttpAnswer(400, "{\"error\":\"expired_token\"}"));
        Assert.AreEqual(DevicePollKind.Expired, (await DeviceFlow.PollForTokenAsync(expired, "https://d", Code(), new FakeClock())).Kind);
    }

    [TestMethod]
    public async Task NoRequestIsSentAtOrPastTheDeadline()
    {
        var http = new FakeHttp(Enumerable.Repeat(new HttpAnswer(400, "{\"error\":\"authorization_pending\"}"), 5).ToArray());
        Assert.AreEqual(DevicePollKind.Expired, (await DeviceFlow.PollForTokenAsync(http, "https://d", Code(expiresIn: 12), new FakeClock())).Kind);
        Assert.AreEqual(2, http.Requests.Count);
    }

    [TestMethod]
    public async Task CancelStopsBeforeTheNextRequest()
    {
        using var cancel = new CancellationTokenSource();
        var http = new FakeHttp(Enumerable.Repeat(new HttpAnswer(400, "{\"error\":\"authorization_pending\"}"), 5).ToArray());
        var result = await DeviceFlow.PollForTokenAsync(http, "https://d", Code(), new FakeClock(cancel, cancelAfter: 1), cancel.Token);
        Assert.AreEqual(DevicePollKind.Cancelled, result.Kind);
        Assert.AreEqual(1, http.Requests.Count);
    }

    [TestMethod]
    public async Task AnUnknownAnswerStopsTheSignIn()
    {
        var http = new FakeHttp(new HttpAnswer(500, "{}"));
        var error = await Assert.ThrowsExceptionAsync<DeposException>(() => DeviceFlow.PollForTokenAsync(http, "https://d", Code(), new FakeClock()));
        StringAssert.Contains(error.Message, "HTTP 500");
    }

    [TestMethod]
    public void LocalhostIsTriedAtEveryAddressTheOneThatAnsweredLastFirst()
    {
        var uri = new Uri("http://localhost:3000/api/extension/workspace?repository=kontratek%2Fapi");
        var addresses = new[] { IPAddress.Loopback, IPAddress.IPv6Loopback };
        var candidates = DeposHttpClient.LocalhostCandidates(uri, addresses, null);
        CollectionAssert.AreEqual(new[] { "127.0.0.1", "[::1]" }, candidates.Select(item => item.Literal).ToArray());
        Assert.AreEqual("http://[::1]:3000/api/extension/workspace?repository=kontratek%2Fapi", candidates[1].Target.ToString());
        Assert.AreEqual("[::1]", DeposHttpClient.LocalhostCandidates(uri, addresses, "[::1]").First().Literal);
    }

    [TestMethod]
    public async Task A401EndsTheSignIn()
    {
        var tokens = new MemoryTokens();
        tokens.Write("https://d", "tok");
        var http = new FakeHttp(new HttpAnswer(401, "{}"));
        var connection = new DeposConnection(http, tokens, () => "https://d");
        var changes = 0;
        connection.Changed += (_, _) => changes++;

        Assert.IsInstanceOfType(await connection.FetchJsonAsync("/api/extension/session"), typeof(FetchResult.SignedOut));
        Assert.IsNull(tokens.Read("https://d"));
        Assert.AreEqual(1, changes);
        Assert.AreEqual("Bearer tok", http.Requests.Single().Headers["Authorization"]);
    }

    [TestMethod]
    public async Task ARefusedWriteCarriesTheServersMessage()
    {
        var tokens = new MemoryTokens();
        tokens.Write("https://d", "tok");
        var http = new FakeHttp(new HttpAnswer(409, "{\"message\":\"This note was changed by someone else.\"}"));
        var connection = new DeposConnection(http, tokens, () => "https://d");
        var result = await connection.SendJsonAsync("PUT", "/api/extension/organizations/o/notes", new Newtonsoft.Json.Linq.JObject());
        Assert.AreEqual(new SendResult.Status(409, "This note was changed by someone else."), result);
        Assert.AreEqual("application/json", http.Requests.Single().Headers["Content-Type"]);
    }

    [TestMethod]
    public async Task SignOutEndsTheSessionInDeposAndRemovesTheTokenEvenWhenUnreachable()
    {
        var tokens = new MemoryTokens();
        tokens.Write("https://d", "tok");
        var connection = new DeposConnection(new FakeHttp(), tokens, () => "https://d");
        Assert.IsTrue(await connection.SignOutAsync("https://d"));
        Assert.IsNull(tokens.Read("https://d"));
        Assert.IsFalse(await connection.SignOutAsync("https://d"));
    }

    [TestMethod]
    public void TheMcpSetupPointsAtTheKeyServerAndHoldsNoKey()
    {
        var json = DeposMcp.VisualStudioJson("https://depos.example.com", "01HREPO");
        var parsed = DeposJson.Obj(DeposJson.Parse(json))!;
        var server = (Newtonsoft.Json.Linq.JObject)parsed["servers"]!["depos-notes"]!;
        Assert.AreEqual("https://depos.example.com/api/mcp/repositories/01HREPO", server.Str("url"));
        Assert.AreEqual("Bearer ${input:depos-mcp-key}", ((Newtonsoft.Json.Linq.JObject)server["headers"]!).Str("Authorization"));
        Assert.AreEqual(true, ((Newtonsoft.Json.Linq.JObject)parsed["inputs"]![0]!).Bool("password"));
        StringAssert.EndsWith(json, "}\n");
        Assert.IsFalse(json.Contains("\r"));
        Assert.AreEqual("https://depos.example.com/dashboard/01HORG/settings/ai-agents", DeposMcp.KeysPage("https://depos.example.com", "01HORG"));
    }

    [TestMethod]
    public void SignedOutNothingIsAsked()
    {
        var connection = new DeposConnection(new FakeHttp(), new MemoryTokens(), () => "https://depos.example.com");
        Assert.AreEqual(new DeposStatus("depos.example.com", false, false), connection.Status());
        Assert.IsNull(connection.Credentials());
        Assert.AreEqual(new DeposStatus(null, true, false), new DeposConnection(new FakeHttp(), new MemoryTokens(), () => "http://depos.example.com").Status());
    }
}
