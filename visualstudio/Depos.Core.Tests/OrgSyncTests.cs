using Depos.Core.Org;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Newtonsoft.Json.Linq;

namespace Depos.Core.Tests;

/// <summary>
/// Org mode end to end against a scripted Depos: which folder is in org mode,
/// the local copies on disk, the delta sync and the writes. The counterpart of
/// <c>OrgModeTest.kt</c>.
/// </summary>
[TestClass]
public sealed class OrgSyncTests
{
    private const string Origin = "https://depos.example.com";
    private const string Workspace = "{\"organization\":{\"ulid\":\"01HORG\",\"name\":\"Kontra\"},\"repository\":{\"ulid\":\"01HREPO\",\"fullName\":\"kontratek/api\"}}";

    /// <summary>Answers by path, in order per path; a path with no answer left is unreachable.</summary>
    private sealed class RoutedHttp : IDeposHttp
    {
        private readonly List<(string Prefix, Queue<HttpAnswer> Answers)> routes = new();

        public List<(string Method, string Url, IReadOnlyDictionary<string, string> Headers, string? Body)> Requests { get; } = new();
        public bool Offline { get; set; }

        public RoutedHttp On(string prefix, params HttpAnswer[] answers)
        {
            routes.Add((prefix, new Queue<HttpAnswer>(answers)));
            return this;
        }

        public Task<HttpAnswer> SendAsync(string method, string url, IReadOnlyDictionary<string, string> headers, string? body, CancellationToken cancellationToken = default)
        {
            Requests.Add((method, url, headers, body));
            if (Offline) throw new System.Net.Http.HttpRequestException("offline");
            var path = url.Substring(Origin.Length);
            foreach (var (prefix, answers) in routes)
            {
                if (path.StartsWith(prefix, StringComparison.Ordinal) && answers.Count > 0) return Task.FromResult(answers.Dequeue());
            }
            throw new System.Net.Http.HttpRequestException("no answer for " + method + " " + path);
        }
    }

    private string temp = null!;
    private string repo = null!;
    private string manifest = null!;
    private MemoryTokens tokens = null!;

    [TestInitialize]
    public void SetUp()
    {
        temp = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "depos-org-" + Guid.NewGuid().ToString("N"))).FullName;
        repo = Directory.CreateDirectory(Path.Combine(temp, "api")).FullName;
        Directory.CreateDirectory(Path.Combine(repo, ".git"));
        File.WriteAllText(Path.Combine(repo, ".git", "config"), "[remote \"origin\"]\n\turl = git@github.com:kontratek/api.git\n");
        manifest = Path.Combine(repo, "src", "Api", "Api.csproj");
        tokens = new MemoryTokens();
        tokens.Write(Origin, "tok");
    }

    [TestCleanup]
    public void TearDown()
    {
        if (Directory.Exists(temp)) Directory.Delete(temp, recursive: true);
    }

    private string StoreDirectory => Path.Combine(temp, "store");

    private (OrgSync Sync, DeposConnection Connection) Create(IDeposHttp http)
    {
        var connection = new DeposConnection(http, tokens, () => Origin);
        IReadOnlyList<OrgRoot> roots = new[] { new OrgRoot("api", repo) };
        var sync = new OrgSync(connection, new OrgStore(StoreDirectory), () => Task.FromResult(roots), () => 1_000);
        return (sync, connection);
    }

    private static HttpAnswer Ok(string body, string? etag = null) =>
        new(200, body, etag is null ? null : new Dictionary<string, string> { ["etag"] = etag });

    private static string NotesPage(bool canEdit = true, string cursor = "c1") => OrgNotesTests.Sync(
        $"{{\"kind\":\"upsert\",\"note\":{OrgNotesTests.Note("u1", "Serilog", fields: "[{\"key\":\"purpose\",\"value\":\"Logging\"}]")}}}",
        canEdit: canEdit,
        cursor: cursor);

    private RoutedHttp Signed() => new RoutedHttp()
        .On("/api/extension/workspace", Ok(Workspace))
        .On("/api/extension/repositories/01HREPO/context", Ok(OrgLayerTests.Answer(), "\"e1\""))
        .On("/api/extension/organizations/01HORG/notes", Ok(NotesPage()));

    private IReadOnlyList<OrgRoot> Roots => new[] { new OrgRoot("api", repo) };

    [TestMethod]
    public async Task AFolderWhoseRepositoryIsInAnOrganizationUsesItsNotesAndAllowlist()
    {
        var http = Signed();
        var (sync, _) = Create(http);
        var changes = 0;
        sync.Changed += (_, _) => changes++;

        await sync.RefreshAllAsync(Roots);

        Assert.AreEqual(1, changes);
        Assert.AreEqual(Origin + "/api/extension/workspace?repository=kontratek%2Fapi", http.Requests[0].Url);
        var state = sync.NotesFor(manifest)!;
        Assert.AreEqual("Kontra", state.OrgName);
        Assert.IsTrue(state.CanEdit);
        var model = sync.NotesModel(manifest)!;
        Assert.AreEqual("Logging", Notes.Layers(model, Notes.FindSection(model, "serilog")!).Agent.Replace("- purpose: ", string.Empty));
        Assert.AreEqual(OrgResultKind.Denied, sync.Allowlist(manifest, "left-pad")!.Value.Result.Kind);
        Assert.AreEqual("Kontra", sync.Allowlist(manifest, "left-pad")!.Value.OrgName);
        Assert.AreEqual("https://depos.example.com/dashboard/01HORG0000000000000000000O/dependencies/nuget/serilog", sync.View(manifest, "Serilog")!.Link);
        Assert.IsNull(sync.NotesFor(Path.Combine(temp, "elsewhere", "App.csproj")));
        Assert.AreEqual(1, sync.OrgFolders(Roots).Count);
        Assert.IsTrue(File.Exists(Path.Combine(StoreDirectory, "repositories.json")));
        Assert.IsTrue(File.Exists(new OrgStore(StoreDirectory).NotesFile(Origin, "01HORG")));
    }

    [TestMethod]
    public async Task TheNextRefreshAsksOnlyForWhatChanged()
    {
        var http = Signed()
            .On("/api/extension/workspace", Ok(Workspace))
            .On("/api/extension/repositories/01HREPO/context", new HttpAnswer(304, string.Empty))
            .On("/api/extension/organizations/01HORG/notes", Ok(OrgNotesTests.Sync(string.Empty, full: false, cursor: "c2")));
        var (sync, _) = Create(http);
        await sync.RefreshAllAsync(Roots);
        var changes = 0;
        sync.Changed += (_, _) => changes++;

        await sync.RefreshAllAsync(Roots);

        Assert.AreEqual(0, changes);
        Assert.AreEqual("\"e1\"", http.Requests[4].Headers["If-None-Match"]);
        Assert.AreEqual(Origin + "/api/extension/organizations/01HORG/notes?since=c1", http.Requests[5].Url);
        Assert.IsNotNull(sync.NotesModel(manifest));
    }

    [TestMethod]
    public async Task ACursorTheServerRefusesStartsAFullCopy()
    {
        var http = Signed()
            .On("/api/extension/workspace", Ok(Workspace))
            .On("/api/extension/repositories/01HREPO/context", new HttpAnswer(304, string.Empty))
            .On("/api/extension/organizations/01HORG/notes", new HttpAnswer(400, "{}"), Ok(NotesPage(cursor: "c9")));
        var (sync, _) = Create(http);
        await sync.RefreshAllAsync(Roots);
        await sync.RefreshAllAsync(Roots);

        Assert.AreEqual(Origin + "/api/extension/organizations/01HORG/notes", http.Requests.Last().Url);
        Assert.IsNotNull(sync.NotesModel(manifest));
    }

    [TestMethod]
    public async Task ARepositoryRemovedFromDeposLeavesOrgMode()
    {
        var http = Signed().On("/api/extension/workspace", new HttpAnswer(404, "{}"));
        var (sync, _) = Create(http);
        await sync.RefreshAllAsync(Roots);
        Assert.IsNotNull(sync.NotesFor(manifest));

        await sync.RefreshAllAsync(Roots);

        Assert.IsNull(sync.NotesFor(manifest));
        Assert.AreEqual(0, new OrgStore(StoreDirectory).ReadRepositories().Count);
    }

    [TestMethod]
    public async Task OfflineAtStartTheLastCopyIsUsed()
    {
        var (first, _) = Create(Signed());
        await first.RefreshAllAsync(Roots);

        var offline = new RoutedHttp { Offline = true };
        var (second, _) = Create(offline);
        await second.RefreshAllAsync(Roots);

        Assert.AreEqual("Kontra", second.NotesFor(manifest)?.OrgName);
        Assert.AreEqual(OrgResultKind.Denied, second.Allowlist(manifest, "left-pad")?.Result.Kind);
    }

    [TestMethod]
    public async Task SignedOutNothingStays()
    {
        var (sync, _) = Create(Signed());
        await sync.RefreshAllAsync(Roots);
        tokens.Write(Origin, null);

        await sync.RefreshAllAsync(Roots);

        Assert.IsNull(sync.NotesFor(manifest));
        Assert.IsFalse(Directory.Exists(StoreDirectory));
    }

    [TestMethod]
    public async Task AnAdminSavesWithTheVersionTheyEdited()
    {
        var saved = OrgNotesTests.Note("u1", "Serilog", human: "Structured logs.");
        var http = Signed().On("/api/extension/organizations/01HORG/notes", Ok(saved));
        var (sync, _) = Create(http);
        await sync.RefreshAllAsync(Roots);

        var dropped = await sync.SaveNoteAsync(manifest, "Serilog", " Structured logs. ", "- purpose: Logging\nprose");

        Assert.AreEqual(1, dropped);
        var request = http.Requests.Last();
        Assert.AreEqual("PUT", request.Method);
        var body = (JObject)DeposJson.Parse(request.Body)!;
        Assert.AreEqual("Serilog", (string?)body["packageName"]);
        Assert.AreEqual("Structured logs.", (string?)body["humanText"]);
        Assert.AreEqual("2026-10-01T10:00:00.000Z", (string?)body["baseUpdatedAt"]);
        Assert.AreEqual("purpose", (string?)body["fields"]![0]!["key"]);
        var model = sync.NotesModel(manifest)!;
        Assert.AreEqual("Structured logs.", Notes.Layers(model, Notes.FindSection(model, "serilog")!).Human);
    }

    [TestMethod]
    public async Task EmptyLayersDeleteTheNote()
    {
        var http = Signed().On("/api/extension/organizations/01HORG/notes", new HttpAnswer(204, string.Empty));
        var (sync, _) = Create(http);
        await sync.RefreshAllAsync(Roots);

        await sync.SaveNoteAsync(manifest, "Serilog", "  ", string.Empty);

        var request = http.Requests.Last();
        Assert.AreEqual("DELETE", request.Method);
        StringAssert.EndsWith(request.Url, "/notes?ecosystem=nuget&packageName=Serilog&baseUpdatedAt=2026-10-01T10%3A00%3A00.000Z");
        Assert.IsNull(Notes.FindSection(sync.NotesModel(manifest)!, "serilog"));
    }

    [TestMethod]
    public async Task AConflictSaysWhatDeposSaid()
    {
        var http = Signed().On("/api/extension/organizations/01HORG/notes", new HttpAnswer(409, "{\"message\":\"This note was changed by someone else.\"}"));
        var (sync, _) = Create(http);
        await sync.RefreshAllAsync(Roots);

        var error = await Assert.ThrowsExceptionAsync<DeposException>(() => sync.SaveNoteAsync(manifest, "Serilog", "x", null));
        Assert.AreEqual("This note was changed by someone else.", error.Message);
    }

    [TestMethod]
    public async Task MembersReadOnly()
    {
        var http = new RoutedHttp()
            .On("/api/extension/workspace", Ok(Workspace))
            .On("/api/extension/repositories/01HREPO/context", Ok(OrgLayerTests.Answer()))
            .On("/api/extension/organizations/01HORG/notes", Ok(NotesPage(canEdit: false)));
        var (sync, _) = Create(http);
        await sync.RefreshAllAsync(Roots);

        Assert.IsFalse(sync.NotesFor(manifest)!.CanEdit);
        var error = await Assert.ThrowsExceptionAsync<DeposException>(() => sync.SaveNoteAsync(manifest, "Serilog", "x", null));
        Assert.AreEqual(DeposStrings.OrgNoteReadOnly, error.Message);
    }
}
