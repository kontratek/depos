using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;

namespace Depos.VisualStudio;

// The GUID from before Pacmon became Depos: Visual Studio keeps where the window is docked under it.
[Guid("AF380955-B17D-4614-A349-BC9E50C29A6E")]
public sealed class DeposToolWindow : ToolWindowPane
{
    public DeposToolWindow() : base(null)
    {
        Caption = "Depos Dependency Notes";
        var control = new DeposToolWindowControl();
        control.CaptionChanged += caption => Caption = caption;
        Content = control;
    }
}
