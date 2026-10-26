using System.Text.RegularExpressions;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Depos.Core.Tests;

[TestClass]
public sealed class NotesTests
{
    [TestMethod]
    public void CreatesNugetV2FileAndMatchesCaseInsensitively()
    {
        var text = Notes.NewFile("Newtonsoft.Json", "JSON serialization", "- purpose: JSON");
        var model = Notes.Parse(text);

        Assert.AreEqual(Notes.FormatVersion, model.Frontmatter?.FormatVersion);
        Assert.AreEqual(Notes.Ecosystem, model.Frontmatter?.Ecosystem);
        Assert.AreEqual("Newtonsoft.Json", Notes.FindSection(model, "NEWTONSOFT.JSON")?.Name);
    }

    [TestMethod]
    public void UpsertPreservesDisplayNameAndGeneratedLayer()
    {
        var original = Notes.NewFile("Newtonsoft.Json", "Old", "- purpose: JSON")
            .TrimEnd() + "\n\n### Generated\n\nDo not edit\n";

        var updated = Notes.UpsertLayers(original, "newtonsoft.json", "New", "- purpose: serializer");
        var model = Notes.Parse(updated);
        var section = Notes.FindSection(model, "NEWTONSOFT.JSON")!;
        var layers = Notes.Layers(model, section);

        Assert.AreEqual("Newtonsoft.Json", section.Name);
        Assert.AreEqual("New", layers.Human);
        Assert.AreEqual("- purpose: serializer", layers.Agent);
        StringAssert.Contains(layers.Generated, "### Generated");
        StringAssert.Contains(layers.Generated, "Do not edit");
    }

    [TestMethod]
    public void CoverageTreatsEmptySectionsAsUndocumentedAndKeepsRemovedNotes()
    {
        var text = Notes.NewFile().TrimEnd() + "\n\n## Alpha\n\n## Gone\n\n### Agent notes\n\n- status: removed 2026-09 — replaced\n";
        var dependencies = NugetManifest.ExtractDependencies("<PackageReference Include=\"alpha\" />", "App.csproj");

        var analysis = Notes.Analyze(dependencies, Notes.Parse(text));

        Assert.AreEqual(0, analysis.Documented.Count);
        Assert.AreEqual(1, analysis.Undocumented.Count);
        Assert.AreEqual(0, analysis.Orphans.Count);
        Assert.AreEqual(1, analysis.Removed.Count);
    }

    [TestMethod]
    public void LintFindsFrontmatterDuplicatesAndAgentProblems()
    {
        const string text = """
            ---
            format: dependency-notes/2
            ecosystem: cargo
            lang: en
            ---
            # Dependency Notes

            ## Alpha

            ### Agent notes

            - purpos: thing
            - verify:

            ## alpha
            duplicate
            """;

        var findings = Notes.Lint(Notes.Parse(text), new[] { "Alpha" });

        CollectionAssert.IsSubsetOf(
            new[] { "wrongEcosystem", "duplicateSection", "unknownAgentKey", "emptyAgentValue" },
            findings.Select(finding => finding.Kind).ToArray());
    }

    [TestMethod]
    public void PreviewRespectsLayerPreference()
    {
        var layers = new SectionLayers("Human first\nSecond", "- purpose: Agent purpose", string.Empty);

        Assert.AreEqual("Human first", Notes.Preview(layers, InlineSource.HumanFirst));
        Assert.AreEqual("Agent purpose", Notes.Preview(layers, InlineSource.AiFirst));
        Assert.AreEqual("Human first", Notes.Preview(layers, InlineSource.HumanOnly));
        Assert.AreEqual("Agent purpose", Notes.Preview(layers, InlineSource.AiOnly));
    }

    [TestMethod]
    public void AgentFixPreservesUnknownFieldsAndReportsRemainingEmptyValues()
    {
        const string input = "- purpos: JSON serialization\n- verify:\n- custom: // intentionally ignored\n- runtime: server";

        var fixedText = Notes.FixAgentText(input);
        var findings = Notes.LintAgentText(fixedText);

        StringAssert.Contains(fixedText, "- note: purpos: JSON serialization");
        StringAssert.Contains(fixedText, "- custom: // intentionally ignored");
        StringAssert.Contains(fixedText, "- runtime: server");
        CollectionAssert.AreEqual(
            new[] { "emptyAgentValue" },
            findings.Select(finding => finding.Kind).ToArray());
    }

    [TestMethod]
    public void NormalizePreservesBomAndCrlfWithoutDoublingCarriageReturns()
    {
        var original = "\ufeff" + Notes.NewFile("Beta", "Second").Replace("\r\n", "\n").Replace("\n", "\r\n")
            + "\r\n## Alpha\r\n\r\nFirst\r\n";

        var normalized = Notes.Normalize(original);

        Assert.AreEqual('\ufeff', normalized[0]);
        Assert.IsFalse(normalized.Contains("\r\r\n"));
        Assert.IsTrue(normalized.IndexOf("## Alpha", StringComparison.Ordinal) < normalized.IndexOf("## Beta", StringComparison.Ordinal));
    }

    [TestMethod]
    public void AgentRulesListTheFieldsTheLintAccepts()
    {
        // The rules agents are given, assets/AGENT-RULES.md embedded, name
        // exactly the fields the lint accepts: the core ones, then the others.
        var keys = Regex.Matches(AgentRules.Text, "^\\| `([a-z-]+):` \\|", RegexOptions.Multiline)
            .Cast<Match>()
            .Select(match => match.Groups[1].Value)
            .ToArray();

        CollectionAssert.AreEqual(Notes.AgentFieldKeys.ToArray(), keys);
    }

    [TestMethod]
    public void LintAcceptsEveryFieldAndChecksEnumeratedValues()
    {
        static string ValidValue(string key) => key switch
        {
            "runtime" => "server, build",
            "exposure" => "untrusted-input / internal",
            "status" => "removed 2026-01 — replaced by System.Text.Json",
            "verified" => "v13.0.3",
            _ => "something true",
        };
        static string[] Kinds(string agent) => Notes
            .Lint(Notes.Parse(Notes.NewFile("Alpha", "Human", agent)), Array.Empty<string>())
            .Select(finding => finding.Kind)
            .ToArray();

        var everyField = string.Join("\n", Notes.AgentFieldKeys.Select(key => $"- {key}: {ValidValue(key)}"));

        CollectionAssert.AreEqual(Array.Empty<string>(), Kinds(everyField));
        CollectionAssert.AreEqual(
            new[] { "badAgentValue", "badAgentValue", "badAgentValue", "badAgentValue" },
            Kinds("- runtime: net8.0\n- exposure: public\n- status: gone\n- verified: latest"));
    }

    [TestMethod]
    public void NewNotesAreAlreadyInCanonicalForm()
    {
        var text = Notes.UpsertLayers(Notes.NewFile(), "Alpha", "Human", "- purpose: JSON");

        Assert.AreEqual(Notes.NewFile(), Notes.Normalize(Notes.NewFile()));
        Assert.AreEqual(text, Notes.Normalize(text));
    }

    [TestMethod]
    public void NormalizeKeepsDuplicatesTheIntroductionAndTheFrontmatter()
    {
        // The VS Code formatter (src/core/serialize.ts) turns this input into
        // exactly this output: docs/format.md's canonical form, which changes
        // nothing but the order, the blank lines and the format's own lines.
        const string input = """
            ---
            format: dependency-notes/2
            ecosystem: nuget
            team: platform
            ---
            <!-- an old header comment -->
            # Dependency Notes

            Packages of the billing service.

            ## Serilog

            Structured logging.

            ## Newtonsoft.Json

            First note.

            ## newtonsoft.json


            Second note.

            ### Agent notes

            - risk: parses partner webhooks


            """;
        const string expected = """
            ---
            format: dependency-notes/2
            ecosystem: nuget
            team: platform
            lang: en
            ---

            <!-- Each "## name" below is a package from the nuget dependency manifest.
              The text under it is written by people. "### Agent notes" and everything below
              it is written by AI agents — rules in .pacmon/AGENT-RULES.md. -->

            # Dependency Notes

            Packages of the billing service.

            ## Newtonsoft.Json

            First note.

            ## newtonsoft.json

            Second note.

            ### Agent notes

            - risk: parses partner webhooks

            ## Serilog

            Structured logging.

            """;

        Assert.AreEqual(expected, Notes.Normalize(input));
        Assert.AreEqual(expected, Notes.Normalize(expected));
    }
}
