namespace Pacmon.Core;

public interface IWorkspaceFileSystem
{
    bool FileExists(string path);
    string ReadAllText(string path);
    IEnumerable<string> EnumerateFiles(string root);
}

public sealed class PhysicalWorkspaceFileSystem : IWorkspaceFileSystem
{
    private static readonly HashSet<string> ExcludedDirectories = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", ".vs", "bin", "obj", "dist", "build",
    };

    public bool FileExists(string path) => File.Exists(path);

    public string ReadAllText(string path) => File.ReadAllText(path);

    public IEnumerable<string> EnumerateFiles(string root) => Enumerate(root);

    private static IEnumerable<string> Enumerate(string directory)
    {
        IEnumerable<string> files;
        IEnumerable<string> directories;
        try
        {
            files = Directory.EnumerateFiles(directory);
            directories = Directory.EnumerateDirectories(directory);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            yield break;
        }

        foreach (var file in files) yield return file;
        foreach (var child in directories)
        {
            if (ExcludedDirectories.Contains(Path.GetFileName(child))) continue;
            foreach (var file in Enumerate(child)) yield return file;
        }
    }
}

public sealed class NugetWorkspace
{
    private readonly IWorkspaceFileSystem fileSystem;
    private readonly Dictionary<string, string> notesDirectories = new(StringComparer.OrdinalIgnoreCase);

    public NugetWorkspace(IWorkspaceFileSystem fileSystem) => this.fileSystem = fileSystem;

    public string OwnerDirectory(string manifestPath, string root)
    {
        var manifest = FullPath(manifestPath);
        var boundary = FullPath(root);
        var directOwner = Path.GetDirectoryName(manifest) ?? boundary;
        if (string.Equals(Path.GetFileName(manifest), "Directory.Packages.props", StringComparison.Ordinal))
            return directOwner;

        for (var directory = directOwner; IsWithin(directory, boundary); directory = Parent(directory))
        {
            if (fileSystem.FileExists(Path.Combine(directory, "Directory.Packages.props"))) return directory;
            if (PathEquals(directory, boundary)) break;
        }
        return directOwner;
    }

    public string CreationTarget(string manifestPath, string root) =>
        NotesPathIn(OwnerDirectory(manifestPath, root), NotesDirectoryFor(root));

    /// <summary>
    /// The notes directory new files go to under a solution or workspace root,
    /// decided once for the whole repository: .depos/ when anything is there
    /// (AGENT-RULES.md at the root, or a notes file of any ecosystem), else
    /// .pacmon/ when anything is there, else .depos/. A repository that keeps its
    /// notes in .pacmon/ stays there whole, the first note of a new project
    /// included, until all of it moves: a teammate on an older version reads
    /// .pacmon/ only. Decided once per instance; make a new one to see changes.
    /// </summary>
    public string NotesDirectoryFor(string root)
    {
        var boundary = FullPath(root);
        if (notesDirectories.TryGetValue(boundary, out var decided)) return decided;
        decided = DecideNotesDirectory(boundary);
        notesDirectories[boundary] = decided;
        return decided;
    }

    private string DecideNotesDirectory(string root)
    {
        // Every write puts AGENT-RULES.md at the root, so this answers for most repositories.
        if (fileSystem.FileExists(Path.Combine(root, Notes.DirectoryName, AgentRules.FileName))) return Notes.DirectoryName;
        var legacyInUse = fileSystem.FileExists(Path.Combine(root, Notes.LegacyDirectoryName, AgentRules.FileName));
        foreach (var path in fileSystem.EnumerateFiles(root))
        {
            if (!string.Equals(Path.GetFileName(path), Notes.FileName, StringComparison.OrdinalIgnoreCase)) continue;
            var directoryName = NotesDirectoryAbove(path, root);
            if (directoryName == Notes.DirectoryName) return Notes.DirectoryName;
            if (directoryName == Notes.LegacyDirectoryName) legacyInUse = true;
        }
        return legacyInUse ? Notes.LegacyDirectoryName : Notes.DirectoryName;
    }

    /// <summary>The notes directory among the folders between the root and the file, if any.</summary>
    private static string? NotesDirectoryAbove(string path, string root)
    {
        var full = FullPath(path);
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return null;
        var segments = full.Substring(root.Length + 1).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var folders = segments.Take(segments.Length - 1).ToArray();
        return Notes.DirectoryNames.FirstOrDefault(directoryName =>
            folders.Contains(directoryName, StringComparer.OrdinalIgnoreCase));
    }

    public string? ResolveNotesPath(string manifestPath, string root, MonorepoMode mode)
    {
        var boundary = FullPath(root);
        if (mode == MonorepoMode.RootOnly) return NotesFileIn(boundary);

        for (var directory = OwnerDirectory(manifestPath, boundary);
             IsWithin(directory, boundary);
             directory = Parent(directory))
        {
            if (NotesFileIn(directory) is { } found) return found;
            if (PathEquals(directory, boundary)) break;
        }
        return null;
    }

    /// <summary>The notes file in one directory: .depos/ first, then .pacmon/.</summary>
    private string? NotesFileIn(string directory) => Notes.DirectoryNames
        .Select(directoryName => NotesPathIn(directory, directoryName))
        .FirstOrDefault(fileSystem.FileExists);

    private static string NotesPathIn(string directory, string directoryName) =>
        Path.Combine(directory, directoryName, "nuget", Notes.FileName);

    /// <summary>
    /// For a notes file under .pacmon/: the .depos/ file beside it, which is read
    /// instead, if there is one.
    /// </summary>
    public string? ShadowingNotesPath(string notesPath)
    {
        var full = FullPath(notesPath);
        var legacy = Path.DirectorySeparatorChar + Notes.LegacyDirectoryName + Path.DirectorySeparatorChar;
        var at = full.LastIndexOf(legacy, StringComparison.OrdinalIgnoreCase);
        if (at < 0) return null;
        var current = full.Substring(0, at) + Path.DirectorySeparatorChar + Notes.DirectoryName
            + Path.DirectorySeparatorChar + full.Substring(at + legacy.Length);
        return fileSystem.FileExists(current) ? current : null;
    }

    /// <summary>The path from the root, with forward slashes, as messages name files; the full path outside it.</summary>
    public static string RelativePath(string path, string root)
    {
        var full = FullPath(path);
        var boundary = FullPath(root);
        return full.StartsWith(boundary + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            ? full.Substring(boundary.Length + 1).Replace(Path.DirectorySeparatorChar, '/')
            : full;
    }

    public IReadOnlyList<string> DiscoverManifests(string root) => fileSystem
        .EnumerateFiles(FullPath(root))
        .Where(NugetManifest.MatchesPath)
        .Select(FullPath)
        .OrderBy(path => ManifestPriority(path))
        .ThenBy(path => path, StringComparer.OrdinalIgnoreCase)
        .ToArray();

    public IReadOnlyList<string> ManifestsForNotes(string notesPath, string root, MonorepoMode mode)
    {
        var target = FullPath(notesPath);
        return DiscoverManifests(root)
            .Where(manifest =>
            {
                var resolved = ResolveNotesPath(manifest, root, mode);
                return PathEquals(resolved ?? CreationTarget(manifest, root), target);
            })
            .ToArray();
    }

    public IReadOnlyList<DependencyEntry> DependenciesForNotes(string notesPath, string root, MonorepoMode mode)
    {
        var dependencies = ManifestsForNotes(notesPath, root, mode)
            .SelectMany(path => NugetManifest.ExtractDependencies(fileSystem.ReadAllText(path), path));
        return NugetManifest.Unique(dependencies);
    }

    public IReadOnlyList<DependencyEntry> DependenciesForManifest(string manifestPath, string root, MonorepoMode mode)
    {
        var notesPath = ResolveNotesPath(manifestPath, root, mode) ?? CreationTarget(manifestPath, root);
        var shared = DependenciesForNotes(notesPath, root, mode);
        var own = NugetManifest.ExtractDependencies(fileSystem.ReadAllText(manifestPath), manifestPath);
        return NugetManifest.Unique(shared.Concat(own));
    }

    private static int ManifestPriority(string path) =>
        string.Equals(Path.GetFileName(path), "Directory.Packages.props", StringComparison.Ordinal) ? 0 : 1;

    private static string Parent(string path) => Directory.GetParent(path)?.FullName ?? path;

    private static string FullPath(string path) => Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    private static bool PathEquals(string left, string right) =>
        string.Equals(FullPath(left), FullPath(right), StringComparison.OrdinalIgnoreCase);

    private static bool IsWithin(string path, string root)
    {
        var candidate = FullPath(path);
        var boundary = FullPath(root);
        return PathEquals(candidate, boundary)
            || candidate.StartsWith(boundary + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
    }
}
