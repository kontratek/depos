using System.Text.RegularExpressions;

namespace Depos.Core;

/// <summary>A .pacmon/ directory moved to the .depos/ beside it.</summary>
public sealed record MovedDirectory(string From, string To);

/// <summary>The directories moved, and why the next one could not move, if one could not.</summary>
public sealed record MoveOutcome(IReadOnlyList<MovedDirectory> Moved, string? Failure);

/// <summary>
/// "Move Notes to .depos/": every .pacmon/ directory of the solution — the notes'
/// directory from before Pacmon became Depos — renamed to .depos/ at once, and
/// what points into them brought along: the header comment of each notes file,
/// AGENT-RULES.md, and the pointer block of the instruction files. A port of the
/// VS Code extension's <c>src/ext/commands/moveNotes.ts</c> and the JetBrains
/// plugin's <c>MoveNotes.kt</c>; the extension asks first and handles open files.
/// </summary>
public static class MoveNotes
{
    // The same words as the VS Code extension (src/ext/strings.ts), "solution"
    // where it says "workspace".
    public const string Action = "Move Notes to .depos/";
    public const string Suggest =
        "Depos: this repository keeps its notes in .pacmon/, their directory from before Pacmon became Depos. "
        + "Move them to .depos/ once everyone working in it has updated.";
    public const string None = "Depos: no .pacmon/ directory in this solution — the notes are already in .depos/.";

    public static string Conflict(string paths) =>
        $"Depos: a .depos/ directory already exists beside {paths}. Merge the two by hand, then run Move Notes to .depos/ again.";

    public static string Confirm(int count) =>
        $"Move {(count == 1 ? "the .pacmon/ directory" : $"{count} .pacmon/ directories")} to .depos/? "
        + "Versions from before Depos read .pacmon/ only: move once everyone working here has updated.";

    public static string Done(int count) => $"Depos: moved {(count == 1 ? "1 directory" : $"{count} directories")} to .depos/.";

    public static string Failed(string path, string reason) => $"Depos: {path} could not be moved to .depos/: {reason}";

    /// <summary>The header comment of a notes file names the AGENT-RULES.md beside it (<see cref="Notes.NewFile"/>).</summary>
    private static readonly string LegacyRulesReference = "rules in " + AgentRules.RelativePath(Notes.LegacyDirectoryName);
    private static readonly string CurrentRulesReference = "rules in " + AgentRules.RelativePath(Notes.DirectoryName);

    private static readonly Regex PointerMarker = new("<!-- (?:depos|pacmon):", RegexOptions.Compiled);

    /// <summary>Where a .pacmon/ directory goes: the .depos/ beside it.</summary>
    public static string TargetOf(string legacyDirectory) =>
        Path.Combine(Path.GetDirectoryName(legacyDirectory)!, Notes.DirectoryName);

    /// <summary>
    /// The directories that cannot move: a .depos/ is already beside them, and
    /// merging the two is left to a person.
    /// </summary>
    public static IReadOnlyList<string> Conflicts(IEnumerable<string> legacy) => legacy
        .Where(directory => Directory.Exists(TargetOf(directory)) || File.Exists(TargetOf(directory)))
        .ToArray();

    /// <summary>
    /// Moves each of <paramref name="legacy"/> (<see cref="NugetWorkspace.LegacyNotesDirectories"/>),
    /// stopping at the first that cannot move, and rewrites what points into the
    /// moved ones. <paramref name="read"/> (null for a missing file) and
    /// <paramref name="write"/> go through the editor, so an open instruction file
    /// changes in its editor.
    /// </summary>
    public static async Task<MoveOutcome> MoveAsync(
        string root,
        IReadOnlyList<string> legacy,
        Func<string, string?> read,
        Func<string, string, Task> write)
    {
        var moved = new List<MovedDirectory>();
        string? failure = null;
        foreach (var directory in legacy)
        {
            try
            {
                Directory.Move(directory, TargetOf(directory));
                moved.Add(new MovedDirectory(directory, TargetOf(directory)));
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                failure = Failed(NugetWorkspace.RelativePath(directory, root), error.Message);
                break;
            }
        }
        if (moved.Count == 0) return new MoveOutcome(moved, failure);

        // The header comment of each notes file now names .depos/AGENT-RULES.md.
        foreach (var directory in moved)
        {
            foreach (var notes in Directory.EnumerateFiles(directory.To, Notes.FileName, SearchOption.AllDirectories))
            {
                if (read(notes) is not { } text) continue;
                var updated = WithCurrentRules(text);
                if (updated != text) await write(notes, updated);
            }
        }
        // The rules themselves, rewritten for .depos/ where the root has a copy.
        var rules = Path.Combine(root, Notes.DirectoryName, AgentRules.FileName);
        if (read(rules) is not null) await write(rules, AgentRules.Text);
        // The pointer block, in the instruction files that have one.
        foreach (var target in AiInstructions.Targets)
        {
            var path = Path.Combine(root, target.Replace('/', Path.DirectorySeparatorChar));
            if (read(path) is not { } text || !PointerMarker.IsMatch(text)) continue;
            var updated = AiInstructions.Upsert(text, Notes.DirectoryName);
            if (updated != text) await write(path, updated);
        }
        return new MoveOutcome(moved, failure);
    }

    /// <summary>A notes file moved to .depos/: its header comment names .depos/AGENT-RULES.md.</summary>
    public static string WithCurrentRules(string notesText)
    {
        var at = notesText.IndexOf(LegacyRulesReference, StringComparison.Ordinal);
        return at < 0
            ? notesText
            : notesText.Substring(0, at) + CurrentRulesReference + notesText.Substring(at + LegacyRulesReference.Length);
    }
}
