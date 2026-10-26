using System.IO;
using Newtonsoft.Json.Linq;

namespace Depos.Core.Org;

/// <summary>A folder of the solution: the git work tree of the solution or of one of its projects.</summary>
public readonly record struct OrgRoot(string Name, string Path);

/// <summary>A folder in org mode, with what its notes from Depos say about the user.</summary>
public sealed record OrgNotesState(string Origin, string RepoUlid, string OrgUlid, string OrgName, bool CanEdit);

/// <summary>A folder in org mode, for the MCP setup of its repository.</summary>
public sealed record OrgFolder(string Name, string Origin, string RepoUlid, string OrgUlid, string? RepoFullName);

/// <summary>
/// Org mode of each folder (docs/format.md, "The organization layer"). A port of
/// <c>src/ext/web/orgContext.ts</c> and the JetBrains <c>OrgContext.kt</c>:
/// <list type="bullet">
/// <item>The folder's organization: Depos matches the repository of its GitHub remote.</item>
/// <item>The allowlist layer, per repository: one request with an ETag, so an
/// unchanged layer costs a 304. Its results are looked up here, at the manifest line.</item>
/// <item>The notes, per organization: a local copy kept current by a delta sync.
/// A folder whose copy is loaded is in org mode: its notes come from the copy,
/// through a read-only notes text per ecosystem.</item>
/// </list>
/// Fetched while signed in: at start, after sign-in, when Visual Studio gets
/// focus, every 5 minutes and on Refresh. Signing out, or a repository that is no
/// longer in an organization of the user, removes every copy.
/// </summary>
public sealed class OrgSync
{
    /// <summary>How often org data is fetched again while a solution is open.</summary>
    public static readonly TimeSpan RefreshInterval = TimeSpan.FromMinutes(5);
    /// <summary>Focusing Visual Studio refreshes, but not more often than this.</summary>
    public static readonly TimeSpan FocusMinGap = TimeSpan.FromSeconds(30);
    /// <summary>A sync stops after this many pages and goes on at the next refresh.</summary>
    public const int MaxSyncPages = 50;

    private sealed class FolderOrg
    {
        public FolderOrg(string origin, CachedRepository cached)
        {
            Origin = origin;
            RepoUlid = cached.RepoUlid;
            OrgUlid = cached.OrgUlid;
            RepoFullName = cached.RepoFullName;
            Layer = cached.Allowlist is { } allowlist ? new OrgLayer(allowlist.Data) : null;
            ReceivedAt = cached.Allowlist?.ReceivedAt ?? 0;
            Etag = cached.Allowlist?.Etag;
        }

        public string Origin { get; }
        public string RepoUlid { get; }
        public string OrgUlid { get; }
        public string? RepoFullName { get; }
        public OrgLayer? Layer { get; }
        public long ReceivedAt { get; set; }
        public string? Etag { get; }
    }

    private readonly DeposConnection connection;
    private readonly OrgStore store;
    private readonly Func<Task<IReadOnlyList<OrgRoot>>> roots;
    private readonly Func<long> clock;
    private readonly Action<string> log;
    private readonly object gate = new();
    private readonly Dictionary<string, FolderOrg> folders = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, OrgNotesCopy> copies = new(StringComparer.Ordinal);
    private readonly Dictionary<string, (string Version, NotesFileModel Model)> models = new(StringComparer.OrdinalIgnoreCase);
    private Dictionary<string, CachedRepository>? cache;
    private int running;
    private volatile bool again;
    private volatile bool disposed;
    private long lastRun;

    public OrgSync(
        DeposConnection connection,
        OrgStore store,
        Func<Task<IReadOnlyList<OrgRoot>>> roots,
        Func<long>? clock = null,
        Action<string>? log = null)
    {
        this.connection = connection;
        this.store = store;
        this.roots = roots;
        this.clock = clock ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        this.log = log ?? (_ => { });
    }

    /// <summary>What a folder shows changed: notes, allowlist, or org mode itself. Raised on a background thread.</summary>
    public event EventHandler? Changed;

    /// <summary>When the last refresh started (ms since epoch).</summary>
    public long LastRun => Interlocked.Read(ref lastRun);

    public void Dispose() => disposed = true;

    // Folders.

    public static string KeyOf(string path) => path.Replace('\\', '/').TrimEnd('/');

    /// <summary>The folder of <paramref name="filePath"/> among the folders in org mode: the deepest that holds it. Under the lock.</summary>
    private string? FolderKeyFor(string filePath)
    {
        var path = KeyOf(filePath);
        return folders.Keys
            .Where(key => string.Equals(path, key, StringComparison.OrdinalIgnoreCase)
                || path.StartsWith(key + "/", StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(key => key.Length)
            .FirstOrDefault();
    }

    private static string? EcosystemOf(string manifestPath) =>
        NugetManifest.MatchesPath(manifestPath) ? DeposEcosystems.NuGet : null;

    // Reads, from any thread.

    /// <summary>The notes state of the folder that holds <paramref name="path"/>, when that folder is in org mode.</summary>
    public OrgNotesState? NotesFor(string path)
    {
        lock (gate)
        {
            if (FolderKeyFor(path) is not { } key) return null;
            var folder = folders[key];
            if (!copies.TryGetValue(folder.OrgUlid, out var copy) || !copy.Loaded) return null;
            return new OrgNotesState(folder.Origin, folder.RepoUlid, folder.OrgUlid, copy.OrgName, copy.CanEdit);
        }
    }

    /// <summary>The notes of the manifest's ecosystem as a parsed notes file, when its folder is in org mode.</summary>
    public NotesFileModel? NotesModel(string manifestPath)
    {
        if (EcosystemOf(manifestPath) is not { } ecosystem) return null;
        lock (gate)
        {
            if (FolderKeyFor(manifestPath) is not { } key) return null;
            var folder = folders[key];
            if (!copies.TryGetValue(folder.OrgUlid, out var copy) || !copy.Loaded) return null;
            var cacheKey = key + "|" + ecosystem;
            var version = $"{folder.OrgUlid}:{copy.Version}:{folder.RepoUlid}";
            if (models.TryGetValue(cacheKey, out var cached) && cached.Version == version) return cached.Model;
            var model = Notes.Parse(copy.NotesText(ecosystem, folder.RepoUlid));
            models[cacheKey] = (version, model);
            return model;
        }
    }

    /// <summary>The notes of the manifest's ecosystem as text, for a read-only editor tab.</summary>
    public string? NotesText(string manifestPath)
    {
        if (EcosystemOf(manifestPath) is not { } ecosystem) return null;
        lock (gate)
        {
            if (FolderKeyFor(manifestPath) is not { } key) return null;
            var folder = folders[key];
            return copies.TryGetValue(folder.OrgUlid, out var copy) && copy.Loaded ? copy.NotesText(ecosystem, folder.RepoUlid) : null;
        }
    }

    /// <summary>The allowlist result of a package of the manifest, with the organization's name; null when not audited.</summary>
    public (OrgResult Result, string OrgName)? Allowlist(string manifestPath, string name)
    {
        if (EcosystemOf(manifestPath) is not { } ecosystem) return null;
        OrgLayer? layer;
        lock (gate) layer = FolderKeyFor(manifestPath) is { } key ? folders[key].Layer : null;
        if (layer?.Result(ecosystem, name, clock()) is not { } result) return null;
        return (result, layer.Data.OrgName);
    }

    /// <summary>What the hover and the note editor show of the allowlist; null when not audited.</summary>
    public OrgView? View(string manifestPath, string name)
    {
        if (EcosystemOf(manifestPath) is not { } ecosystem) return null;
        FolderOrg? folder;
        lock (gate) folder = FolderKeyFor(manifestPath) is { } key ? folders[key] : null;
        if (folder?.Layer is not { } layer) return null;
        return OrgView.Of(layer, folder.Origin, folder.ReceivedAt, ecosystem, name, FormatTime, clock());
    }

    public static string FormatTime(long epochMillis) =>
        DateTimeOffset.FromUnixTimeMilliseconds(epochMillis).ToLocalTime().ToString("HH:mm");

    /// <summary>The folders in org mode, for the MCP setup of their repositories.</summary>
    public IReadOnlyList<OrgFolder> OrgFolders(IEnumerable<OrgRoot> current)
    {
        lock (gate)
        {
            var result = new List<OrgFolder>();
            foreach (var root in current)
            {
                if (!folders.TryGetValue(KeyOf(root.Path), out var folder)) continue;
                if (!copies.TryGetValue(folder.OrgUlid, out var copy) || !copy.Loaded) continue;
                if (result.Any(item => item.RepoUlid == folder.RepoUlid)) continue;
                result.Add(new OrgFolder(root.Name, folder.Origin, folder.RepoUlid, folder.OrgUlid, folder.RepoFullName));
            }
            return result;
        }
    }

    // Writing.

    /// <summary>
    /// Save the note of a package in org mode. Empty layers delete the note. Agent
    /// lines that are not fields are left out (a note in Depos holds fields only);
    /// their count is returned so the caller can say so. Throws
    /// <see cref="DeposException"/> with a message for the user.
    /// </summary>
    public async Task<int> SaveNoteAsync(string manifestPath, string name, string human, string? agent, CancellationToken cancellationToken = default)
    {
        var ecosystem = EcosystemOf(manifestPath) ?? throw new DeposException(DeposStrings.OrgNoteNotConnected);
        FolderOrg folder;
        OrgNotesCopy copy;
        OrgNote? current;
        lock (gate)
        {
            if (FolderKeyFor(manifestPath) is not { } key
                || !copies.TryGetValue(folders[key].OrgUlid, out var found)
                || !found.Loaded)
                throw new DeposException(DeposStrings.OrgNoteNotConnected);
            folder = folders[key];
            copy = found;
            if (!copy.CanEdit) throw new DeposException(DeposStrings.OrgNoteReadOnly);
            current = copy.Note(ecosystem, name, folder.RepoUlid);
        }
        var (fields, dropped) = agent is null
            ? (current?.Fields ?? Array.Empty<OrgNoteField>(), 0)
            : OrgNotes.AgentTextToFields(agent);
        var path = $"/api/extension/organizations/{DeposUri.EncodeComponent(folder.OrgUlid)}/notes";

        if (human.Trim().Length == 0 && fields.Count == 0)
        {
            if (current is null) return dropped;
            var query = DeposUri.EncodeQuery(new[]
            {
                new KeyValuePair<string, string>("ecosystem", ecosystem),
                new KeyValuePair<string, string>("packageName", current.DisplayName),
                new KeyValuePair<string, string>("baseUpdatedAt", current.UpdatedAt),
            });
            AfterWrite(await connection.SendJsonAsync("DELETE", path + "?" + query, null, cancellationToken).ConfigureAwait(false));
            lock (gate) copy.Remove(current.Ecosystem, current.NoteKey);
        }
        else
        {
            var body = new JObject
            {
                ["ecosystem"] = ecosystem,
                ["packageName"] = current?.DisplayName ?? name,
                ["humanText"] = human.Trim(),
                ["fields"] = OrgNotes.FieldsJson(fields),
                ["baseUpdatedAt"] = current is null ? JValue.CreateNull() : new JValue(current.UpdatedAt),
            };
            var result = await connection.SendJsonAsync("PUT", path, body, cancellationToken).ConfigureAwait(false);
            AfterWrite(result);
            var saved = (result as SendResult.Ok)?.Body is { } savedJson ? OrgNotes.ParseNote(savedJson) : null;
            if (saved is null) throw new DeposException(DeposStrings.OrgNoteSaveFailed);
            lock (gate) copy.Put(saved);
        }
        Persist(folder.Origin, copy);
        FireChanged();
        return dropped;
    }

    private void AfterWrite(SendResult result)
    {
        switch (result)
        {
            case SendResult.Ok:
                return;
            case SendResult.SignedOut:
                throw new DeposException(DeposStrings.WebSessionExpired);
            case SendResult.Status status:
                // Someone else changed the note: bring the copy up to date before the user retries.
                if (status.Code == 409) Refresh();
                throw new DeposException(status.Message ?? DeposStrings.OrgNoteSaveFailed);
        }
    }

    // Fetching.

    /// <summary>Fetch every folder again, on a background thread. A call while one runs makes it run once more.</summary>
    public void Refresh()
    {
        if (disposed) return;
        if (Interlocked.CompareExchange(ref running, 1, 0) != 0)
        {
            again = true;
            return;
        }
        _ = Task.Run(async () =>
        {
            try
            {
                do
                {
                    again = false;
                    await RefreshAllAsync(await roots().ConfigureAwait(false)).ConfigureAwait(false);
                }
                while (again && !disposed);
            }
            catch (Exception error)
            {
                log("depos: org refresh failed: " + error.Message);
            }
            finally
            {
                Volatile.Write(ref running, 0);
            }
            // Asked for between the last check and the release above.
            if (again && !disposed) Refresh();
        });
    }

    /// <summary>One refresh of <paramref name="current"/>, awaited. <see cref="Refresh"/> runs it in the background.</summary>
    public async Task RefreshAllAsync(IReadOnlyList<OrgRoot> current, CancellationToken cancellationToken = default)
    {
        Interlocked.Exchange(ref lastRun, clock());
        try
        {
            var credentials = connection.Credentials();
            if (credentials is null)
            {
                ClearAll();
                return;
            }
            var changed = false;
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var orgs = new List<string>();
            foreach (var root in current)
            {
                var key = KeyOf(root.Path);
                if (!seen.Add(key)) continue;
                changed = await RefreshFolderAsync(root, key, credentials.Origin, cancellationToken).ConfigureAwait(false) || changed;
                string? orgUlid;
                lock (gate) orgUlid = folders.TryGetValue(key, out var folder) ? folder.OrgUlid : null;
                if (orgUlid is not null && !orgs.Contains(orgUlid)) orgs.Add(orgUlid);
            }
            lock (gate)
            {
                foreach (var key in folders.Keys.ToArray())
                {
                    if (seen.Contains(key)) continue;
                    folders.Remove(key);
                    changed = true;
                }
            }
            foreach (var orgUlid in orgs)
                changed = await SyncNotesAsync(credentials.Origin, orgUlid, cancellationToken).ConfigureAwait(false) || changed;
            if (changed) FireChanged();
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            log("depos: org refresh failed: " + error.Message);
        }
    }

    /// <summary>
    /// Which organization the folder's repository is in, asked on every refresh: a
    /// repository removed from Depos, or a user removed from the organization,
    /// leaves org mode. True when what the folder shows changed.
    /// </summary>
    private async Task<bool> RefreshFolderAsync(OrgRoot root, string key, string origin, CancellationToken cancellationToken)
    {
        var repo = GitRemote.RepositoryOf(root.Path);
        if (repo is null)
        {
            lock (gate) return folders.Remove(key);
        }
        var cacheKey = origin + "|" + repo.ToLowerInvariant();
        var cached = Cached(cacheKey);
        var changed = false;
        // Offline at start: use the last copies at once; the request below confirms them.
        bool shown;
        lock (gate) shown = folders.ContainsKey(key);
        if (cached is not null && !shown)
        {
            changed = Show(key, origin, cached);
            changed = LoadCopy(origin, cached.OrgUlid) || changed;
        }

        try
        {
            var found = await connection.FetchJsonAsync("/api/extension/workspace?repository=" + DeposUri.EncodeComponent(repo), null, cancellationToken)
                .ConfigureAwait(false);
            switch (found)
            {
                case FetchResult.Status { Code: 404 }:
                    return Forget(key, cacheKey) || changed;
                case FetchResult.Status status:
                    log($"depos: workspace lookup for {root.Name} answered HTTP {status.Code}");
                    return changed;
                case FetchResult.Ok ok:
                    var body = DeposJson.Obj(ok.Body);
                    var repository = body?["repository"] as JObject;
                    var organization = body?["organization"] as JObject;
                    var repoUlid = repository?.Str("ulid");
                    var orgUlid = organization?.Str("ulid");
                    if (repoUlid is null || orgUlid is null) return changed;
                    var fullName = repository!.Str("fullName");
                    // The allowlist layer belongs to the repository: a new one starts without it.
                    var next = cached is not null && cached.RepoUlid == repoUlid && cached.OrgUlid == orgUlid
                        ? cached with { RepoFullName = fullName ?? cached.RepoFullName }
                        : new CachedRepository(repoUlid, orgUlid, fullName);
                    if (next != cached) PutCached(cacheKey, next);
                    changed = Show(key, origin, next) || changed;
                    changed = LoadCopy(origin, orgUlid) || changed;
                    return await RefreshAllowlistAsync(root, key, cacheKey, origin, next, cancellationToken).ConfigureAwait(false) || changed;
                default:
                    return changed;
            }
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // Offline or the server is down: the last copies stay, with their times.
            log($"depos: fetch for {root.Name} failed: {error.Message}");
            return changed;
        }
    }

    /// <summary>The repository's allowlist layer, asked with the last ETag. True when what the folder shows changed.</summary>
    private async Task<bool> RefreshAllowlistAsync(
        OrgRoot root,
        string key,
        string cacheKey,
        string origin,
        CachedRepository cached,
        CancellationToken cancellationToken)
    {
        var answer = await connection.FetchJsonAsync(
            $"/api/extension/repositories/{DeposUri.EncodeComponent(cached.RepoUlid)}/context",
            cached.Allowlist?.Etag,
            cancellationToken).ConfigureAwait(false);
        switch (answer)
        {
            case FetchResult.Unchanged:
                if (cached.Allowlist is null) return false;
                var touched = cached with { Allowlist = cached.Allowlist with { ReceivedAt = clock() } };
                PutCached(cacheKey, touched);
                return Show(key, origin, touched);
            case FetchResult.Status { Code: 404 }:
                // The repository left Depos, or the user left the organization: nothing of it stays.
                return Forget(key, cacheKey);
            case FetchResult.Status status:
                log($"depos: allowlist layer for {root.Name} answered HTTP {status.Code}");
                return false;
            case FetchResult.Ok ok:
                if (ok.Body is not { } raw || OrgLayers.Parse(raw) is not { } data)
                {
                    log($"depos: unexpected allowlist answer for {root.Name}");
                    return false;
                }
                var next = cached with { Allowlist = new CachedAllowlist(raw, data, ok.Etag, clock()) };
                PutCached(cacheKey, next);
                return Show(key, origin, next);
            default:
                return false;
        }
    }

    /// <summary>Bring the notes copy up to date, page by page. True when anything changed.</summary>
    private async Task<bool> SyncNotesAsync(string origin, string orgUlid, CancellationToken cancellationToken)
    {
        LoadCopy(origin, orgUlid);
        OrgNotesCopy copy;
        lock (gate)
        {
            if (!copies.TryGetValue(orgUlid, out copy!))
            {
                copy = new OrgNotesCopy(orgUlid);
                copies[orgUlid] = copy;
            }
        }
        var changed = false;
        try
        {
            for (var page = 0; page < MaxSyncPages; page++)
            {
                string cursor;
                lock (gate) cursor = copy.Cursor;
                var since = cursor.Length > 0 ? "?since=" + DeposUri.EncodeComponent(cursor) : string.Empty;
                var answer = await connection.FetchJsonAsync($"/api/extension/organizations/{DeposUri.EncodeComponent(orgUlid)}/notes{since}", null, cancellationToken)
                    .ConfigureAwait(false);
                switch (answer)
                {
                    case FetchResult.SignedOut:
                    case FetchResult.Unchanged:
                        return changed;
                    case FetchResult.Status { Code: 404 }:
                        return ForgetOrg(origin, orgUlid) || changed;
                    case FetchResult.Status { Code: 400 } when cursor.Length > 0:
                        // A cursor the server no longer accepts: start over with a full copy.
                        lock (gate) copy.Cursor = string.Empty;
                        continue;
                    case FetchResult.Status status:
                        log($"depos: notes sync answered HTTP {status.Code}");
                        return changed;
                    case FetchResult.Ok ok:
                        if (OrgNotes.ParseSync(ok.Body) is not { } sync)
                        {
                            log("depos: unexpected notes answer");
                            return changed;
                        }
                        lock (gate)
                        {
                            var wasLoaded = copy.Loaded;
                            changed = copy.Apply(sync, clock()) || !wasLoaded || changed;
                        }
                        if (!sync.More) page = MaxSyncPages;
                        break;
                }
            }
            Persist(origin, copy);
        }
        catch (Exception error) when (error is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            log("depos: notes sync failed: " + error.Message);
        }
        return changed;
    }

    private bool Show(string key, string origin, CachedRepository cached)
    {
        lock (gate)
        {
            var allowlist = cached.Allowlist;
            if (folders.TryGetValue(key, out var before)
                && before.Origin == origin
                && before.OrgUlid == cached.OrgUlid
                && before.RepoUlid == cached.RepoUlid)
            {
                // Same ETag, same layer: only its time moves.
                var sameLayer = allowlist is not null
                    ? before.Layer is not null && allowlist.Etag is not null && before.Etag == allowlist.Etag
                    : before.Layer is null;
                if (sameLayer)
                {
                    if (allowlist is not null) before.ReceivedAt = allowlist.ReceivedAt;
                    return false;
                }
            }
            folders[key] = new FolderOrg(origin, cached);
            return true;
        }
    }

    private bool Forget(string key, string cacheKey)
    {
        PutCached(cacheKey, null);
        lock (gate) return folders.Remove(key);
    }

    private void FireChanged()
    {
        if (!disposed) Changed?.Invoke(this, EventArgs.Empty);
    }

    // The local copies.

    private CachedRepository? Cached(string cacheKey)
    {
        lock (gate)
        {
            cache ??= store.ReadRepositories();
            return cache.TryGetValue(cacheKey, out var entry) ? entry : null;
        }
    }

    private void PutCached(string cacheKey, CachedRepository? value)
    {
        Dictionary<string, CachedRepository> snapshot;
        lock (gate)
        {
            cache ??= store.ReadRepositories();
            if (value is null) cache.Remove(cacheKey);
            else cache[cacheKey] = value;
            snapshot = new Dictionary<string, CachedRepository>(cache, StringComparer.Ordinal);
        }
        try
        {
            store.WriteRepositories(snapshot);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            log("depos: could not keep the repository answers: " + error.Message);
        }
    }

    /// <summary>Read the copy from disk once per session. True when a copy appeared.</summary>
    private bool LoadCopy(string origin, string orgUlid)
    {
        lock (gate)
        {
            if (copies.ContainsKey(orgUlid)) return false;
        }
        var snapshot = store.ReadNotes(origin, orgUlid);
        if (snapshot is null || snapshot.OrgUlid != orgUlid) return false;
        lock (gate)
        {
            if (copies.ContainsKey(orgUlid)) return false;
            copies[orgUlid] = new OrgNotesCopy(orgUlid, snapshot);
            return true;
        }
    }

    private void Persist(string origin, OrgNotesCopy copy)
    {
        OrgNotesSnapshot snapshot;
        lock (gate) snapshot = copy.Snapshot();
        try
        {
            store.WriteNotes(origin, snapshot);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            log("depos: could not keep the notes: " + error.Message);
        }
    }

    /// <summary>The user left the organization: its notes and every folder of it go.</summary>
    private bool ForgetOrg(string origin, string orgUlid)
    {
        store.DeleteNotes(origin, orgUlid);
        lock (gate)
        {
            copies.Remove(orgUlid);
            var gone = folders.Where(pair => pair.Value.OrgUlid == orgUlid).Select(pair => pair.Key).ToArray();
            foreach (var key in gone) folders.Remove(key);
            return gone.Length > 0;
        }
    }

    /// <summary>Signed out: nothing of any organization stays, in memory or on disk.</summary>
    private void ClearAll()
    {
        store.Clear();
        bool had;
        lock (gate)
        {
            cache = null;
            models.Clear();
            had = folders.Count > 0 || copies.Count > 0;
            folders.Clear();
            copies.Clear();
        }
        if (had) FireChanged();
    }
}
