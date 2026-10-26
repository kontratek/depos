using System.Text.RegularExpressions;

namespace Pacmon.Core;

public static class NugetManifest
{
    private static readonly Regex PackageIdPattern = new(
        "^[A-Za-z0-9][A-Za-z0-9._-]*$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    public const string NotesRelativePath = Notes.DirectoryName + "/nuget/" + Notes.FileName;

    /// <summary>The notes path under <paramref name="directoryName"/>; <see cref="NotesRelativePath"/> names the current directory.</summary>
    public static string NotesRelativePathIn(string directoryName) => $"{Notes.Checked(directoryName)}/nuget/{Notes.FileName}";

    /// <summary>Whether the path is a NuGet notes file, under either notes directory.</summary>
    public static bool IsNotesPath(string path)
    {
        var normalized = path.Replace('\\', '/');
        return Notes.DirectoryNames.Any(directoryName =>
            normalized.EndsWith("/" + NotesRelativePathIn(directoryName), StringComparison.OrdinalIgnoreCase));
    }

    public static bool MatchesPath(string path)
    {
        var name = Path.GetFileName(path);
        return string.Equals(name, "Directory.Packages.props", StringComparison.Ordinal)
            || name.EndsWith(".csproj", StringComparison.OrdinalIgnoreCase)
            || name.EndsWith(".fsproj", StringComparison.OrdinalIgnoreCase)
            || name.EndsWith(".vbproj", StringComparison.OrdinalIgnoreCase);
    }

    public static IReadOnlyList<DependencyEntry> ExtractDependencies(string text, string path)
    {
        var nodes = Descendants(TolerantXml.Parse(text));
        var central = string.Equals(Path.GetFileName(path), "Directory.Packages.props", StringComparison.Ordinal);
        var result = new List<DependencyEntry>();
        foreach (var node in nodes)
        {
            if (central && node.Name == "PackageVersion")
            {
                var attributeName = node.Attribute("Include") is null ? "Update" : "Include";
                AddEntry(result, node, attributeName, "centralVersion");
            }
            else if (central && node.Name == "GlobalPackageReference")
            {
                AddEntry(result, node, "Include", "globalPackageReference");
            }
            else if (!central && node.Name == "PackageReference" && node.Attribute("Include") is not null)
            {
                AddEntry(result, node, "Include", "packageReference");
            }
        }
        return result;
    }

    public static IReadOnlyList<DependencyEntry> Unique(IEnumerable<DependencyEntry> dependencies)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<DependencyEntry>();
        foreach (var dependency in dependencies)
        {
            if (seen.Add(dependency.NoteKey.Trim())) result.Add(dependency);
        }
        return result;
    }

    public static DependencyEntry? AtOffset(IEnumerable<DependencyEntry> dependencies, int offset) =>
        dependencies.FirstOrDefault(dependency => dependency.SourceRanges.Any(range => range.Contains(offset)));

    private static IEnumerable<XmlNode> Descendants(IEnumerable<XmlNode> roots)
    {
        foreach (var root in roots)
        {
            yield return root;
            foreach (var child in Descendants(root.Children)) yield return child;
        }
    }

    private static void AddEntry(List<DependencyEntry> result, XmlNode node, string attributeName, string scope)
    {
        if (node.Attribute("Remove") is not null) return;
        var attribute = node.Attribute(attributeName);
        if (attribute is null || !PackageIdPattern.IsMatch(attribute.Value)) return;
        var iconRange = new SourceRange(node.OpenStart, 1);
        result.Add(new DependencyEntry(
            attribute.Value,
            attribute.Value,
            scope,
            attribute.Range,
            iconRange,
            new SourceRange(node.OpenStart, node.OpenEnd - node.OpenStart),
            new[] { attribute.Range }));
    }
}
