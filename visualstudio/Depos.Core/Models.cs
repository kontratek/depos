namespace Depos.Core;

public enum ManifestKind
{
    NuGet,
}

public enum MonorepoMode
{
    Nearest,
    RootOnly,
}

public enum InlineSource
{
    HumanFirst,
    AiFirst,
    HumanOnly,
    AiOnly,
}

public readonly record struct SourceRange(int Offset, int Length)
{
    public bool Contains(int offset) => offset >= Offset && offset <= Offset + Length;
}

public sealed record DependencyEntry(
    string NoteKey,
    string DisplayName,
    string Scope,
    SourceRange PrimaryRange,
    SourceRange IconRange,
    SourceRange DeclarationRange,
    IReadOnlyList<SourceRange> SourceRanges);

public sealed record XmlAttribute(string Name, string Value, SourceRange Range);

public sealed class XmlNode
{
    public string Name { get; init; } = string.Empty;
    public int OpenStart { get; init; }
    public int OpenEnd { get; init; }
    public int CloseStart { get; set; }
    public IReadOnlyList<XmlAttribute> Attributes { get; init; } = Array.Empty<XmlAttribute>();
    public List<XmlNode> Children { get; } = new();

    public XmlAttribute? Attribute(string name) =>
        Attributes.FirstOrDefault(attribute => string.Equals(attribute.Name, name, StringComparison.Ordinal));
}

public sealed record NoteSection(
    string Name,
    int HeadingLine,
    int BodyStart,
    int BodyEnd,
    int? AgentHeadingLine,
    int? GeneratedHeadingLine);

public sealed record Frontmatter(
    int StartLine,
    int EndLine,
    string? FormatVersion,
    string? Language,
    string? Ecosystem);

public sealed record NotesProblem(string Kind, string Name, int Line, int FirstLine);

public sealed class NotesFileModel
{
    public string Eol { get; init; } = "\n";
    public bool HadBom { get; init; }
    public IReadOnlyList<string> Lines { get; init; } = Array.Empty<string>();
    public Frontmatter? Frontmatter { get; set; }
    public int? TitleLine { get; set; }
    public List<NoteSection> Sections { get; } = new();
    public List<NotesProblem> Problems { get; } = new();
}

public sealed record SectionLayers(string Human, string Agent, string Generated);

public sealed record NotesAnalysis(
    IReadOnlyList<DependencyEntry> Documented,
    IReadOnlyList<DependencyEntry> Undocumented,
    IReadOnlyList<NoteSection> Orphans,
    IReadOnlyList<NoteSection> Removed,
    IReadOnlyDictionary<string, NoteSection> ByDependency);

public sealed record LintFinding(string Kind, int Line, string Message, int StartColumn = 0, int EndColumn = 0);
