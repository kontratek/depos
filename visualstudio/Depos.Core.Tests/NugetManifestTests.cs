using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Depos.Core.Tests;

[TestClass]
public sealed class NugetManifestTests
{
    [DataTestMethod]
    [DataRow("App.csproj")]
    [DataRow("App.fsproj")]
    [DataRow("App.vbproj")]
    [DataRow("Directory.Packages.props")]
    public void MatchesSupportedPaths(string path) => Assert.IsTrue(NugetManifest.MatchesPath(path));

    [DataTestMethod]
    [DataRow("packages.config")]
    [DataRow("Directory.Build.props")]
    [DataRow("App.cs")]
    public void RejectsUnsupportedPaths(string path) => Assert.IsFalse(NugetManifest.MatchesPath(path));

    [TestMethod]
    public void ReadsProjectPackageReferencesAndPreservesRanges()
    {
        const string xml = """
            <Project xmlns="urn:test">
              <ItemGroup Condition="'$(TargetFramework)' == 'net9.0'">
                <PackageReference
                    Include="Newtonsoft.Json"
                    Version="13.0.3" />
                <x:PackageReference x:Include="Serilog" />
              </ItemGroup>
            </Project>
            """;

        var dependencies = NugetManifest.ExtractDependencies(xml, "App.csproj");

        CollectionAssert.AreEqual(new[] { "Newtonsoft.Json", "Serilog" }, dependencies.Select(item => item.DisplayName).ToArray());
        foreach (var dependency in dependencies)
        {
            Assert.AreEqual(dependency.DisplayName, xml.Substring(dependency.PrimaryRange.Offset, dependency.PrimaryRange.Length));
            Assert.AreEqual("<", xml.Substring(dependency.IconRange.Offset, dependency.IconRange.Length));
            Assert.IsTrue(xml.Substring(dependency.DeclarationRange.Offset, dependency.DeclarationRange.Length).EndsWith(">"));
        }
    }

    [TestMethod]
    public void PreservesTheCompleteOpeningTagForInlinePreviewPlacement()
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
        var declaration = xml.Substring(dependency.DeclarationRange.Offset, dependency.DeclarationRange.Length);

        Assert.AreEqual("<PackageReference\n        Include=\"Newtonsoft.Json\"\n        Version=\"13.0.3\" />", declaration);
    }

    [TestMethod]
    public void ReadsCentralVersionsAndGlobalReferences()
    {
        const string xml = """
            <Project>
              <ItemGroup>
                <PackageVersion Include="Alpha" Version="1" />
                <PackageVersion Update='Beta' Version="2" />
                <GlobalPackageReference Include="Gamma" Version="3" />
              </ItemGroup>
            </Project>
            """;

        var dependencies = NugetManifest.ExtractDependencies(xml, "Directory.Packages.props");

        CollectionAssert.AreEqual(new[] { "Alpha", "Beta", "Gamma" }, dependencies.Select(item => item.NoteKey).ToArray());
        CollectionAssert.AreEqual(
            new[] { "centralVersion", "centralVersion", "globalPackageReference" },
            dependencies.Select(item => item.Scope).ToArray());
    }

    [TestMethod]
    public void ExcludesUnsupportedAndDynamicDeclarations()
    {
        const string xml = """
            <Project><ItemGroup>
              <PackageReference Update="Project.Update" />
              <PackageReference Remove="Removed" Include="Also.Removed" />
              <PackageReference Include="$(DynamicPackage)" />
              <PackageDownload Include="Download" />
              <ProjectReference Include="Other.csproj" />
              <FrameworkReference Include="Microsoft.AspNetCore.App" />
            </ItemGroup></Project>
            """;

        Assert.AreEqual(0, NugetManifest.ExtractDependencies(xml, "App.csproj").Count);
    }

    [TestMethod]
    public void HandlesEntitiesCommentsCdataAndMalformedXml()
    {
        const string xml = """
            <Project><!-- <PackageReference Include="Ignored" /> -->
              <![CDATA[<PackageReference Include="Also.Ignored" />]]>
              <PackageReference Include="Alpha&#46;Beta" />
              <PackageReference Include="Still.Found">
            """;

        var dependencies = NugetManifest.ExtractDependencies(xml, "App.csproj");

        CollectionAssert.AreEqual(new[] { "Alpha.Beta", "Still.Found" }, dependencies.Select(item => item.NoteKey).ToArray());
    }

    [TestMethod]
    public void DeduplicatesCaseInsensitivelyWithCentralFirst()
    {
        var central = NugetManifest.ExtractDependencies("<PackageVersion Include=\"Newtonsoft.Json\" />", "Directory.Packages.props");
        var project = NugetManifest.ExtractDependencies("<PackageReference Include=\"NEWTONSOFT.JSON\" />", "App.csproj");

        var unique = NugetManifest.Unique(central.Concat(project));

        Assert.AreEqual(1, unique.Count);
        Assert.AreEqual("Newtonsoft.Json", unique[0].DisplayName);
        Assert.AreEqual("centralVersion", unique[0].Scope);
    }
}
