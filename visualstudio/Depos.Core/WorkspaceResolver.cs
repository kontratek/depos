namespace Depos.Core;

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
        Path.Combine(OwnerDirectory(manifestPath, root), ".pacmon", "nuget", Notes.FileName);

    public string? ResolveNotesPath(string manifestPath, string root, MonorepoMode mode)
    {
        var boundary = FullPath(root);
        if (mode == MonorepoMode.RootOnly)
        {
            var rootCandidate = Path.Combine(boundary, ".pacmon", "nuget", Notes.FileName);
            return fileSystem.FileExists(rootCandidate) ? rootCandidate : null;
        }

        for (var directory = OwnerDirectory(manifestPath, boundary);
             IsWithin(directory, boundary);
             directory = Parent(directory))
        {
            var candidate = Path.Combine(directory, ".pacmon", "nuget", Notes.FileName);
            if (fileSystem.FileExists(candidate)) return candidate;
            if (PathEquals(directory, boundary)) break;
        }
        return null;
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
