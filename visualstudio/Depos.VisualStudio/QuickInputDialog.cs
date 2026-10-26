using System.Windows;
using System.Windows.Controls;
using Microsoft.VisualStudio.PlatformUI;

namespace Depos.VisualStudio;

internal sealed class QuickInputDialog : DialogWindow
{
    private readonly TextBox input;

    public QuickInputDialog(string packageName, string existing)
        : this($"Dependency note — {packageName}", "Why is this dependency here?", existing)
    {
    }

    private QuickInputDialog(string title, string question, string existing)
    {
        Title = title;
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
        panel.Children.Add(new TextBlock { Text = question, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap });
        panel.Children.Add(input);
        panel.Children.Add(buttons);
        DeposVisuals.ApplyNativeControlStyles(panel);
        Content = panel;
        Loaded += (_, _) => { input.Focus(); input.SelectAll(); };
    }

    /// <summary>A one-line answer to any question, such as the Depos address.</summary>
    public static QuickInputDialog Text(string title, string question, string existing) => new(title, question, existing);

    public string Value => input.Text.Trim();
}

/// <summary>Picks one of a few items, such as the folder whose MCP setup to copy.</summary>
internal sealed class ChoiceDialog : DialogWindow
{
    private readonly ListBox list = new() { MinHeight = 120 };

    private ChoiceDialog(string title, IEnumerable<string> labels)
    {
        Title = title;
        Width = 420;
        Height = 300;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        foreach (var label in labels) list.Items.Add(label);
        list.SelectedIndex = 0;
        list.MouseDoubleClick += (_, _) => Accept();
        var ok = new Button { Content = "OK", IsDefault = true, MinWidth = 80, Margin = new Thickness(8, 0, 0, 0) };
        var cancel = new Button { Content = "Cancel", IsCancel = true, MinWidth = 80, Margin = new Thickness(8, 0, 0, 0) };
        ok.Click += (_, _) => Accept();
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 10, 0, 0) };
        buttons.Children.Add(ok);
        buttons.Children.Add(cancel);
        var panel = new DockPanel { Margin = new Thickness(14) };
        DockPanel.SetDock(buttons, Dock.Bottom);
        panel.Children.Add(buttons);
        panel.Children.Add(list);
        DeposVisuals.ApplyNativeControlStyles(panel);
        Content = panel;
        Loaded += (_, _) => list.Focus();
    }

    /// <summary>The chosen item, or null when the dialog was cancelled.</summary>
    public static T? Pick<T>(string title, IReadOnlyList<T> items, Func<T, string> label) where T : class
    {
        var dialog = new ChoiceDialog(title, items.Select(label));
        return dialog.ShowModal() == true && dialog.list.SelectedIndex >= 0 ? items[dialog.list.SelectedIndex] : null;
    }

    private void Accept()
    {
        if (list.SelectedIndex < 0) return;
        DialogResult = true;
        Close();
    }
}

/// <summary>Which instruction files get the three-line pointer to <c>.pacmon/AGENT-RULES.md</c>.</summary>
internal sealed class AiInstructionsTargetsDialog : DialogWindow
{
    private readonly List<(string Target, CheckBox Box)> boxes = new();

    public AiInstructionsTargetsDialog(string root)
    {
        Title = "Set Up AI Instructions";
        Width = 520;
        Height = 280;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var panel = new StackPanel { Margin = new Thickness(16) };
        panel.Children.Add(new TextBlock { Text = "Write dependency-notes format instructions into:", FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 8) });
        // The same list, in the same order, as the other editors; an existing file is ticked so its block is refreshed.
        foreach (var target in Depos.Core.AiInstructions.Targets)
        {
            var exists = System.IO.File.Exists(System.IO.Path.Combine(root, target));
            var box = new CheckBox
            {
                Content = exists ? $"{target} — exists, block will be updated" : $"{target} — will be created",
                IsChecked = exists || target == "AGENTS.md",
                Margin = new Thickness(0, 3, 0, 3),
            };
            boxes.Add((target, box));
            panel.Children.Add(box);
        }
        var ok = new Button { Content = "OK", IsDefault = true, MinWidth = 80, Margin = new Thickness(8, 0, 0, 0) };
        var cancel = new Button { Content = "Cancel", IsCancel = true, MinWidth = 80, Margin = new Thickness(8, 0, 0, 0) };
        ok.Click += (_, _) => { DialogResult = true; Close(); };
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 12, 0, 0) };
        buttons.Children.Add(ok);
        buttons.Children.Add(cancel);
        panel.Children.Add(buttons);
        DeposVisuals.ApplyNativeControlStyles(panel);
        Content = panel;
    }

    public IReadOnlyList<string> SelectedTargets => boxes.Where(item => item.Box.IsChecked == true).Select(item => item.Target).ToArray();
}
