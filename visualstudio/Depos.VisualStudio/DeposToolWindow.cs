using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;

namespace Depos.VisualStudio;

[Guid("DB7399A1-CA23-48D4-9741-59644D8B2D3D")]
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
