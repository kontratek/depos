using Microsoft.VisualStudio.TestTools.UnitTesting;
using Depos.Core;

namespace Depos.VisualStudio.Tests;

[TestClass]
public sealed class VisualStudioModelTests
{
    [TestMethod]
    public void CoverageContextUsesCaseInsensitiveNugetNotes()
    {
        var dependencies = NugetManifest.ExtractDependencies(
            "<PackageVersion Include=\"Newtonsoft.Json\" />",
            "Directory.Packages.props");
        var notes = Notes.Parse(Notes.NewFile("NEWTONSOFT.JSON", "JSON serialization"));

        var context = new CoverageContext("Directory.Packages.props", "C:\\repo", "notes.md", dependencies, notes);

        Assert.AreEqual(1, context.Analysis.Documented.Count);
        Assert.AreEqual(0, context.Analysis.Undocumented.Count);
    }

    [TestMethod]
    public void DependencyRowsExposeCoverageAndScope()
    {
        var dependency = NugetManifest.ExtractDependencies(
            "<GlobalPackageReference Include=\"Nerdbank.GitVersioning\" />",
            "Directory.Packages.props")[0];

        var documented = new DependencyRow(dependency, true);
        var undocumented = new DependencyRow(dependency, false);

        Assert.IsTrue(documented.Documented);
        Assert.IsFalse(undocumented.Documented);
        Assert.AreEqual("globalPackageReference", documented.Scope);
    }

    [TestMethod]
    public void ToolWindowPreservesAgentExpansionOnlyForTheSamePackage()
    {
        Assert.IsTrue(ToolWindowState.PreserveAgentExpansion("Newtonsoft.Json", "newtonsoft.json", true));
        Assert.IsFalse(ToolWindowState.PreserveAgentExpansion("Newtonsoft.Json", "Serilog", true));
        Assert.IsFalse(ToolWindowState.PreserveAgentExpansion("Newtonsoft.Json", "Newtonsoft.Json", false));
    }

    [DataTestMethod]
    [DataRow("C:\\repo\\.pacmon\\nuget\\DEPENDENCY-NOTES.md")]
    [DataRow("C:/repo/.pacmon/nuget/DEPENDENCY-NOTES.md")]
    public void RecognizesOnlyNugetNotesPath(string path) => Assert.IsTrue(DeposRuntime.IsNotesPath(path));

    [TestMethod]
    public void RejectsOtherEcosystemNotesPath() =>
        Assert.IsFalse(DeposRuntime.IsNotesPath("C:/repo/.pacmon/cargo/DEPENDENCY-NOTES.md"));

    [TestMethod]
    public void InlineAdornmentAnchorsPreviewAtTheOpeningTagsLineEnd()
    {
        const string xml = """
            <Project>
              <ItemGroup>
                <PackageReference
                    Include="Newtonsoft.Json"
                    Version="13.0.3" />
              </ItemGroup>
            </Project>
            """;
        var dependency = NugetManifest.ExtractDependencies(xml, "App.csproj").Single();

        var anchor = EditorFeatureHelpers.DeclarationLineEnd(xml, dependency.DeclarationRange);

        Assert.AreEqual(xml.IndexOf('\n', dependency.DeclarationRange.Offset + dependency.DeclarationRange.Length), anchor);
        Assert.AreEqual('>', xml[anchor - 1]);
        Assert.AreEqual('<', xml[dependency.IconRange.Offset]);
    }

    [TestMethod]
    public void InlineAdornmentAnchorsSingleLinePreviewAfterTheClosingBracket()
    {
        const string xml = "  <PackageReference Include=\"Serilog\" Version=\"3.1.1\" />\r\n";
        var dependency = NugetManifest.ExtractDependencies(xml, "App.csproj").Single();

        var anchor = EditorFeatureHelpers.DeclarationLineEnd(xml, dependency.DeclarationRange);

        Assert.AreEqual(xml.IndexOf('\r'), anchor);
        Assert.AreEqual('>', xml[anchor - 1]);
    }

    [TestMethod]
    public void DeposMarkPaletteMatchesVsCodeColors()
    {
        Assert.AreEqual(0x00ff66, DeposMarkPalette.Rgb(true, true));
        Assert.AreEqual(0x00662f, DeposMarkPalette.Rgb(true, false));
        Assert.AreEqual(0x9d9d9d, DeposMarkPalette.Rgb(false, true));
        Assert.AreEqual(0x8c8c8c, DeposMarkPalette.Rgb(false, false));
        Assert.IsTrue(DeposMarkPalette.IsDark(30, 30, 30));
        Assert.IsFalse(DeposMarkPalette.IsDark(245, 245, 245));
    }

    [TestMethod]
    public void InlinePreviewModesMatchVsCodeFormatting()
    {
        var layers = new SectionLayers("Human note", "Agent note", string.Empty);

        Assert.AreEqual(
            "▪ Human note",
            EditorFeatureHelpers.InlinePreviewText(true, DecorationMode.Preview, layers, InlineSource.HumanFirst));
        Assert.AreEqual(
            "▪ note",
            EditorFeatureHelpers.InlinePreviewText(true, DecorationMode.Badge, layers, InlineSource.HumanFirst));
        Assert.IsNull(EditorFeatureHelpers.InlinePreviewText(true, DecorationMode.Off, layers, InlineSource.HumanFirst));
        Assert.IsNull(EditorFeatureHelpers.InlinePreviewText(false, DecorationMode.Preview, layers, InlineSource.HumanFirst));
    }

}
