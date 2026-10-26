using System.Text.RegularExpressions;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Depos.Core.Tests;

/// <summary>The pointer block: the same cases as the pointer block tests of <c>src/test/unit/template.test.ts</c>.</summary>
[TestClass]
public sealed class AiInstructionsTests
{
    /// <summary>The lines between the current markers.</summary>
    private static string[] Between(string text)
    {
        var lines = text.Split('\n');
        var start = Array.FindIndex(lines, line => line.Contains("depos:start"));
        var end = Array.FindIndex(lines, line => line.Contains("depos:end"));
        return lines.Skip(start + 1).Take(end - start - 1).ToArray();
    }

    private static int Count(string text, string needle) => Regex.Matches(text, Regex.Escape(needle)).Count;

    [TestMethod]
    public void TheBlockNamesTheNotesFileOfEveryEcosystem()
    {
        var block = AiInstructions.Block();
        StringAssert.Contains(block, "`.depos/DEPENDENCY-NOTES.md` for npm");
        foreach (var (directory, ecosystem) in new[]
        {
            ("cargo", "Rust"), ("maven", "Maven"), ("gradle", "Gradle"), ("mix", "Mix"), ("gleam", "Gleam"),
            ("zig", "Zig"), ("python", "Python"), ("ruby", "Ruby"), ("go", "Go"), ("nuget", ".NET/NuGet"),
            ("vcpkg", "vcpkg"), ("conan", "Conan"), ("composer", "PHP/Composer"),
        })
        {
            StringAssert.Contains(block, $"`.depos/{directory}/DEPENDENCY-NOTES.md` for {ecosystem}", ecosystem);
        }
    }

    [TestMethod]
    public void IsExactlyThreeLinesAndPointsAtBothFiles()
    {
        var lines = AiInstructions.Block().Split('\n');
        Assert.AreEqual("<!-- depos:start -->", lines[0]);
        Assert.AreEqual("<!-- depos:end -->", lines[lines.Length - 1]);
        var inner = Between(AiInstructions.Block());
        Assert.AreEqual(3, inner.Length);
        var text = string.Join("\n", inner);
        StringAssert.Contains(text, NugetManifest.NotesRelativePath);
        StringAssert.Contains(text, AgentRules.RelativePath(Notes.DirectoryName));
        StringAssert.Contains(text, "### Agent notes");
        StringAssert.Contains(text, "status: removed");
        Assert.IsFalse(text.Contains(".pacmon/"));
    }

    [TestMethod]
    public void NamesTheRepositorysOwnDirectoryWhenItStillKeepsItsNotesInPacmon()
    {
        var text = string.Join("\n", Between(AiInstructions.Block(Notes.LegacyDirectoryName)));
        StringAssert.Contains(text, ".pacmon/DEPENDENCY-NOTES.md");
        StringAssert.Contains(text, ".pacmon/cargo/DEPENDENCY-NOTES.md");
        StringAssert.Contains(text, ".pacmon/AGENT-RULES.md");
        Assert.IsFalse(text.Contains(".depos/"));
    }

    [TestMethod]
    public void AppendsTheBlockOnceAndReplacesItOnReRun()
    {
        var first = AiInstructions.Upsert("# AGENTS\n\nexisting\n");
        StringAssert.Contains(first, "depos:start");
        var second = AiInstructions.Upsert(first);
        Assert.AreEqual(1, Count(second, "depos:start"));
        StringAssert.Contains(second, "existing");
        Assert.AreEqual(3, Between(second).Length);
        Assert.AreEqual("# AGENTS\n\n" + AiInstructions.Block() + "\n", AiInstructions.Upsert("# AGENTS\n"));
        Assert.AreEqual("text\n\n" + AiInstructions.Block() + "\n", AiInstructions.Upsert("text"));
    }

    [TestMethod]
    public void WorksOnEmptyFiles()
    {
        var output = AiInstructions.Upsert(string.Empty);
        Assert.IsTrue(output.StartsWith("<!-- depos:start -->", StringComparison.Ordinal));
        Assert.IsTrue(output.EndsWith("\n", StringComparison.Ordinal));
    }

    [TestMethod]
    public void ReplacesABlockLeftByTheOldMarkers()
    {
        var output = AiInstructions.Upsert("# AGENTS\n\n<!-- pacmon:deps-notes:start -->\nold\n<!-- pacmon:deps-notes:end -->\n");
        Assert.IsFalse(output.Contains("deps-notes"));
        Assert.IsFalse(output.Contains("\nold\n"));
        Assert.AreEqual(3, Between(output).Length);
    }

    [TestMethod]
    public void ReplacesTheBlockPacmonWroteInPlace()
    {
        var output = AiInstructions.Upsert("# AGENTS\n\nbefore\n\n<!-- pacmon:start -->\nold\n<!-- pacmon:end -->\n\nafter\n");
        Assert.IsFalse(output.Contains("pacmon:"));
        Assert.IsFalse(output.Contains("\nold\n"));
        Assert.IsTrue(output.IndexOf("before", StringComparison.Ordinal) < output.IndexOf("depos:start", StringComparison.Ordinal));
        Assert.IsTrue(output.IndexOf("depos:end", StringComparison.Ordinal) < output.IndexOf("after", StringComparison.Ordinal));
        Assert.AreEqual(3, Between(output).Length);
    }

    [TestMethod]
    public void ComesBackToOneBlockWhenAnOlderVersionAddedItsOwn()
    {
        // A teammate on Pacmon ran the setup after this file got the Depos block:
        // Pacmon did not know the new markers and appended a block of its own.
        var block = AiInstructions.Block();
        var mixed = $"# AGENTS\n\nintro\n\n{block}\n\nmiddle\n\n<!-- pacmon:start -->\nold\n<!-- pacmon:end -->\n";
        var output = AiInstructions.Upsert(mixed);
        Assert.AreEqual(1, Count(output, "depos:start"));
        Assert.IsFalse(output.Contains("pacmon:"));
        Assert.AreEqual($"# AGENTS\n\nintro\n\n{block}\n\nmiddle\n", output);
    }

    [TestMethod]
    public void TheFirstBlockFoundBecomesTheNewOneWhereverItIs()
    {
        var mixed = "<!-- pacmon:start -->\nold\n<!-- pacmon:end -->\n\nmiddle\n\n"
            + "<!-- depos:start -->\nx\n<!-- depos:end -->\n\n<!-- pacmon:deps-notes:start -->\ny\n<!-- pacmon:deps-notes:end -->\n";
        Assert.AreEqual(AiInstructions.Block() + "\n\nmiddle\n", AiInstructions.Upsert(mixed));
    }

    [TestMethod]
    public void KeepsCrlfFilesCrlfAroundARemovedBlock()
    {
        var mixed = "intro\r\n\r\n<!-- depos:start -->\r\nx\r\n<!-- depos:end -->\r\n\r\nmiddle\r\n\r\n"
            + "<!-- pacmon:start -->\r\nold\r\n<!-- pacmon:end -->\r\n\r\nend\r\n";
        var output = AiInstructions.Upsert(mixed);
        StringAssert.Contains(output, "\r\n\r\nmiddle\r\n\r\nend\r\n");
        Assert.IsFalse(output.Contains("pacmon:"));
    }

    [TestMethod]
    public void WritesTheBlockForTheRepositorysDirectory()
    {
        var output = AiInstructions.Upsert("<!-- pacmon:start -->\nold\n<!-- pacmon:end -->\n", Notes.LegacyDirectoryName);
        Assert.AreEqual(AiInstructions.Block(Notes.LegacyDirectoryName) + "\n", output);
        // A start without an end is not a block: the new one is added after it.
        Assert.AreEqual(
            "<!-- pacmon:start -->\nno end\n\n" + AiInstructions.Block() + "\n",
            AiInstructions.Upsert("<!-- pacmon:start -->\nno end\n"));
    }
}
