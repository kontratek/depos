using Depos.Core.Org;
using Microsoft.VisualStudio.TestTools.UnitTesting;
using Newtonsoft.Json;

namespace Depos.Core.Tests;

/// <summary>The counterpart of <c>src/test/unit/orgNotes.test.ts</c> and <c>OrgNotesTest.kt</c>.</summary>
[TestClass]
public sealed class OrgNotesTests
{
    private const string Repo = "01HREPO0000000000000000000";

    internal static string Note(
        string ulid,
        string name,
        string? human = null,
        string ecosystem = "nuget",
        string fields = "[]",
        string scope = "{\"kind\":\"all\"}") =>
        $"{{\"ulid\":\"{ulid}\",\"ecosystem\":\"{ecosystem}\",\"noteKey\":\"{name.ToLowerInvariant()}\",\"displayName\":\"{name}\","
        + $"\"humanText\":{JsonConvert.ToString(human ?? $"Why {name}.")},\"fields\":{fields},"
        + $"\"scope\":{scope},\"updatedAt\":\"2026-10-01T10:00:00.000Z\",\"updatedByName\":\"Ada\"}}";

    internal static string Sync(string changes, bool full = true, bool canEdit = true, string cursor = "2026-10-01T10:00:00.000Z|01H", bool more = false) =>
        $"{{\"organization\":{{\"ulid\":\"01HORG\",\"name\":\"Kontra\"}},\"canEdit\":{(canEdit ? "true" : "false")},"
        + $"\"full\":{(full ? "true" : "false")},\"changes\":[{changes}],\"cursor\":\"{cursor}\",\"more\":{(more ? "true" : "false")}}}";

    private static OrgNotesSync Parse(string text) => OrgNotes.ParseSync(DeposJson.Parse(text))!;

    [TestMethod]
    public void ASyncAnswerIsRead()
    {
        var page = OrgNotes.ParseSync(DeposJson.Parse(Sync(
            $"{{\"kind\":\"upsert\",\"note\":{Note("u1", "Serilog")}}},{{\"kind\":\"delete\",\"ulid\":\"u2\",\"ecosystem\":\"nuget\",\"noteKey\":\"polly\"}}")));
        Assert.IsNotNull(page);
        Assert.AreEqual(2, page!.Changes.Count);
        Assert.AreEqual("Kontra", page.OrgName);
        Assert.IsTrue(page.CanEdit);
    }

    [TestMethod]
    public void AnAnswerOfAnotherShapeIsRefusedWhole()
    {
        Assert.IsNull(OrgNotes.ParseSync(DeposJson.Parse("null")));
        Assert.IsNull(OrgNotes.ParseSync(DeposJson.Parse(Sync("").Replace("\"canEdit\":true", "\"canEdit\":\"yes\""))));
        Assert.IsNull(OrgNotes.ParseSync(DeposJson.Parse(Sync("{\"kind\":\"rename\"}"))));
        Assert.IsNull(OrgNotes.ParseSync(DeposJson.Parse(Sync($"{{\"kind\":\"upsert\",\"note\":{Note("u1", "Serilog", scope: "{\"kind\":\"some\"}")}}}"))));
        Assert.IsNull(OrgNotes.ParseSync(DeposJson.Parse(Sync($"{{\"kind\":\"upsert\",\"note\":{Note("u1", "Serilog", human: new string('x', 100_001))}}}"))));
    }

    [TestMethod]
    public void ACopyIsLoadedFromItsFirstPageOn()
    {
        var copy = new OrgNotesCopy("01HORG");
        Assert.IsFalse(copy.Loaded);
        Assert.IsTrue(copy.Apply(Parse(Sync("")), 42));
        Assert.IsTrue(copy.Loaded);
        Assert.IsTrue(copy.CanEdit);
        Assert.AreEqual(42, copy.ReceivedAt);
    }

    [TestMethod]
    public void AFullSyncReplacesTheCopy()
    {
        var copy = new OrgNotesCopy("01HORG");
        copy.Apply(Parse(Sync($"{{\"kind\":\"upsert\",\"note\":{Note("u1", "Polly")}}}")), 1);
        copy.Apply(Parse(Sync($"{{\"kind\":\"upsert\",\"note\":{Note("u2", "Serilog")}}}")), 2);
        Assert.IsNull(copy.Note("nuget", "Polly", Repo));
        Assert.IsNotNull(copy.Note("nuget", "Serilog", Repo));
    }

    [TestMethod]
    public void ADeleteRemovesOnlyTheNoteItNames()
    {
        var copy = new OrgNotesCopy("01HORG");
        copy.Apply(Parse(Sync($"{{\"kind\":\"upsert\",\"note\":{Note("old", "Serilog")}}}")), 1);
        copy.Apply(Parse(Sync(
            $"{{\"kind\":\"delete\",\"ulid\":\"old\",\"ecosystem\":\"nuget\",\"noteKey\":\"serilog\"}},{{\"kind\":\"upsert\",\"note\":{Note("new", "Serilog")}}}",
            full: false)), 2);
        Assert.AreEqual("new", copy.Note("nuget", "Serilog", Repo)?.Ulid);
        // A late delete of the old note must not take the newer one with it.
        copy.Apply(Parse(Sync("{\"kind\":\"delete\",\"ulid\":\"old\",\"ecosystem\":\"nuget\",\"noteKey\":\"serilog\"}", full: false)), 3);
        Assert.AreEqual("new", copy.Note("nuget", "Serilog", Repo)?.Ulid);
    }

    [TestMethod]
    public void AManifestNameFindsItsNoteTheWayDeposStoresIt()
    {
        var copy = new OrgNotesCopy("01HORG");
        copy.Apply(Parse(Sync($"{{\"kind\":\"upsert\",\"note\":{Note("u1", "Newtonsoft.Json")}}}")), 1);
        Assert.IsNotNull(copy.Note("nuget", "NEWTONSOFT.JSON", Repo));
        Assert.AreEqual("django-rest", DeposEcosystems.NormalizeName("Django_Rest", "python"));
        Assert.AreEqual("Serde", DeposEcosystems.NormalizeName(" \"Serde\" ", "cargo"));
    }

    [TestMethod]
    public void ANoteScopedToOtherRepositoriesIsNotThisOnes()
    {
        var copy = new OrgNotesCopy("01HORG");
        copy.Apply(Parse(Sync($"{{\"kind\":\"upsert\",\"note\":{Note("u1", "Serilog", scope: "{\"kind\":\"repos\",\"repositoryUlids\":[\"01HOTHER\"]}")}}}")), 1);
        Assert.IsNull(copy.Note("nuget", "Serilog", Repo));
        Assert.IsNotNull(copy.Note("nuget", "Serilog", "01HOTHER"));
    }

    [TestMethod]
    public void ASnapshotRoundTripsAndADamagedOneIsRefused()
    {
        var copy = new OrgNotesCopy("01HORG");
        copy.Apply(Parse(Sync($"{{\"kind\":\"upsert\",\"note\":{Note("u1", "Serilog", fields: "[{\"key\":\"purpose\",\"value\":\"Logging\"}]")}}}")), 7);
        var text = OrgNotes.SnapshotJson(copy.Snapshot());
        var back = OrgNotes.ParseSnapshot(DeposJson.Parse(text));
        Assert.IsNotNull(back);
        Assert.AreEqual(text, OrgNotes.SnapshotJson(back!));
        Assert.IsTrue(new OrgNotesCopy("01HORG", back).Loaded);
        Assert.IsNull(OrgNotes.ParseSnapshot(DeposJson.Parse(text.Replace("\"humanText\"", "\"human\""))));
    }

    [TestMethod]
    public void TheNotesTextReadsBackAsANotesFileWithNoProblems()
    {
        var copy = new OrgNotesCopy("01HORG");
        copy.Apply(Parse(Sync(string.Join(",",
            $"{{\"kind\":\"upsert\",\"note\":{Note("u1", "Polly")}}}",
            $"{{\"kind\":\"upsert\",\"note\":{Note("u2", "Serilog", human: "Logging.\n# not a title\n  ## not a section", fields: "[{\"key\":\"purpose\",\"value\":\"Structured\\nlogs\"},{\"key\":\"owner\",\"value\":\"platform\"}]")}}}",
            $"{{\"kind\":\"upsert\",\"note\":{Note("u3", "serde", ecosystem: "cargo")}}}",
            $"{{\"kind\":\"upsert\",\"note\":{Note("u4", "Dapper", scope: "{\"kind\":\"repos\",\"repositoryUlids\":[\"01HOTHER\"]}")}}}"))), 1);

        var text = copy.NotesText("nuget", Repo);
        StringAssert.StartsWith(text, "---\nformat: dependency-notes/2\necosystem: nuget\nlang: en\n---\n");
        StringAssert.Contains(text, "<!-- Notes of Kontra, from Depos.");
        var model = Notes.Parse(text);
        CollectionAssert.AreEqual(new[] { "Polly", "Serilog" }, model.Sections.Select(section => section.Name).ToArray());
        var layers = Notes.Layers(model, Notes.FindSection(model, "serilog")!);
        Assert.AreEqual("Logging.\n\\# not a title\n  \\## not a section", layers.Human);
        Assert.AreEqual("- purpose: Structured logs\n- owner: platform", layers.Agent);
        Assert.AreEqual(0, Notes.Lint(model, new[] { "Polly", "Serilog" }).Count);
    }

    [TestMethod]
    public void AgentLinesThatAreNotFieldsAreCountedNotKept()
    {
        var (fields, dropped) = OrgNotes.AgentTextToFields("- purpose: HTTP\r\nSome prose.\n\n- Owner: platform");
        CollectionAssert.AreEqual(new[] { new OrgNoteField("purpose", "HTTP"), new OrgNoteField("owner", "platform") }, fields.ToArray());
        Assert.AreEqual(1, dropped);
        Assert.AreEqual("- purpose: a b\n- owner: x", OrgNotes.FieldsToAgentText(new[] { new OrgNoteField("purpose", "a\nb"), new OrgNoteField("owner", "x") }));
    }
}
