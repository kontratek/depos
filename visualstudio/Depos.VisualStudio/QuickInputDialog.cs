using System.Windows;
using System.Windows.Controls;
using Microsoft.VisualStudio.PlatformUI;

namespace Depos.VisualStudio;

internal sealed class QuickInputDialog : DialogWindow
{
    private readonly TextBox input;

    public QuickInputDialog(string packageName, string existing)
    {
        Title = $"Dependency note — {packageName}";
        Width = 520;
        Height = 190;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;

        input = new TextBox
        {
            Text = existing,
            Margin = new Thickness(0, 8, 0, 12),
            AcceptsReturn = false,
            VerticalContentAlignment = VerticalAlignment.Center,
        };
        var save = new Button { Content = "Save", IsDefault = true, MinWidth = 80, Margin = new Thickness(8, 0, 0, 0) };
        var cancel = new Button { Content = "Cancel", IsCancel = true, MinWidth = 80, Margin = new Thickness(8, 0, 0, 0) };
        save.Click += (_, _) => { DialogResult = true; Close(); };
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        buttons.Children.Add(save);
        buttons.Children.Add(cancel);
        var panel = new StackPanel { Margin = new Thickness(16) };
        panel.Children.Add(new TextBlock { Text = "Why is this dependency here?", FontWeight = FontWeights.SemiBold });
        panel.Children.Add(input);
        panel.Children.Add(buttons);
        DeposVisuals.ApplyNativeControlStyles(panel);
        Content = panel;
        Loaded += (_, _) => { input.Focus(); input.SelectAll(); };
    }

    public string Value => input.Text.Trim();
}
