using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Pacmon.Core.Tests;

[TestClass]
public sealed class WorkspaceTests
{
    [TestMethod]
    public void NearestCentralFileOwnsProjectAndFirstNote()
    {
        var root = Path.GetFullPath("C:/repo");
        var fs = new MemoryFileSystem(root, new Dictionary<string, string>
        {
            ["Directory.Packages.props"] = "<PackageVersion Include=\"Root.Package\" />",
            ["apps/Directory.Packages.props"] = "<PackageVersion Include=\"Nested.Package\" />",
            ["apps/demo/App.csproj"] = "<PackageReference Include=\"Nested.Package\" />",
        });
        var workspace = new NugetWorkspace(fs);
        var project = Path.Combine(root, "apps", "demo", "App.csproj");

        Assert.AreEqual(Path.Combine(root, "apps"), workspace.OwnerDirectory(project, root));
        Assert.AreEqual(
            Path.Combine(root, "apps", ".depos", "nuget", Notes.FileName),
            workspace.CreationTarget(project, root));
    }

    [TestMethod]
    public void ExistingNotesAreResolvedUpwardAndRootOnlyIsHonored()
    {
        // A repository from before Pacmon became Depos: its .pacmon/ files are read as before.
        var root = Path.GetFullPath("C:/repo");
        var fs = new MemoryFileSystem(root, new Dictionary<string, string>
        {
            ["Directory.Packages.props"] = "<Project />",
            ["apps/Directory.Packages.props"] = "<Project />",
            ["apps/demo/App.csproj"] = "<Project />",
            [".pacmon/nuget/DEPENDENCY-NOTES.md"] = Notes.NewFile(),
            ["apps/.pacmon/nuget/DEPENDENCY-NOTES.md"] = Notes.NewFile(),
        });
        var workspace = new NugetWorkspace(fs);
        var project = Path.Combine(root, "apps", "demo", "App.csproj");

        Assert.AreEqual(
            Path.Combine(root, "apps", ".pacmon", "nuget", Notes.FileName),
            workspace.ResolveNotesPath(project, root, MonorepoMode.Nearest));
        Assert.AreEqual(
            Path.Combine(root, ".pacmon", "nuget", Notes.FileName),
            workspace.ResolveNotesPath(project, root, MonorepoMode.RootOnly));
    }

    [TestMethod]
    public void DiscoveryExcludesBinObjAndCentralWinsCoverageDeduplication()
    {
        var root = Path.GetFullPath("C:/repo");
        var fs = new MemoryFileSystem(root, new Dictionary<string, string>
        {
            ["Directory.Packages.props"] = "<PackageVersion Include=\"Newtonsoft.Json\" />",
            ["src/App.csproj"] = "<PackageReference Include=\"NEWTONSOFT.JSON\" /><PackageReference Include=\"Serilog\" />",
            ["src/bin/Fake.csproj"] = "<PackageReference Include=\"Bad.Bin\" />",
            ["src/obj/Generated.csproj"] = "<PackageReference Include=\"Bad.Obj\" />",
        });
        var workspace = new NugetWorkspace(fs);
        var notes = Path.Combine(root, ".depos", "nuget", Notes.FileName);

        var manifests = workspace.DiscoverManifests(root);
        var dependencies = workspace.DependenciesForNotes(notes, root, MonorepoMode.Nearest);

        Assert.AreEqual(2, manifests.Count);
        CollectionAssert.AreEqual(new[] { "Newtonsoft.Json", "Serilog" }, dependencies.Select(item => item.DisplayName).ToArray());
        Assert.AreEqual("centralVersion", dependencies[0].Scope);
    }

    [TestMethod]
    public void DeposIsReadFirstAtEachLevelAndTheNearestLevelStillWins()
    {
        var root = Path.GetFullPath("C:/repo");
        var fs = new MemoryFileSystem(root, new Dictionary<string, string>
        {
            ["Directory.Packages.props"] = "<Project />",
            ["apps/Directory.Packages.props"] = "<Project />",
            ["apps/demo/App.csproj"] = "<Project />",
            [".depos/nuget/DEPENDENCY-NOTES.md"] = Notes.NewFile(),
            [".pacmon/nuget/DEPENDENCY-NOTES.md"] = Notes.NewFile(directoryName: Notes.LegacyDirectoryName),
            ["apps/.pacmon/nuget/DEPENDENCY-NOTES.md"] = Notes.NewFile(directoryName: Notes.LegacyDirectoryName),
        });
        var workspace = new NugetWorkspace(fs);
        var project = Path.Combine(root, "apps", "demo", "App.csproj");
        var central = Path.Combine(root, "Directory.Packages.props");
        var rootCurrent = Path.Combine(root, ".depos", "nuget", Notes.FileName);
        var rootLegacy = Path.Combine(root, ".pacmon", "nuget", Notes.FileName);

        // apps/ is nearer than the root, so its .pacmon/ file is the one read...
        Assert.AreEqual(
            Path.Combine(root, "apps", ".pacmon", "nuget", Notes.FileName),
            workspace.ResolveNotesPath(project, root, MonorepoMode.Nearest));
        // ...and at the root, which has both, .depos/ wins and .pacmon/ is never read.
        Assert.AreEqual(rootCurrent, workspace.ResolveNotesPath(central, root, MonorepoMode.Nearest));
        Assert.AreEqual(rootCurrent, workspace.ResolveNotesPath(project, root, MonorepoMode.RootOnly));
        CollectionAssert.AreEqual(new[] { central }, workspace.ManifestsForNotes(rootCurrent, root, MonorepoMode.Nearest).ToArray());
        Assert.AreEqual(0, workspace.ManifestsForNotes(rootLegacy, root, MonorepoMode.Nearest).Count);
    }

    [TestMethod]
    public void NewFilesGoToTheDirectoryTheRepositoryKeepsItsNotesIn()
    {
        var root = Path.GetFullPath("C:/repo");
        string Decide(params string[] files)
        {
            var contents = files.ToDictionary(file => file, _ => string.Empty);
            contents["src/App/App.csproj"] = "<Project />";
            return new NugetWorkspace(new MemoryFileSystem(root, contents)).NotesDirectoryFor(root);
        }

        Assert.AreEqual(Notes.DirectoryName, Decide());
        Assert.AreEqual(Notes.LegacyDirectoryName, Decide(".pacmon/AGENT-RULES.md"));
        Assert.AreEqual(Notes.LegacyDirectoryName, Decide("libs/.pacmon/nuget/DEPENDENCY-NOTES.md"));
        // Anything under .depos/ decides, a notes file of another ecosystem included.
        Assert.AreEqual(Notes.DirectoryName, Decide(".pacmon/AGENT-RULES.md", "web/.depos/DEPENDENCY-NOTES.md"));
        Assert.AreEqual(Notes.DirectoryName, Decide(".depos/AGENT-RULES.md", ".pacmon/nuget/DEPENDENCY-NOTES.md"));
        // Build output is not where the repository keeps its notes.
        Assert.AreEqual(Notes.LegacyDirectoryName, Decide(".pacmon/AGENT-RULES.md", "src/App/bin/.depos/nuget/DEPENDENCY-NOTES.md"));
    }

    [TestMethod]
    public void TheFirstNoteOfANewProjectStaysInALegacyRepository()
    {
        var root = Path.GetFullPath("C:/repo");
        var fs = new MemoryFileSystem(root, new Dictionary<string, string>
        {
            [".pacmon/AGENT-RULES.md"] = string.Empty,
            ["old/Old.csproj"] = "<Project />",
            ["old/.pacmon/nuget/DEPENDENCY-NOTES.md"] = Notes.NewFile(directoryName: Notes.LegacyDirectoryName),
            ["new/New.csproj"] = "<Project />",
        });
        var workspace = new NugetWorkspace(fs);
        var project = Path.Combine(root, "new", "New.csproj");

        Assert.IsNull(workspace.ResolveNotesPath(project, root, MonorepoMode.Nearest));
        Assert.AreEqual(
            Path.Combine(root, "new", ".pacmon", "nuget", Notes.FileName),
            workspace.CreationTarget(project, root));
    }

    [TestMethod]
    public void ALegacyFileBesideACurrentOneNamesTheFileReadInstead()
    {
        var root = Path.GetFullPath("C:/repo");
        var fs = new MemoryFileSystem(root, new Dictionary<string, string>
        {
            [".depos/nuget/DEPENDENCY-NOTES.md"] = Notes.NewFile(),
            [".pacmon/nuget/DEPENDENCY-NOTES.md"] = Notes.NewFile(directoryName: Notes.LegacyDirectoryName),
            ["apps/.pacmon/nuget/DEPENDENCY-NOTES.md"] = Notes.NewFile(directoryName: Notes.LegacyDirectoryName),
        });
        var workspace = new NugetWorkspace(fs);
        var current = Path.Combine(root, ".depos", "nuget", Notes.FileName);

        Assert.AreEqual(current, workspace.ShadowingNotesPath(Path.Combine(root, ".pacmon", "nuget", Notes.FileName)));
        Assert.IsNull(workspace.ShadowingNotesPath(Path.Combine(root, "apps", ".pacmon", "nuget", Notes.FileName)));
        Assert.IsNull(workspace.ShadowingNotesPath(current));
        Assert.AreEqual(".depos/nuget/DEPENDENCY-NOTES.md", NugetWorkspace.RelativePath(current, root));
    }

    private sealed class MemoryFileSystem : IWorkspaceFileSystem
    {
        private readonly string root;
        private readonly Dictionary<string, string> files;

        public MemoryFileSystem(string root, IReadOnlyDictionary<string, string> files)
        {
            this.root = Path.GetFullPath(root);
            this.files = files.ToDictionary(
                pair => Path.GetFullPath(Path.Combine(this.root, pair.Key.Replace('/', Path.DirectorySeparatorChar))),
                pair => pair.Value,
                StringComparer.OrdinalIgnoreCase);
        }

        public bool FileExists(string path) => files.ContainsKey(Path.GetFullPath(path));
        public string ReadAllText(string path) => files[Path.GetFullPath(path)];
        public IEnumerable<string> EnumerateFiles(string ignoredRoot) => files.Keys.Where(path =>
            !path.Split(Path.DirectorySeparatorChar).Any(part => part.Equals("bin", StringComparison.OrdinalIgnoreCase)
                || part.Equals("obj", StringComparison.OrdinalIgnoreCase)
                || part.Equals(".git", StringComparison.OrdinalIgnoreCase)));
    }
}
