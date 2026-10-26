using System.ComponentModel;
using Microsoft.VisualStudio.Shell;
using Depos.Core;
using Depos.Core.Org;

namespace Depos.VisualStudio;

public enum DecorationMode
{
    Preview,
    Badge,
    Off,
}

public enum NoteEntryMode
{
    ToolWindow,
    QuickInput,
    OpenBeside,
}

public sealed class DeposOptionsPage : DialogPage
{
    /// <summary>
    /// Visual Studio keeps each option under the page's type name and the
    /// property's ("Pacmon.VisualStudio.PacmonOptionsPage.Decorations"), the type
    /// from before Pacmon became Depos: the options set then are read, and kept,
    /// under that name.
    /// </summary>
    public DeposOptionsPage() => SharedSettingsStorePath = "Pacmon.VisualStudio.PacmonOptionsPage";

    [Category("Display")]
    [DisplayName("Decorations")]
    [Description("Show a note preview, a compact badge, or nothing at the end of dependency lines.")]
    [DefaultValue(DecorationMode.Preview)]
    public DecorationMode Decorations { get; set; } = DecorationMode.Preview;

    [Category("Display")]
    [DisplayName("Inline source")]
    [Description("Choose which note layer supplies the end-of-line preview.")]
    [DefaultValue(InlineSource.HumanFirst)]
    public InlineSource InlineSource { get; set; } = InlineSource.HumanFirst;

    [Category("Editing")]
    [DisplayName("Note entry")]
    [Description("Choose how Add/Edit Dependency Note opens the note.")]
    [DefaultValue(NoteEntryMode.ToolWindow)]
    public NoteEntryMode NoteEntry { get; set; } = NoteEntryMode.ToolWindow;

    [Category("Editor")]
    [DisplayName("Package icon")]
    [Description("Show a clickable Depos icon beside each supported package ID.")]
    [DefaultValue(true)]
    public bool MarginIcon { get; set; } = true;

    [Category("Editor")]
    [DisplayName("Ctrl+click navigation")]
    [DefaultValue(true)]
    public bool Navigation { get; set; } = true;

    [Category("Editor")]
    [DisplayName("Quick Action")]
    [DefaultValue(true)]
    public bool QuickAction { get; set; } = true;

    [Category("Workspace")]
    [DisplayName("Monorepo notes")]
    [Description("Use the nearest ecosystem notes file or only the workspace-root file.")]
    [DefaultValue(MonorepoMode.Nearest)]
    public MonorepoMode Monorepo { get; set; } = MonorepoMode.Nearest;

    [Category("Organization")]
    [DisplayName("Server address")]
    [Description(
        "For the optional organization connection (Tools → Depos → Sign In, or the Depos tool window). Signed in, a folder "
        + "whose GitHub repository is added to one of your organizations uses the organization's notes in Depos instead of "
        + "its notes files. Depos makes network requests only while you are signed in: for the commands, and to fetch the "
        + "notes of each folder (at start, when Visual Studio gets focus, and every 5 minutes). Must use https, except for "
        + "localhost.")]
    [DefaultValue(DeposServerUrl.Default)]
    public string DeposAddress { get; set; } = DeposServerUrl.Default;

    protected override void OnApply(PageApplyEventArgs e)
    {
        base.OnApply(e);
        if (e.ApplyBehavior == ApplyKind.Apply) DeposRuntime.Current?.Depos.AddressApplied();
    }
}
