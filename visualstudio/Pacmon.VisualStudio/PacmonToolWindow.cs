using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;

namespace Pacmon.VisualStudio;

[Guid("AF380955-B17D-4614-A349-BC9E50C29A6E")]
public sealed class PacmonToolWindow : ToolWindowPane
{
    public PacmonToolWindow() : base(null)
    {
        Caption = "Depos Dependency Notes";
        var control = new PacmonToolWindowControl();
        control.CaptionChanged += caption => Caption = caption;
        Content = control;
    }
}
