using System.ComponentModel;
using Microsoft.VisualStudio.Shell;
using Pacmon.Core;

namespace Pacmon.VisualStudio;

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

public sealed class PacmonOptionsPage : DialogPage
{
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
}
