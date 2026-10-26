using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace Depos.Core.Org;

/// <summary>The allowlist layer as last received, with its ETag.</summary>
public sealed record CachedAllowlist(JToken Raw, OrgContextData Data, string? Etag, long ReceivedAt);

/// <summary>What Depos answered for a folder's repository, kept for a start while offline.</summary>
public sealed record CachedRepository(string RepoUlid, string OrgUlid, string? RepoFullName, CachedAllowlist? Allowlist = null);

/// <summary>
/// The local copies on disk, outside every solution: the notes belong to the
/// organization, not to a repository. <c>repositories.json</c> holds each
/// repository's organization and allowlist layer, keyed by
/// <c>origin|owner/name</c>; <c>&lt;server&gt;/org-notes/&lt;org&gt;.json</c> holds the
/// notes of one organization. Signing out removes the whole directory.
/// </summary>
public sealed class OrgStore
{
    private static readonly UTF8Encoding Utf8 = new(false);

    public OrgStore(string directory) => Directory = directory;

    public string Directory { get; }

    private string RepositoriesFile => Path.Combine(Directory, "repositories.json");

    public string NotesFile(string origin, string orgUlid) => Path.Combine(
        Directory,
        Regex.Replace(origin, "[^A-Za-z0-9.-]+", "_"),
        "org-notes",
        Regex.Replace(orgUlid, "[^A-Za-z0-9]", string.Empty) + ".json");

    public Dictionary<string, CachedRepository> ReadRepositories()
    {
        var entries = new Dictionary<string, CachedRepository>(StringComparer.Ordinal);
        if (DeposJson.Obj(DeposJson.Parse(ReadText(RepositoriesFile))) is not { } json) return entries;
        foreach (var property in json.Properties())
        {
            if (property.Value is not JObject entry) continue;
            var repoUlid = entry.Str("repoUlid");
            var orgUlid = entry.Str("orgUlid");
            if (repoUlid is null || orgUlid is null) continue;
            CachedAllowlist? allowlist = null;
            if (entry["allowlist"] is JObject raw && raw["data"] is { } data && OrgLayers.Parse(data) is { } parsed)
                allowlist = new CachedAllowlist(data, parsed, raw.Str("etag"), raw.Number("receivedAt") ?? 0);
            entries[property.Name] = new CachedRepository(repoUlid, orgUlid, entry.Str("repoFullName"), allowlist);
        }
        return entries;
    }

    public void WriteRepositories(IReadOnlyDictionary<string, CachedRepository> entries)
    {
        var json = new JObject();
        foreach (var pair in entries)
        {
            var entry = new JObject { ["repoUlid"] = pair.Value.RepoUlid, ["orgUlid"] = pair.Value.OrgUlid };
            if (pair.Value.RepoFullName is { } fullName) entry["repoFullName"] = fullName;
            if (pair.Value.Allowlist is { } allowlist)
            {
                var raw = new JObject { ["data"] = allowlist.Raw.DeepClone() };
                if (allowlist.Etag is { } etag) raw["etag"] = etag;
                raw["receivedAt"] = allowlist.ReceivedAt;
                entry["allowlist"] = raw;
            }
            json[pair.Key] = entry;
        }
        WriteText(RepositoriesFile, DeposJson.Write(json));
    }

    public OrgNotesSnapshot? ReadNotes(string origin, string orgUlid) =>
        OrgNotes.ParseSnapshot(DeposJson.Parse(ReadText(NotesFile(origin, orgUlid))));

    public void WriteNotes(string origin, OrgNotesSnapshot snapshot) =>
        WriteText(NotesFile(origin, snapshot.OrgUlid), OrgNotes.SnapshotJson(snapshot));

    public void DeleteNotes(string origin, string orgUlid)
    {
        try
        {
            File.Delete(NotesFile(origin, orgUlid));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // Already gone, or in use: the next sign-out removes it.
        }
    }

    /// <summary>Signed out: nothing of any organization stays on disk.</summary>
    public void Clear()
    {
        try
        {
            if (System.IO.Directory.Exists(Directory)) System.IO.Directory.Delete(Directory, recursive: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // A file in use stays until the next sign-out; nothing reads it while signed out.
        }
    }

    private static string? ReadText(string path)
    {
        try
        {
            return File.Exists(path) ? File.ReadAllText(path, Encoding.UTF8) : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Written beside and moved into place, so a crash never leaves half a file.</summary>
    private static void WriteText(string path, string text)
    {
        System.IO.Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, text, Utf8);
        if (File.Exists(path)) File.Replace(temporary, path, null, ignoreMetadataErrors: true);
        else File.Move(temporary, path);
    }
}
