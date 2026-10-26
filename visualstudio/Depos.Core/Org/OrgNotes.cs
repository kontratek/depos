using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace Depos.Core.Org;

/// <summary>Package names as Depos stores them, per ecosystem. The same rules as the other editors.</summary>
public static class DeposEcosystems
{
    /// <summary>The only ecosystem Visual Studio reads.</summary>
    public const string NuGet = "nuget";

    public static string NormalizeName(string name, string ecosystem)
    {
        var stripped = name.Trim();
        if (stripped.Length >= 2 && stripped[0] == stripped[stripped.Length - 1] && stripped[0] is '`' or '\'' or '"')
            stripped = stripped.Substring(1, stripped.Length - 2);
        stripped = stripped.Trim();
        return ecosystem switch
        {
            "python" => Regex.Replace(stripped.ToLowerInvariant(), "[._-]+", "-"),
            "npm" or "nuget" or "composer" or "vcpkg" or "conan" => stripped.ToLowerInvariant(),
            _ => stripped,
        };
    }
}

public sealed record OrgNoteField(string Key, string Value);

public sealed record OrgNote(
    string Ulid,
    string Ecosystem,
    string NoteKey,
    string DisplayName,
    string HumanText,
    IReadOnlyList<OrgNoteField> Fields,
    // null: every repository of the organization.
    IReadOnlyList<string>? RepositoryUlids,
    // Sent back as the version the user edited.
    string UpdatedAt,
    string? UpdatedByName)
{
    public bool Covers(string repoUlid) => RepositoryUlids is null || RepositoryUlids.Contains(repoUlid);
}

public abstract record OrgNoteChange
{
    public sealed record Upsert(OrgNote Note) : OrgNoteChange;
    public sealed record Delete(string Ulid, string Ecosystem, string NoteKey) : OrgNoteChange;
}

public sealed record OrgNotesSync(
    string OrgUlid,
    string OrgName,
    bool CanEdit,
    bool Full,
    IReadOnlyList<OrgNoteChange> Changes,
    string Cursor,
    bool More);

/// <summary>What is written to disk between sessions.</summary>
public sealed record OrgNotesSnapshot(
    string OrgUlid,
    string OrgName,
    bool CanEdit,
    string Cursor,
    // When the server last answered (ms since epoch).
    long ReceivedAt,
    IReadOnlyList<OrgNote> Notes);

/// <summary>
/// The notes of one organization, as Visual Studio keeps them on the user's
/// machine (docs/format.md, "The organization layer", org mode). A port of
/// <c>src/ext/web/orgNotes.ts</c>. Depos is the source; this is a copy filled by
/// a delta sync.
/// </summary>
public static class OrgNotes
{
    private static readonly Regex AgentField = new("^\\s*[-*]\\s+([a-z][a-z0-9_-]*)\\s*:\\s*(.*)$", RegexOptions.IgnoreCase);
    private static readonly Regex HeadingLine = new("^\\s{0,3}#");
    private static readonly Regex LineBreaks = new("[\\r\\n]+");

    /// <summary>One note as the server sends it, checked.</summary>
    public static OrgNote? ParseNote(JToken? json)
    {
        if (DeposJson.Obj(json) is not { } value) return null;
        var ulid = value.Str("ulid");
        var ecosystem = value.Str("ecosystem");
        var noteKey = value.Str("noteKey");
        var displayName = value.Str("displayName");
        var humanText = value.Str("humanText", DeposJson.Text);
        var updatedAt = value.Str("updatedAt");
        var rawFields = value.List("fields");
        if (ulid is null || ecosystem is null || noteKey is null || displayName is null
            || humanText is null || updatedAt is null || rawFields is null) return null;
        string? updatedByName = null;
        if (!value.IsNull("updatedByName"))
        {
            updatedByName = value.Str("updatedByName");
            if (updatedByName is null) return null;
        }
        var fields = new List<OrgNoteField>();
        foreach (var item in rawFields)
        {
            if (item is not JObject field) return null;
            var key = field.Str("key");
            var text = field.Str("value", DeposJson.Text);
            if (key is null || text is null) return null;
            fields.Add(new OrgNoteField(key, text));
        }
        if (value["scope"] is not JObject scope) return null;
        List<string>? repositories;
        switch (scope.Str("kind"))
        {
            case "all":
                repositories = null;
                break;
            case "repos":
                if (scope.List("repositoryUlids") is not { } ulids) return null;
                repositories = new List<string>();
                foreach (var item in ulids)
                {
                    if (DeposJson.StringOf(item) is not { } repo) return null;
                    repositories.Add(repo);
                }
                break;
            default:
                return null;
        }
        return new OrgNote(ulid, ecosystem, noteKey, displayName, humanText, fields, repositories, updatedAt, updatedByName);
    }

    /// <summary>The answer of <c>GET /api/extension/organizations/&lt;ulid&gt;/notes</c>, checked; null when it has another shape.</summary>
    public static OrgNotesSync? ParseSync(JToken? json)
    {
        if (DeposJson.Obj(json) is not { } value || value["organization"] is not JObject organization) return null;
        var orgUlid = organization.Str("ulid");
        var orgName = organization.Str("name");
        var cursor = value.Str("cursor");
        var canEdit = value.Bool("canEdit");
        var full = value.Bool("full");
        var more = value.Bool("more");
        var rawChanges = value.List("changes");
        if (orgUlid is null || orgName is null || cursor is null || canEdit is null || full is null || more is null || rawChanges is null)
            return null;
        var changes = new List<OrgNoteChange>();
        foreach (var item in rawChanges)
        {
            if (item is not JObject change) return null;
            switch (change.Str("kind"))
            {
                case "upsert":
                    if (ParseNote(change["note"]) is not { } note) return null;
                    changes.Add(new OrgNoteChange.Upsert(note));
                    break;
                case "delete":
                    var ulid = change.Str("ulid");
                    var ecosystem = change.Str("ecosystem");
                    var noteKey = change.Str("noteKey");
                    if (ulid is null || ecosystem is null || noteKey is null) return null;
                    changes.Add(new OrgNoteChange.Delete(ulid, ecosystem, noteKey));
                    break;
                default:
                    return null;
            }
        }
        return new OrgNotesSync(orgUlid, orgName, canEdit.Value, full.Value, changes, cursor, more.Value);
    }

    /// <summary>A snapshot read back from disk, checked like a server answer: the file may be old or damaged.</summary>
    public static OrgNotesSnapshot? ParseSnapshot(JToken? json)
    {
        if (DeposJson.Obj(json) is not { } value) return null;
        var orgUlid = value.Str("orgUlid");
        var orgName = value.Str("orgName");
        var cursor = value.Str("cursor");
        var canEdit = value.Bool("canEdit");
        var receivedAt = value.Number("receivedAt");
        var rawNotes = value.List("notes");
        if (orgUlid is null || orgName is null || cursor is null || canEdit is null || receivedAt is null || rawNotes is null) return null;
        var notes = new List<OrgNote>();
        foreach (var item in rawNotes)
        {
            if (ParseNote(item) is not { } note) return null;
            notes.Add(note);
        }
        return new OrgNotesSnapshot(orgUlid, orgName, canEdit.Value, cursor, receivedAt.Value, notes);
    }

    public static string SnapshotJson(OrgNotesSnapshot snapshot) => DeposJson.Write(new JObject
    {
        ["orgUlid"] = snapshot.OrgUlid,
        ["orgName"] = snapshot.OrgName,
        ["canEdit"] = snapshot.CanEdit,
        ["cursor"] = snapshot.Cursor,
        ["receivedAt"] = snapshot.ReceivedAt,
        ["notes"] = new JArray(snapshot.Notes.Select(NoteJson)),
    });

    public static JObject NoteJson(OrgNote note) => new()
    {
        ["ulid"] = note.Ulid,
        ["ecosystem"] = note.Ecosystem,
        ["noteKey"] = note.NoteKey,
        ["displayName"] = note.DisplayName,
        ["humanText"] = note.HumanText,
        ["fields"] = FieldsJson(note.Fields),
        ["scope"] = note.RepositoryUlids is null
            ? new JObject { ["kind"] = "all" }
            : new JObject { ["kind"] = "repos", ["repositoryUlids"] = new JArray(note.RepositoryUlids) },
        ["updatedAt"] = note.UpdatedAt,
        ["updatedByName"] = note.UpdatedByName is null ? JValue.CreateNull() : new JValue(note.UpdatedByName),
    };

    public static JArray FieldsJson(IEnumerable<OrgNoteField> fields) =>
        new(fields.Select(field => new JObject { ["key"] = field.Key, ["value"] = field.Value }));

    /// <summary>The agent layer of a note from Depos: one <c>- key: value</c> line per field.</summary>
    public static string FieldsToAgentText(IEnumerable<OrgNoteField> fields) =>
        string.Join("\n", fields.Select(field => $"- {field.Key}: {LineBreaks.Replace(field.Value, " ")}"));

    /// <summary>
    /// The fields of an agent layer the user wrote. A note in Depos holds fields
    /// only, so prose lines are left out; <c>Dropped</c> counts them so Visual
    /// Studio can say so.
    /// </summary>
    public static (IReadOnlyList<OrgNoteField> Fields, int Dropped) AgentTextToFields(string agent)
    {
        var fields = agent.Split('\n')
            .Select(line => AgentField.Match(line.TrimEnd('\r')))
            .Where(match => match.Success)
            .Select(match => new OrgNoteField(match.Groups[1].Value.ToLowerInvariant(), match.Groups[2].Value.Trim()))
            .ToArray();
        var nonEmpty = Regex.Split(agent, "\\r?\\n").Count(line => line.Trim().Length > 0);
        return (fields, nonEmpty - fields.Length);
    }

    /// <summary>
    /// A line of a note's human text that the notes format would read as a
    /// heading is escaped (<c>\#</c>), so the text stays inside its section.
    /// </summary>
    public static string EscapeHeadings(string text) => string.Join("\n", Regex.Split(text, "\\r?\\n").Select(line =>
    {
        if (!HeadingLine.IsMatch(line)) return line;
        var index = line.IndexOf('#');
        return line.Substring(0, index) + "\\" + line.Substring(index);
    }));

    /// <summary><c>composeSectionBody</c> of <c>src/core/serialize.ts</c>: the human layer, then the agent block.</summary>
    public static string SectionBody(string human, string agent)
    {
        var lines = new List<string>();
        var humanText = human.Trim();
        var agentText = agent.Trim();
        if (humanText.Length > 0) lines.AddRange(Regex.Split(humanText, "\\r?\\n"));
        if (agentText.Length > 0)
        {
            if (lines.Count > 0) lines.Add(string.Empty);
            lines.Add(Notes.AgentHeading);
            lines.Add(string.Empty);
            lines.AddRange(Regex.Split(agentText, "\\r?\\n"));
        }
        return string.Join("\n", lines);
    }
}

/// <summary>
/// The copy of one organization's notes. Not thread-safe on its own:
/// <see cref="OrgSync"/> guards every use with its lock.
/// </summary>
public sealed class OrgNotesCopy
{
    private readonly Dictionary<string, OrgNote> byKey = new(StringComparer.Ordinal);

    public OrgNotesCopy(string orgUlid, OrgNotesSnapshot? snapshot = null)
    {
        OrgUlid = orgUlid;
        OrgName = snapshot?.OrgName ?? string.Empty;
        CanEdit = snapshot?.CanEdit ?? false;
        Cursor = snapshot?.Cursor ?? string.Empty;
        ReceivedAt = snapshot?.ReceivedAt ?? 0;
        if (snapshot is not null)
            foreach (var note in snapshot.Notes) byKey[DeposJson.LookupKey(note.Ecosystem, note.NoteKey)] = note;
    }

    public string OrgUlid { get; }
    /// <summary>Bumped on every change: the version of the notes text built from this copy.</summary>
    public int Version { get; private set; }
    public string OrgName { get; private set; }
    public bool CanEdit { get; private set; }
    public string Cursor { get; set; }
    public long ReceivedAt { get; private set; }

    /// <summary>True once the copy has been filled from the server at least once.</summary>
    public bool Loaded => Cursor.Length > 0;

    /// <summary>Apply one page of a sync, in order. True when anything the user sees changed.</summary>
    public bool Apply(OrgNotesSync page, long now)
    {
        var changed = page.Full && byKey.Count > 0;
        if (page.Full) byKey.Clear();
        if (OrgName != page.OrgName || CanEdit != page.CanEdit) changed = true;
        OrgName = page.OrgName;
        CanEdit = page.CanEdit;
        foreach (var change in page.Changes)
        {
            switch (change)
            {
                case OrgNoteChange.Upsert upsert:
                    byKey[DeposJson.LookupKey(upsert.Note.Ecosystem, upsert.Note.NoteKey)] = upsert.Note;
                    changed = true;
                    break;
                case OrgNoteChange.Delete delete:
                    var key = DeposJson.LookupKey(delete.Ecosystem, delete.NoteKey);
                    // Only the note that was deleted: a newer note of the same package stays.
                    if (byKey.TryGetValue(key, out var existing) && existing.Ulid == delete.Ulid)
                    {
                        byKey.Remove(key);
                        changed = true;
                    }
                    break;
            }
        }
        Cursor = page.Cursor;
        ReceivedAt = now;
        if (changed) Version++;
        return changed;
    }

    /// <summary>A note the server just saved, ahead of the next sync.</summary>
    public void Put(OrgNote note)
    {
        byKey[DeposJson.LookupKey(note.Ecosystem, note.NoteKey)] = note;
        Version++;
    }

    public void Remove(string ecosystem, string noteKey)
    {
        if (byKey.Remove(DeposJson.LookupKey(ecosystem, noteKey))) Version++;
    }

    public OrgNotesSnapshot Snapshot() => new(OrgUlid, OrgName, CanEdit, Cursor, ReceivedAt, byKey.Values.ToArray());

    /// <summary>The note of a package, if its scope covers the repository.</summary>
    public OrgNote? Note(string ecosystem, string name, string repoUlid) =>
        byKey.TryGetValue(DeposJson.LookupKey(ecosystem, DeposEcosystems.NormalizeName(name, ecosystem)), out var note) && note.Covers(repoUlid)
            ? note
            : null;

    /// <summary>
    /// The notes of one ecosystem that cover a repository, as the text of a notes
    /// file. Visual Studio reads it wherever it would read DEPENDENCY-NOTES.md, so
    /// every view shows notes from Depos through the same core code.
    /// </summary>
    public string NotesText(string ecosystem, string repoUlid)
    {
        var notes = byKey.Values
            .Where(note => note.Ecosystem == ecosystem && note.Covers(repoUlid))
            .OrderBy(note => note.DisplayName, StringComparer.Ordinal);
        var lines = new List<string> { "---" };
        if (ecosystem == "npm")
        {
            lines.Add("format: dependency-notes/1");
        }
        else
        {
            lines.Add("format: " + Notes.FormatVersion);
            lines.Add("ecosystem: " + ecosystem);
        }
        lines.Add("lang: en");
        lines.Add("---");
        lines.Add(string.Empty);
        lines.Add($"<!-- Notes of {OrgName.Replace("-->", string.Empty)}, from Depos. Read-only: change them in the note editor or in Depos. -->");
        lines.Add(string.Empty);
        lines.Add(Notes.Title);
        foreach (var note in notes)
        {
            lines.Add(string.Empty);
            lines.Add("## " + Regex.Replace(note.DisplayName, "[\\r\\n]+", " ").Trim());
            lines.Add(string.Empty);
            var body = OrgNotes.SectionBody(OrgNotes.EscapeHeadings(note.HumanText), OrgNotes.FieldsToAgentText(note.Fields));
            if (body.Length > 0) lines.AddRange(body.Split('\n'));
        }
        return string.Join("\n", lines) + "\n";
    }
}
