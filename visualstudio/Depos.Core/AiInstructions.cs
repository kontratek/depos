using System.Text.RegularExpressions;

namespace Depos.Core;

/// <summary>
/// The pointer block written into instruction files an agent already reads
/// (<c>AGENTS.md</c>, <c>CLAUDE.md</c>, …). Deliberately three lines: the rules
/// themselves live in <c>.depos/AGENT-RULES.md</c>, which Depos owns; these
/// files it does not. A line-for-line port of the TypeScript core's
/// <c>aiInstructionsBlock</c>/<c>upsertAiInstructions</c> (<c>src/core/template.ts</c>):
/// the markers belong to the format and are the same in every editor.
/// </summary>
public static class AiInstructions
{
    /// <summary>Files "Set Up AI Instructions" offers to write the pointer block into, in the other editors' order.</summary>
    public static IReadOnlyList<string> Targets { get; } = new[]
    {
        "AGENTS.md", "CLAUDE.md", ".cursor/rules/dependency-notes.md", ".github/copilot-instructions.md",
    };

    private const string BlockStart = "<!-- depos:start -->";
    private const string BlockEnd = "<!-- depos:end -->";

    /// <summary>
    /// Markers written by earlier versions: Pacmon's, and before them the ones from
    /// before the format was named <c>dependency-notes/1</c>. Still found, never written.
    /// </summary>
    private static readonly (string Start, string End)[] LegacyBlocks =
    {
        ("<!-- pacmon:start -->", "<!-- pacmon:end -->"),
        ("<!-- pacmon:deps-notes:start -->", "<!-- pacmon:deps-notes:end -->"),
    };

    private static readonly Regex TrailingLineBreaks = new("(?:\\r?\\n)+\\z", RegexOptions.Compiled);
    private static readonly Regex LeadingLineBreaks = new("\\A(?:\\r?\\n)+", RegexOptions.Compiled);

    /// <summary><paramref name="directoryName"/> is the repository's notes directory.</summary>
    public static string Block(string directoryName = Notes.DirectoryName)
    {
        var dir = Notes.Checked(directoryName);
        const string file = Notes.FileName;
        return string.Join("\n",
            BlockStart,
            $"Dependency notes live in `{dir}/{file}` for npm, `{dir}/cargo/{file}` for Rust, `{dir}/maven/{file}` for Maven, "
            + $"`{dir}/gradle/{file}` for Gradle, `{dir}/mix/{file}` for Mix, `{dir}/gleam/{file}` for Gleam, "
            + $"`{dir}/zig/{file}` for Zig, `{dir}/python/{file}` for Python, `{dir}/ruby/{file}` for Ruby, "
            + $"`{dir}/go/{file}` for Go, `{dir}/nuget/{file}` for .NET/NuGet, `{dir}/vcpkg/{file}` for vcpkg, "
            + $"`{dir}/conan/{file}` for Conan, and `{dir}/composer/{file}` for PHP/Composer; people write below "
            + $"`## <package>`, agents under `{Notes.AgentHeading}`.",
            $"Rules and the field list are in `{AgentRules.RelativePath(dir)}`; read a package's section before adding, bumping or removing it.",
            "Update the notes in the same commit as the dependency manifest; a removed package keeps its section with `- status: removed …`.",
            BlockEnd);
    }

    /// <summary>
    /// Insert or replace the marked block in an existing instructions file. The
    /// first block found, current or legacy, becomes the new one; any other is
    /// removed. A teammate on an older version adds a <c>pacmon:</c> block of their
    /// own, so the file comes back to one block the next time this runs.
    /// </summary>
    public static string Upsert(string existing, string directoryName = Notes.DirectoryName)
    {
        var block = Block(directoryName);
        var ranges = MarkedBlocks(existing);
        if (ranges.Count > 0)
        {
            var first = ranges[0];
            var text = existing;
            for (var index = ranges.Count - 1; index > 0; index--) text = WithoutBlock(text, ranges[index]);
            return text.Substring(0, first.Start) + block + text.Substring(first.End);
        }
        var separator = existing.Length == 0
            ? string.Empty
            : existing.EndsWith("\n\n", StringComparison.Ordinal)
                ? string.Empty
                : existing.EndsWith("\n", StringComparison.Ordinal) ? "\n" : "\n\n";
        return existing + separator + block + "\n";
    }

    /// <summary>Every marked block in the text, current and legacy, in the order they appear.</summary>
    private static List<(int Start, int End)> MarkedBlocks(string text)
    {
        var ranges = new List<(int Start, int End)>();
        foreach (var (startMark, endMark) in new[] { (BlockStart, BlockEnd) }.Concat(LegacyBlocks))
        {
            var from = 0;
            while (true)
            {
                var start = text.IndexOf(startMark, from, StringComparison.Ordinal);
                if (start == -1) break;
                var end = text.IndexOf(endMark, start + startMark.Length, StringComparison.Ordinal);
                if (end == -1) break;
                ranges.Add((start, end + endMark.Length));
                from = end + endMark.Length;
            }
        }
        var sorted = ranges.OrderBy(range => range.Start).ToList();
        // A block inside another (a hand-edited file) is the outer block's business.
        return sorted.Where((range, index) => sorted.Take(index).All(other => range.Start >= other.End)).ToList();
    }

    /// <summary>The text without the block, and without the blank lines it leaves behind.</summary>
    private static string WithoutBlock(string text, (int Start, int End) range)
    {
        var eol = text.Contains("\r\n") ? "\r\n" : "\n";
        var before = TrailingLineBreaks.Replace(text.Substring(0, range.Start), string.Empty);
        var after = LeadingLineBreaks.Replace(text.Substring(range.End), string.Empty);
        if (before.Length == 0) return after;
        if (after.Length == 0) return before + eol;
        return before + eol + eol + after;
    }
}
