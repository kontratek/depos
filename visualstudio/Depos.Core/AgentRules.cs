namespace Depos.Core;

/// <summary>
/// assets/AGENT-RULES.md, embedded at build time: the rules Depos copies into a
/// workspace as .pacmon/AGENT-RULES.md, the same file the VS Code extension and
/// the JetBrains plugin write.
/// </summary>
public static class AgentRules
{
    private static readonly Lazy<string> text = new(() =>
    {
        using var stream = typeof(AgentRules).Assembly.GetManifestResourceStream("Depos.Core.AGENT-RULES.md")
            ?? throw new InvalidOperationException("AGENT-RULES.md is not embedded in Depos.Core.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd().Replace("\r\n", "\n");
    });

    public static string Text => text.Value;
}
