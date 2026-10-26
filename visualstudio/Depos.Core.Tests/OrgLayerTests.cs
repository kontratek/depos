using Depos.Core.Org;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Depos.Core.Tests;

/// <summary>The counterpart of <c>src/test/unit/orgLayer.test.ts</c> and <c>OrgLayerTest.kt</c>.</summary>
[TestClass]
public sealed class OrgLayerTests
{
    private const string Org = "01HORG0000000000000000000O";
    private const string Expiry = "2099-01-01T00:00:00.000Z";
    private static readonly long After = DateTimeOffset.Parse("2099-01-01T00:00:00Z").ToUnixTimeMilliseconds();

    private const string DefaultPolicies =
        "[{\"ecosystem\":\"nuget\",\"mode\":\"enforce\",\"decisions\":["
        + "{\"noteKey\":\"serilog\",\"decision\":\"allow\",\"reason\":\"Logging.\",\"expiresAt\":\"" + Expiry + "\"},"
        + "{\"noteKey\":\"left-pad\",\"decision\":\"deny\",\"reason\":\"Use string.PadLeft.\",\"expiresAt\":null}]},"
        + "{\"ecosystem\":\"python\",\"mode\":\"audit\",\"decisions\":[{\"noteKey\":\"django-rest\",\"decision\":\"allow\",\"reason\":\"\",\"expiresAt\":null}]}]";

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
    public void AnAnswerOfAnotherShapeIsRefusedWhole()
    {
        foreach (var text in new[] { "null", "[]", "\"x\"" }) Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(text)), text);
        Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(Answer().Replace("{\"ulid\":\"" + Org + "\",\"name\":\"Kontra\"}", "null"))));
        Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(Answer(pagePath: "https://evil.example/x"))));
        Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(Answer(pagePath: "//evil.example/x"))));
        Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(Answer(DefaultPolicies.Replace("\"enforce\"", "\"block\"")))));
        Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(Answer(DefaultPolicies.Replace("\"deny\"", "\"maybe\"")))));
        var longReason = "[{\"ecosystem\":\"nuget\",\"mode\":\"audit\",\"decisions\":[{\"noteKey\":\"a\",\"decision\":\"deny\",\"reason\":\""
            + new string('x', 100_001) + "\",\"expiresAt\":null}]}]";
        Assert.IsNull(OrgLayers.Parse(DeposJson.Parse(Answer(longReason))));
    }

    [TestMethod]
    public void AllowedAndDeniedComeWithTheirModeReasonAndExpiry()
    {
        var layer = Layer();
        Assert.AreEqual(new OrgResult(OrgResultKind.Allowed, PolicyMode.Enforce, "Logging.", Expiry), layer.Result("nuget", "Serilog", 0));
        var denied = layer.Result("nuget", "left-pad", 0)!;
        Assert.AreEqual(OrgResultKind.Denied, denied.Kind);
        Assert.IsTrue(denied.IsViolation);
    }

    [TestMethod]
    public void APackageWithoutADecisionIsNotListedAndThatIsAViolation()
    {
        var result = Layer().Result("nuget", "Polly", 0);
        Assert.AreEqual(new OrgResult(OrgResultKind.Unlisted, PolicyMode.Enforce), result);
        Assert.IsTrue(result!.IsViolation);
    }

    [TestMethod]
    public void AnExpiredDecisionReadsAsNotListedFromItsExpiryOn()
    {
        var layer = Layer();
        Assert.AreEqual(OrgResultKind.Allowed, layer.Result("nuget", "serilog", After - 1)?.Kind);
        Assert.AreEqual(OrgResultKind.Unlisted, layer.Result("nuget", "serilog", After)?.Kind);
        Assert.AreEqual(OrgResultKind.Denied, layer.Result("nuget", "left-pad", long.MaxValue)?.Kind);
    }

    [TestMethod]
    public void ExpiriesAreReadAsDatesOrTimesAndAnythingElseNeverExpires()
    {
        Assert.AreEqual(After, OrgLayers.EpochMillis("2099-01-01"));
        Assert.AreEqual(After, OrgLayers.EpochMillis("2099-01-01T03:00:00+03:00"));
        Assert.IsNull(OrgLayers.EpochMillis("2099-01-01T00:00:00"));
        Assert.IsNull(OrgLayers.EpochMillis("1/2/2099"));
    }

    [TestMethod]
    public void AnEcosystemThatIsNotAuditedShowsNothing() => Assert.IsNull(Layer().Result("cargo", "serde", 0));

    [TestMethod]
    public void ManifestNamesMatchTheStoredKeys()
    {
        var layer = Layer();
        Assert.AreEqual(OrgResultKind.Allowed, layer.Result("nuget", "SERILOG", 0)?.Kind);
        Assert.AreEqual(OrgResultKind.Allowed, layer.Result("python", "Django_Rest", 0)?.Kind);
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
        var allowed = OrgView.Of(Layer(), "https://depos.example.com", received, "nuget", "Serilog", _ => "10:00", 0)!;
        Assert.AreEqual("Logging.", allowed.Reason);
        Assert.AreEqual("2099-01-01", allowed.Expires);
        Assert.AreEqual($"https://depos.example.com/dashboard/{Org}/dependencies/nuget/serilog", allowed.Link);
        Assert.AreEqual("Updated from Depos at 10:00", allowed.Received);
        Assert.AreEqual("Allowlist: Allowed (Enforce) — Reason: Logging. · Expires 2099-01-01", allowed.Line());
        Assert.AreEqual("Allowlist: Allowed (Enforce) · Reason: Logging. · Expires 2099-01-01", allowed.Tooltip());

        var unlisted = OrgView.Of(Layer(), "https://depos.example.com", received, "nuget", "Polly", _ => "10:00", 0)!;
        Assert.IsNull(unlisted.Reason);
        Assert.IsNull(unlisted.Expires);
        Assert.AreEqual("Allowlist: Not listed (Enforce)", unlisted.Line());

        Assert.IsNull(OrgView.Of(Layer(), "https://depos.example.com", received, "cargo", "serde", _ => "10:00", 0));
    }
}
