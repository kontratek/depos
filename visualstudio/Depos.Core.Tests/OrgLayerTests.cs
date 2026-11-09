using Depos.Core.Org;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Depos.Core.Tests;

/// <summary>The counterpart of <c>src/test/unit/orgLayer.test.ts</c> and <c>OrgLayerTest.kt</c>.</summary>
[TestClass]
public sealed class OrgLayerTests
{
    private const string Org = "01HORG0000000000000000000O";

    private const string DefaultPolicies =
        "[{\"ecosystem\":\"nuget\",\"mode\":\"enforce\",\"decisions\":["
        + "{\"noteKey\":\"serilog\",\"decision\":\"allow\"},"
        + "{\"noteKey\":\"left-pad\",\"decision\":\"deny\"}]},"
        + "{\"ecosystem\":\"python\",\"mode\":\"audit\",\"decisions\":[{\"noteKey\":\"django-rest\",\"decision\":\"allow\"}]}]";

    internal static string Answer(string policies = DefaultPolicies, string pagePath = "/dashboard/" + Org + "/dependencies") =>
        "{\"organization\":{\"ulid\":\"" + Org + "\",\"name\":\"Kontra\"},\"repository\":{\"ulid\":\"01HREPO\",\"fullName\":\"kontratek/api\"},"
        + "\"dependencyPagePath\":\"" + pagePath + "\",\"policies\":" + policies + ",\"extra\":true}";

    private static OrgLayer Layer() => new(OrgLayers.Parse(DeposJson.Parse(Answer()))!);

    [TestMethod]
    public void TheFullAnswerIsReadExtraKeysDropped()
    {
        var data = OrgLayers.Parse(DeposJson.Parse(Answer()));
        Assert.IsNotNull(data);
        Assert.AreEqual("Kontra", data!.OrgName);
        Assert.AreEqual(2, data.Policies.Count);
    }

    [TestMethod]
    public void TheEmptyReasonAndExpiryThatDeposStillSendsForOlderReleasesAreAccepted()
    {
        var old = DefaultPolicies.Replace("\"decision\":\"allow\"}", "\"decision\":\"allow\",\"reason\":\"\",\"expiresAt\":null}");
        var data = OrgLayers.Parse(DeposJson.Parse(Answer(old)));
        Assert.IsNotNull(data);
        CollectionAssert.AreEqual(
            OrgLayers.Parse(DeposJson.Parse(Answer()))!.Policies.SelectMany(p => p.Decisions).ToList(),
            data!.Policies.SelectMany(p => p.Decisions).ToList());
    }

    [TestMethod]
    public void AnAnswerOfAnotherShapeIsRefusedWhole()
    {
        foreach (var text in new[] { "null", "[]", "\"x\"" }) Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(text)), text);
        Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(Answer().Replace("{\"ulid\":\"" + Org + "\",\"name\":\"Kontra\"}", "null"))));
        Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(Answer(pagePath: "https://evil.example/x"))));
        Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(Answer(pagePath: "//evil.example/x"))));
        Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(Answer(DefaultPolicies.Replace("\"enforce\"", "\"block\"")))));
        Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(Answer(DefaultPolicies.Replace("\"deny\"", "\"maybe\"")))));
        var longKey = "[{\"ecosystem\":\"nuget\",\"mode\":\"audit\",\"decisions\":[{\"noteKey\":\""
            + new string('x', 1_001) + "\",\"decision\":\"deny\"}]}]";
        Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(Answer(longKey))));
    }

    [TestMethod]
    public void AllowedAndDeniedComeWithTheirMode()
    {
        var layer = Layer();
        Assert.AreEqual(new OrgResult(OrgResultKind.Allowed, PolicyMode.Enforce), layer.Result("nuget", "Serilog"));
        var denied = layer.Result("nuget", "left-pad")!;
        Assert.AreEqual(OrgResultKind.Denied, denied.Kind);
        Assert.IsTrue(denied.IsViolation);
    }

    [TestMethod]
    public void APackageWithoutADecisionIsNotListedAndThatIsAViolation()
    {
        var result = Layer().Result("nuget", "Polly");
        Assert.AreEqual(new OrgResult(OrgResultKind.Unlisted, PolicyMode.Enforce), result);
        Assert.IsTrue(result!.IsViolation);
    }

    [TestMethod]
    public void AnEcosystemThatIsNotAuditedShowsNothing() => Assert.IsNull(Layer().Result("cargo", "serde"));

    [TestMethod]
    public void ManifestNamesMatchTheStoredKeys()
    {
        var layer = Layer();
        Assert.AreEqual(OrgResultKind.Allowed, layer.Result("nuget", "SERILOG")?.Kind);
        Assert.AreEqual(OrgResultKind.Allowed, layer.Result("python", "Django_Rest")?.Kind);
    }

    [TestMethod]
    public void ThePagePathKeepsASlashAndEncodesTheRest() =>
        Assert.AreEqual(
            $"/dashboard/{Org}/dependencies/npm/%40scope/pkg",
            OrgLayers.DependencyPagePath($"/dashboard/{Org}/dependencies", "npm", "@scope/pkg"));

    [TestMethod]
    public void TheViewSaysWhatTheHoverAndThePanelShow()
    {
        var received = DateTimeOffset.Parse("2026-10-20T10:00:00Z").ToUnixTimeMilliseconds();
        var allowed = OrgView.Of(Layer(), "https://depos.example.com", received, "nuget", "Serilog", _ => "10:00")!;
        Assert.AreEqual($"https://depos.example.com/dashboard/{Org}/dependencies/nuget/serilog", allowed.Link);
        Assert.AreEqual("Updated from Depos at 10:00", allowed.Received);
        Assert.AreEqual("Allowlist: Allowed (Enforce)", allowed.Line());
        Assert.AreEqual("Allowlist: Allowed (Enforce)", allowed.Tooltip());

        var unlisted = OrgView.Of(Layer(), "https://depos.example.com", received, "nuget", "Polly", _ => "10:00")!;
        Assert.AreEqual("Allowlist: Not listed (Enforce)", unlisted.Line());

        Assert.IsNull(OrgView.Of(Layer(), "https://depos.example.com", received, "cargo", "serde", _ => "10:00"));
    }

    private const string Packages =
        "[{\"ecosystem\":\"nuget\",\"noteKey\":\"serilog\",\"installedVersion\":\"3.1.0\",\"latestVersion\":\"4.0.0\",\"updateKind\":\"major\",\"outdated\":true,\"risk\":{\"level\":\"medium\",\"version\":\"3.1.0\"}},"
        + "{\"ecosystem\":\"nuget\",\"noteKey\":\"left-pad\",\"installedVersion\":\"1.0.0\",\"latestVersion\":\"2.0.0\",\"updateKind\":\"major\",\"outdated\":true,\"risk\":null},"
        + "{\"ecosystem\":\"cargo\",\"noteKey\":\"serde\",\"installedVersion\":null,\"latestVersion\":\"1.0.200\",\"updateKind\":null,\"outdated\":false,\"risk\":{\"level\":\"high\",\"version\":\"1.0.200\"}}]";

    private static string Versioned(string packages = Packages, string rule = "major") =>
        Answer(ReplaceFirst(DefaultPolicies, "\"mode\":\"enforce\"", "\"mode\":\"enforce\",\"versionRule\":\"" + rule + "\""))
            .Replace(",\"extra\":true}", ",\"extra\":true,\"packages\":" + packages + "}");

    private static string ReplaceFirst(string text, string from, string to)
    {
        var at = text.IndexOf(from, StringComparison.Ordinal);
        return text.Substring(0, at) + to + text.Substring(at + from.Length);
    }

    [TestMethod]
    public void TheVersionRuleAndTheVersionsAreReadAndAnOlderAnswerWithoutThemStillIs()
    {
        var data = OrgLayers.Parse(DeposJson.Parse(Versioned()))!;
        CollectionAssert.AreEqual(new[] { "major", "off" }, data.Policies.Select(p => p.VersionRule).ToArray());
        Assert.AreEqual(3, data.Packages.Count);
        Assert.AreEqual(0, OrgLayers.Parse(DeposJson.Parse(Answer()))!.Packages.Count);
    }

    [TestMethod]
    public void AVersionEntryOrValueThatIsNotUnderstoodIsLeftOutOnItsOwn()
    {
        const string odd = "[{\"ecosystem\":\"nuget\",\"noteKey\":\"serilog\",\"installedVersion\":42},"
            + "{\"ecosystem\":\"nuget\",\"noteKey\":\"polly\",\"installedVersion\":\"8.0.0\",\"latestVersion\":null,\"updateKind\":\"sideways\",\"outdated\":\"yes\",\"risk\":{\"level\":\"severe\",\"version\":\"8.0.0\"}},null]";
        var data = OrgLayers.Parse(DeposJson.Parse(Versioned(odd, "minor-only")))!;
        Assert.AreEqual("off", data.Policies[0].VersionRule);
        CollectionAssert.AreEqual(new[] { new OrgPackageVersion("nuget", "polly", "8.0.0", null, null, false, null) }, data.Packages.ToArray());
    }

    [TestMethod]
    public void OnlyAnAllowedPackageIsMarkedForTheVersionRule()
    {
        var layer = new OrgLayer(OrgLayers.Parse(DeposJson.Parse(Versioned()))!);
        Assert.IsTrue(layer.IsOutdated("nuget", "Serilog"));
        Assert.IsFalse(layer.IsOutdated("nuget", "left-pad"));
        Assert.IsFalse(layer.IsOutdated("nuget", "Polly"));
    }

    [TestMethod]
    public void TheViewShowsTheVersionsAndTheRiskInAnyMode()
    {
        var layer = new OrgLayer(OrgLayers.Parse(DeposJson.Parse(Versioned()))!);
        var outdated = OrgView.Of(layer, "https://depos.example.com", 0, "nuget", "Serilog", _ => "10:00")!;
        CollectionAssert.AreEqual(
            new[]
            {
                "Allowlist: Allowed (Enforce)",
                "Version rule: not met (Enforce)",
                "Installed at last scan: 3.1.0 · Latest: 4.0.0 (a major version behind)",
                "Risk: Medium (3.1.0)",
            },
            outdated.Lines().ToArray());
        Assert.AreEqual("Outdated", outdated.BadgeText());

        var notAudited = OrgView.Of(layer, "https://depos.example.com", 0, "cargo", "serde", _ => "10:00")!;
        Assert.IsNull(notAudited.Kind);
        CollectionAssert.AreEqual(new[] { "Latest: 1.0.200", "Risk: High (1.0.200)" }, notAudited.Lines().ToArray());
        Assert.AreEqual("High risk", notAudited.BadgeText());
    }
}
