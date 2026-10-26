namespace Pacmon.Core;

/// <summary>
/// assets/AGENT-RULES.md, embedded at build time: the rules Depos copies into a
/// workspace as .depos/AGENT-RULES.md, the same file the VS Code extension and
/// the JetBrains plugin write. It is written for .depos/; a repository that
/// keeps its notes in .pacmon/ gets it with its paths there (<see cref="TextIn"/>).
/// </summary>
public static class AgentRules
{
    public const string FileName = "AGENT-RULES.md";

    private static readonly Lazy<string> text = new(() =>
    {
        using var stream = typeof(AgentRules).Assembly.GetManifestResourceStream("Pacmon.Core.AGENT-RULES.md")
            ?? throw new InvalidOperationException("AGENT-RULES.md is not embedded in Pacmon.Core.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd().Replace("\r\n", "\n");
    });

    /// <summary>The rules as shipped, for a repository whose notes are under .depos/.</summary>
    public static string Text => text.Value;

    /// <summary>
    /// The rules as they read in a repository whose notes are under
    /// <paramref name="directoryName"/>: the same one transformation the other
    /// editors make, every ".depos/" in the text becoming ".pacmon/" for .pacmon/.
    /// </summary>
    public static string TextIn(string directoryName) => Notes.InDirectory(Text, directoryName);

    /// <summary>Where the rules are from the workspace root, as the header comment names them: .depos/AGENT-RULES.md.</summary>
    public static string RelativePath(string directoryName) => $"{Notes.Checked(directoryName)}/{FileName}";
}
