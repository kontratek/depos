using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Depos.Core.Tests;

/// <summary>"Move Notes to .depos/": the counterpart of <c>src/ext/commands/moveNotes.ts</c>, on a real directory.</summary>
[TestClass]
public sealed class MoveNotesTests
{
    private string root = null!;

    [TestInitialize]
    public void CreateRepository() =>
        root = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "depos-move-" + Guid.NewGuid().ToString("N"))).FullName;

    [TestCleanup]
    public void RemoveRepository()
    {
        if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
    }

    private void Create(string path, string text)
    {
        var full = Path.Combine(root, path.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        File.WriteAllText(full, text);
    }

    private string Text(string path) => File.ReadAllText(Path.Combine(root, path.Replace('/', Path.DirectorySeparatorChar)));

    private bool Exists(string path) => File.Exists(Path.Combine(root, path.Replace('/', Path.DirectorySeparatorChar)));

    private Task<MoveOutcome> MoveAsync() => MoveNotes.MoveAsync(
        root,
        new NugetWorkspace(new PhysicalWorkspaceFileSystem()).LegacyNotesDirectories(root),
        path => File.Exists(path) ? File.ReadAllText(path) : null,
        (path, text) =>
        {
            File.WriteAllText(path, text);
            return Task.CompletedTask;
        });

    [TestMethod]
    public async Task MovesEveryPacmonDirectoryAndWhatPointsIntoThem()
    {
        Create("App.csproj", "<PackageReference Include=\"Serilog\" />");
        Create(".pacmon/nuget/DEPENDENCY-NOTES.md", Notes.NewFile("Serilog", "Logging", directoryName: Notes.LegacyDirectoryName));
        Create(".pacmon/cargo/DEPENDENCY-NOTES.md", "<!-- … rules in .pacmon/AGENT-RULES.md. -->\n\n# Dependency Notes\n");
        Create(".pacmon/AGENT-RULES.md", AgentRules.TextIn(Notes.LegacyDirectoryName));
        Create("apps/web/.pacmon/DEPENDENCY-NOTES.md", "## react\n\nUI\n");
        Create("web/node_modules/some-package/.pacmon/DEPENDENCY-NOTES.md", "## left-pad\n\nvendored\n");
        Create("AGENTS.md", "# AGENTS\n\nintro\n\n<!-- pacmon:start -->\nold\n<!-- pacmon:end -->\n");
        Create("CLAUDE.md", "# Claude\n\nno block here\n");

        var outcome = await MoveAsync();

        Assert.IsNull(outcome.Failure);
        CollectionAssert.AreEqual(
            new[] { Path.Combine(root, ".depos"), Path.Combine(root, "apps", "web", ".depos") },
            outcome.Moved.Select(directory => directory.To).ToArray());
        Assert.IsFalse(Directory.Exists(Path.Combine(root, ".pacmon")));
        Assert.IsFalse(Directory.Exists(Path.Combine(root, "apps", "web", ".pacmon")));
        foreach (var moved in new[] { ".depos/nuget/DEPENDENCY-NOTES.md", ".depos/cargo/DEPENDENCY-NOTES.md" })
        {
            StringAssert.Contains(Text(moved), "rules in .depos/AGENT-RULES.md");
            Assert.IsFalse(Text(moved).Contains(".pacmon/"), moved);
        }
        Assert.AreEqual(Notes.NewFile("Serilog", "Logging"), Text(".depos/nuget/DEPENDENCY-NOTES.md"));
        Assert.AreEqual("## react\n\nUI\n", Text("apps/web/.depos/DEPENDENCY-NOTES.md"));
        // Dependencies of dependencies are not the repository's.
        Assert.IsTrue(Exists("web/node_modules/some-package/.pacmon/DEPENDENCY-NOTES.md"));
        // The rules, from the extension's own copy, for .depos/.
        Assert.AreEqual(AgentRules.Text, Text(".depos/AGENT-RULES.md"));
        // The pointer block, in the file that had one; the other is left alone.
        Assert.AreEqual("# AGENTS\n\nintro\n\n" + AiInstructions.Block() + "\n", Text("AGENTS.md"));
        Assert.AreEqual("# Claude\n\nno block here\n", Text("CLAUDE.md"));
        // The notes are read from their new place, and the next first note goes there too.
        var workspace = new NugetWorkspace(new PhysicalWorkspaceFileSystem());
        var manifest = Path.Combine(root, "App.csproj");
        Assert.AreEqual(
            Path.Combine(root, ".depos", "nuget", Notes.FileName),
            workspace.ResolveNotesPath(manifest, root, MonorepoMode.Nearest));
        Assert.AreEqual(Notes.DirectoryName, workspace.NotesDirectoryFor(root));
    }

    [TestMethod]
    public void ADeposDirectoryBesideAPacmonOneIsLeftToAPerson()
    {
        Create(".pacmon/nuget/DEPENDENCY-NOTES.md", "## Serilog\n");
        Create("apps/.pacmon/nuget/DEPENDENCY-NOTES.md", "## Polly\n");
        Create("apps/.depos/nuget/DEPENDENCY-NOTES.md", "## Polly\n");

        var legacy = new NugetWorkspace(new PhysicalWorkspaceFileSystem()).LegacyNotesDirectories(root);

        CollectionAssert.AreEqual(new[] { Path.Combine(root, "apps", ".pacmon") }, MoveNotes.Conflicts(legacy).ToArray());
        Assert.AreEqual(
            "Depos: a .depos/ directory already exists beside apps/.pacmon. Merge the two by hand, then run Move Notes to .depos/ again.",
            MoveNotes.Conflict(NugetWorkspace.RelativePath(Path.Combine(root, "apps", ".pacmon"), root)));
    }

    [TestMethod]
    public void TheWordsAreTheOtherEditors()
    {
        Assert.AreEqual(
            "Move the .pacmon/ directory to .depos/? Versions from before Depos read .pacmon/ only: "
            + "move once everyone working here has updated.",
            MoveNotes.Confirm(1));
        Assert.AreEqual(
            "Move 2 .pacmon/ directories to .depos/? Versions from before Depos read .pacmon/ only: "
            + "move once everyone working here has updated.",
            MoveNotes.Confirm(2));
        Assert.AreEqual("Depos: moved 1 directory to .depos/.", MoveNotes.Done(1));
        Assert.AreEqual("Depos: moved 3 directories to .depos/.", MoveNotes.Done(3));
        Assert.AreEqual(
            "Depos: this repository keeps its notes in .pacmon/, their directory from before Pacmon became Depos. "
            + "Move them to .depos/ once everyone working in it has updated.",
            MoveNotes.Suggest);
    }
}
