using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Depos.Core.Tests;

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
            Path.Combine(root, "apps", ".pacmon", "nuget", Notes.FileName),
            workspace.CreationTarget(project, root));
    }

    [TestMethod]
    public void ExistingNotesAreResolvedUpwardAndRootOnlyIsHonored()
    {
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
        var notes = Path.Combine(root, ".pacmon", "nuget", Notes.FileName);

        var manifests = workspace.DiscoverManifests(root);
        var dependencies = workspace.DependenciesForNotes(notes, root, MonorepoMode.Nearest);

        Assert.AreEqual(2, manifests.Count);
        CollectionAssert.AreEqual(new[] { "Newtonsoft.Json", "Serilog" }, dependencies.Select(item => item.DisplayName).ToArray());
        Assert.AreEqual("centralVersion", dependencies[0].Scope);
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
