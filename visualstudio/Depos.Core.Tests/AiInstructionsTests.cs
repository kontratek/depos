using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Depos.Core.Tests;

/// <summary>The pointer block, as <c>src/core/template.ts</c> writes it.</summary>
[TestClass]
public sealed class AiInstructionsTests
{
    [TestMethod]
    public void TheBlockIsThreeLinesBetweenMarkers()
    {
        var lines = AiInstructions.Block().Split('\n');
        Assert.AreEqual(5, lines.Length);
        Assert.AreEqual("<!-- pacmon:start -->", lines[0]);
        Assert.AreEqual("<!-- pacmon:end -->", lines[4]);
        StringAssert.Contains(lines[1], "`.pacmon/nuget/DEPENDENCY-NOTES.md` for .NET/NuGet");
        StringAssert.Contains(lines[2], "`.pacmon/AGENT-RULES.md`");
    }

    [TestMethod]
    public void TheBlockIsAppendedOnceAndReplacedAfter()
    {
        var once = AiInstructions.Upsert("# Agents\n");
        Assert.AreEqual("# Agents\n\n" + AiInstructions.Block() + "\n", once);
        Assert.AreEqual(once, AiInstructions.Upsert(once));
        Assert.AreEqual(AiInstructions.Block() + "\n", AiInstructions.Upsert(string.Empty));
        Assert.AreEqual("text\n\n" + AiInstructions.Block() + "\n", AiInstructions.Upsert("text"));
    }

    [TestMethod]
    public void AnOldBlockIsReplaced()
    {
        var old = "before\n<!-- pacmon:deps-notes:start -->\nold\n<!-- pacmon:deps-notes:end -->\nafter\n";
        Assert.AreEqual("before\n" + AiInstructions.Block() + "\nafter\n", AiInstructions.Upsert(old));
    }
}
