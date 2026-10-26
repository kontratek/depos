namespace Depos.Core;

/// <summary>
/// The pointer block written into instruction files an agent already reads
/// (<c>AGENTS.md</c>, <c>CLAUDE.md</c>, …). Deliberately three lines: the rules
/// themselves live in <c>.pacmon/AGENT-RULES.md</c>, which Depos owns; these
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

    public const string AgentRulesRelativePath = ".pacmon/AGENT-RULES.md";

    private const string BlockStart = "<!-- pacmon:start -->";
    private const string BlockEnd = "<!-- pacmon:end -->";

    /// <summary>Written before the format was named <c>dependency-notes/1</c>. Still found, never written.</summary>
    private static readonly (string Start, string End) LegacyBlock = ("<!-- pacmon:deps-notes:start -->", "<!-- pacmon:deps-notes:end -->");

    public static string Block()
    {
        const string file = Notes.FileName;
        return string.Join("\n",
            BlockStart,
            $"Dependency notes live in `.pacmon/{file}` for npm, `.pacmon/cargo/{file}` for Rust, `.pacmon/maven/{file}` for Maven, "
            + $"`.pacmon/gradle/{file}` for Gradle, `.pacmon/mix/{file}` for Mix, `.pacmon/gleam/{file}` for Gleam, "
            + $"`.pacmon/zig/{file}` for Zig, `.pacmon/python/{file}` for Python, `.pacmon/ruby/{file}` for Ruby, "
            + $"`.pacmon/go/{file}` for Go, `.pacmon/nuget/{file}` for .NET/NuGet, `.pacmon/vcpkg/{file}` for vcpkg, "
            + $"`.pacmon/conan/{file}` for Conan, and `.pacmon/composer/{file}` for PHP/Composer; people write below "
            + $"`## <package>`, agents under `{Notes.AgentHeading}`.",
            $"Rules and the field list are in `{AgentRulesRelativePath}`; read a package's section before adding, bumping or removing it.",
            "Update the notes in the same commit as the dependency manifest; a removed package keeps its section with `- status: removed …`.",
            BlockEnd);
    }

    /// <summary>Insert or replace the marked block in an existing instructions file.</summary>
    public static string Upsert(string existing)
    {
        var block = Block();
        foreach (var (startMark, endMark) in new[] { (BlockStart, BlockEnd), LegacyBlock })
        {
            var start = existing.IndexOf(startMark, StringComparison.Ordinal);
            var end = existing.IndexOf(endMark, StringComparison.Ordinal);
            if (start != -1 && end != -1 && end > start)
                return existing.Substring(0, start) + block + existing.Substring(end + endMark.Length);
        }
        var separator = existing.Length == 0
            ? string.Empty
            : existing.EndsWith("\n\n", StringComparison.Ordinal)
                ? string.Empty
                : existing.EndsWith("\n", StringComparison.Ordinal) ? "\n" : "\n\n";
        return existing + separator + block + "\n";
    }
}
