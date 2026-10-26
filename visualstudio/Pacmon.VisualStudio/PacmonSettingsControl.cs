using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;
using Pacmon.Core;

namespace Pacmon.VisualStudio;

internal sealed class PacmonSettingsControl : ScrollViewer
{
    private readonly TextBlock coverageRatio = new();
    private readonly TextBlock coveragePath = new() { Opacity = 0.7, TextWrapping = TextWrapping.Wrap };
    private readonly TextBlock coverageStatus = new() { Opacity = 0.78, TextWrapping = TextWrapping.Wrap };
    private readonly ProgressBar coverageProgress = new() { Height = 4, Margin = new Thickness(0, 5, 0, 4) };
    private readonly TextBlock targetCount = new() { Opacity = 0.7 };
    private readonly CheckBox packageIcon = new();
    private readonly CheckBox navigation = new();
    private readonly CheckBox quickAction = new();
    private readonly Dictionary<DecorationMode, RadioButton> decorations = new();
    private readonly Dictionary<InlineSource, RadioButton> inlineSources = new();
    private readonly Dictionary<NoteEntryMode, RadioButton> noteEntries = new();
    private readonly Dictionary<MonorepoMode, RadioButton> monorepoModes = new();
    private readonly Button openNotes;
    private readonly Button openManifest;
    private readonly Button searchDependencies;
    private readonly Button normalizeNotes;
    private readonly Action<string> statusChanged;
    private bool syncing;

    public PacmonSettingsControl(
        Func<Task> openNotesAction,
        Func<Task> openManifestAction,
        Func<Task> searchDependenciesAction,
        Func<Task> normalizeNotesAction,
        Func<Task> setupAiAction,
        Action<string> statusChanged)
    {
        this.statusChanged = statusChanged;
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled;

        var content = new StackPanel { Margin = new Thickness(2, 0, 2, 18) };
        content.Children.Add(CoverageSection());
        content.Children.Add(ClickTargetsSection());
        content.Children.Add(ChoiceSection(
            "Note editor",
            "Where a note is written when you open one from a dependency manifest.",
            noteEntries,
            new[]
            {
                Choice(NoteEntryMode.ToolWindow, "Tool window", "A multi-line Markdown editor in the Depos tool window."),
                Choice(NoteEntryMode.QuickInput, "Quick input", "A one-line input box for fast human notes."),
                Choice(NoteEntryMode.OpenBeside, "Open beside", "Create the section and open the Markdown notes file beside the manifest."),
            },
            value => Update(options => options.NoteEntry = value, statusChanged)));
        content.Children.Add(ChoiceSection(
            "Note markers",
            "End-of-line hint on dependencies that already have a note.",
            decorations,
            new[]
            {
                Choice(DecorationMode.Preview, "Preview", "Show the first line of the note at the end of the declaration."),
                Choice(DecorationMode.Badge, "Badge", "Show a compact ‘note’ marker instead of the note text."),
                Choice(DecorationMode.Off, "Off", "Do not show an end-of-line hint."),
            },
            value => Update(options => options.Decorations = value, statusChanged)));
        content.Children.Add(ChoiceSection(
            "Inline note source",
            "Which note layer supplies the end-of-line preview and leads the hover. The hover still shows both layers.",
            inlineSources,
            new[]
            {
                Choice(InlineSource.HumanFirst, "Human first", "What people wrote; the agent purpose when there is no human note."),
                Choice(InlineSource.AiFirst, "Agent first", "The agent purpose; what people wrote when there is no agent note."),
                Choice(InlineSource.HumanOnly, "Human only", "Only what people wrote."),
                Choice(InlineSource.AiOnly, "Agent only", "Only what agents wrote."),
            },
            value => Update(options => options.InlineSource = value, statusChanged)));
        content.Children.Add(ChoiceSection(
            "Workspace notes",
            "Which NuGet notes file owns a manifest in a monorepo.",
            monorepoModes,
            new[]
            {
                Choice(MonorepoMode.Nearest, "Nearest", "Use the closest notes file while walking toward the workspace root."),
                Choice(MonorepoMode.RootOnly, "Root only", "Use only the notes file at the solution or workspace root."),
            },
            value => Update(options => options.Monorepo = value, statusChanged)));

        var actions = new StackPanel();
        openNotes = ActionButton("Open NuGet dependency notes", "Open or create the notes file for the current manifest.", openNotesAction);
        openManifest = ActionButton("Open dependency manifest", "Open the project or central package manifest these notes describe.", openManifestAction);
        searchDependencies = ActionButton("Search dependencies…", "Pick any documented or undocumented dependency and open its note.", searchDependenciesAction);
        normalizeNotes = ActionButton("Format notes file", "Sort sections and canonicalize headings without changing prose.", normalizeNotesAction);
        actions.Children.Add(openNotes);
        actions.Children.Add(openManifest);
        actions.Children.Add(searchDependencies);
        actions.Children.Add(normalizeNotes);
        actions.Children.Add(ActionButton(
            "Set up AI instructions",
            "Write the Depos agent rules and connect the workspace instruction files.",
            setupAiAction));
        content.Children.Add(Section("Actions", null, actions));

        var reset = new Button
        {
            Content = "Reset to defaults",
            HorizontalAlignment = HorizontalAlignment.Left,
            Padding = new Thickness(9, 3, 9, 3),
        };
        reset.Click += (_, _) =>
        {
            var runtime = PacmonRuntime.Current;
            if (runtime is null) return;
            var options = runtime.Options;
            options.Decorations = DecorationMode.Preview;
            options.InlineSource = InlineSource.HumanFirst;
            options.NoteEntry = NoteEntryMode.ToolWindow;
            options.MarginIcon = true;
            options.Navigation = true;
            options.QuickAction = true;
            options.Monorepo = MonorepoMode.Nearest;
            options.SaveSettingsToStorage();
            SyncFromOptions();
            runtime.NotifyChanged();
            statusChanged("Settings reset to defaults");
        };
        content.Children.Add(Section("Reset", "Restore every setting shown in this panel.", reset));

        PacmonVisuals.ApplyNativeControlStyles(content);
        Content = content;
        SyncFromOptions();
    }

    public void SyncFromOptions()
    {
        var runtime = PacmonRuntime.Current;
        if (runtime is null) return;
        syncing = true;
        try
        {
            var options = runtime.Options;
            packageIcon.IsChecked = options.MarginIcon;
            navigation.IsChecked = options.Navigation;
            quickAction.IsChecked = options.QuickAction;
            Check(decorations, options.Decorations);
            Check(inlineSources, options.InlineSource);
            Check(noteEntries, options.NoteEntry);
            Check(monorepoModes, options.Monorepo);
            UpdateTargetCount();
        }
        finally
        {
            syncing = false;
        }
    }

    public void SetCoverage(CoverageContext? context)
    {
        if (context is null)
        {
            coverageRatio.Text = "Open a supported NuGet manifest to see its coverage.";
            coveragePath.Text = string.Empty;
            coverageStatus.Text = string.Empty;
            coverageProgress.Maximum = 1;
            coverageProgress.Value = 0;
            SetActionsEnabled(false, false);
            return;
        }

        var documented = new HashSet<string>(
            context.Analysis.Documented.Select(item => item.NoteKey),
            StringComparer.OrdinalIgnoreCase);
        var count = context.Dependencies.Count;
        var missing = Math.Max(0, count - documented.Count);
        coverageRatio.Text = $"{documented.Count} of {count}";
        coveragePath.Text = Path.GetFileName(context.ManifestPath);
        coverageStatus.Text = count == 0
            ? "This manifest has no supported direct dependencies."
            : missing == 0
                ? "Every dependency has a note."
                : missing == 1
                    ? "1 dependency has no note yet."
                    : $"{missing} dependencies have no note yet.";
        coverageProgress.Maximum = Math.Max(1, count);
        coverageProgress.Value = documented.Count;
        SetActionsEnabled(true, context.Notes is not null);
    }

    private FrameworkElement CoverageSection()
    {
        var header = new DockPanel();
        coverageRatio.FontWeight = FontWeights.SemiBold;
        DockPanel.SetDock(coverageRatio, Dock.Right);
        header.Children.Add(coverageRatio);
        header.Children.Add(Heading("Coverage"));
        var body = new StackPanel();
        body.Children.Add(header);
        body.Children.Add(coveragePath);
        body.Children.Add(coverageProgress);
        body.Children.Add(coverageStatus);
        return new Border { Child = body, Margin = new Thickness(0, 0, 0, 20) };
    }

    private FrameworkElement ClickTargetsSection()
    {
        packageIcon.Content = ToggleBody(
            "Icon before the dependency",
            "click",
            "The Depos mark is filled when a note exists and hollow when it does not.",
            PreviewWithMark());
        navigation.Content = ToggleBody(
            "The package name",
            "Ctrl+click",
            "The package identifier opens its note without adding text to the manifest.",
            PreviewWithLink());
        quickAction.Content = ToggleBody(
            "Lightbulb on the cursor line",
            "two clicks",
            "The quietest option: Visual Studio shows the Quick Action only on the current line.",
            PreviewWithQuickAction());
        foreach (var toggle in new[] { packageIcon, navigation, quickAction })
        {
            toggle.HorizontalContentAlignment = HorizontalAlignment.Stretch;
            toggle.Margin = new Thickness(0, 5, 0, 5);
            toggle.Checked += ClickTargetChanged;
            toggle.Unchecked += ClickTargetChanged;
        }

        var header = new DockPanel();
        DockPanel.SetDock(targetCount, Dock.Right);
        header.Children.Add(targetCount);
        header.Children.Add(Heading("Click targets"));
        var body = new StackPanel();
        body.Children.Add(header);
        body.Children.Add(Lede("How you open a dependency’s note from its manifest. Right-click always works too."));
        body.Children.Add(packageIcon);
        body.Children.Add(navigation);
        body.Children.Add(quickAction);
        return new Border { Child = body, Margin = new Thickness(0, 0, 0, 20) };
    }

    private void ClickTargetChanged(object sender, RoutedEventArgs args)
    {
        if (syncing) return;
        UpdateTargetCount();
        Update(options =>
        {
            options.MarginIcon = packageIcon.IsChecked == true;
            options.Navigation = navigation.IsChecked == true;
            options.QuickAction = quickAction.IsChecked == true;
        }, statusChanged);
    }

    private void UpdateTargetCount()
    {
        var count = new[] { packageIcon, navigation, quickAction }.Count(item => item.IsChecked == true);
        targetCount.Text = $"{count} of 3";
    }

    private static FrameworkElement ToggleBody(string title, string gesture, string help, FrameworkElement preview)
    {
        var titleRow = new DockPanel();
        var badge = new Border
        {
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(6, 1, 6, 1),
            Child = new TextBlock { Text = gesture, FontSize = 10, Opacity = 0.78 },
        };
        badge.SetResourceReference(Border.BackgroundProperty, EnvironmentColors.ToolWindowCodeBlockBackgroundBrushKey);
        DockPanel.SetDock(badge, Dock.Right);
        titleRow.Children.Add(badge);
        titleRow.Children.Add(new TextBlock { Text = title, FontWeight = FontWeights.SemiBold });
        var body = new StackPanel { Margin = new Thickness(7, 0, 0, 0) };
        body.Children.Add(titleRow);
        body.Children.Add(preview);
        body.Children.Add(Lede(help, new Thickness(0, 4, 0, 0)));
        return body;
    }

    private static FrameworkElement PreviewWithMark()
    {
        var line = PreviewLine();
        line.Children.Add(new PacmonMarkControl { Documented = true, Width = 12, Height = 12, Margin = new Thickness(0, 2, 5, 0) });
        line.Children.Add(Code("<PackageReference Include=\"Newtonsoft.Json\" />"));
        return PreviewBorder(line);
    }

    private static FrameworkElement PreviewWithLink()
    {
        var line = PreviewLine();
        line.Children.Add(Code("<PackageReference Include=\""));
        line.Children.Add(new TextBlock
        {
            Text = "Newtonsoft.Json",
            FontFamily = new System.Windows.Media.FontFamily("Consolas"),
            TextDecorations = TextDecorations.Underline,
        });
        line.Children.Add(Code("\" />"));
        return PreviewBorder(line);
    }

    private static FrameworkElement PreviewWithQuickAction()
    {
        var line = PreviewLine();
        line.Children.Add(new TextBlock { Text = "◉", Margin = new Thickness(0, 0, 5, 0), Opacity = 0.8 });
        line.Children.Add(Code("<PackageReference Include=\"Newtonsoft.Json\" />"));
        return PreviewBorder(line);
    }

    private static StackPanel PreviewLine() => new()
    {
        Orientation = Orientation.Horizontal,
        VerticalAlignment = VerticalAlignment.Center,
    };

    private static TextBlock Code(string text) => new()
    {
        Text = text,
        FontFamily = new System.Windows.Media.FontFamily("Consolas"),
        FontSize = 11.5,
    };

    private static Border PreviewBorder(FrameworkElement child)
    {
        var border = new Border
        {
            Child = child,
            Padding = new Thickness(7, 4, 7, 4),
            Margin = new Thickness(0, 5, 0, 0),
            BorderThickness = new Thickness(1),
        };
        PacmonVisuals.ApplyBorderTheme(border);
        border.SetResourceReference(Border.BackgroundProperty, EnvironmentColors.ToolWindowCodeBlockBackgroundBrushKey);
        return border;
    }

    private static FrameworkElement ChoiceSection<T>(
        string title,
        string help,
        IDictionary<T, RadioButton> controls,
        IEnumerable<(T Value, string Label, string Help)> choices,
        Action<T> changed) where T : notnull
    {
        var body = new StackPanel();
        body.Children.Add(Heading(title));
        body.Children.Add(Lede(help));
        var group = $"pacmon-{typeof(T).Name}-{Guid.NewGuid():N}";
        foreach (var choice in choices)
        {
            var radio = new RadioButton
            {
                GroupName = group,
                Content = ChoiceBody(choice.Label, choice.Help),
                Margin = new Thickness(0, 4, 0, 4),
                HorizontalContentAlignment = HorizontalAlignment.Stretch,
            };
            radio.Checked += (_, _) => changed(choice.Value);
            controls[choice.Value] = radio;
            body.Children.Add(radio);
        }
        return new Border { Child = body, Margin = new Thickness(0, 0, 0, 20) };
    }

    private static FrameworkElement ChoiceBody(string label, string help)
    {
        var body = new StackPanel { Margin = new Thickness(6, 0, 0, 0) };
        body.Children.Add(new TextBlock { Text = label, FontFamily = new System.Windows.Media.FontFamily("Consolas") });
        body.Children.Add(Lede(help, new Thickness(0, 1, 0, 0)));
        return body;
    }

    private static (T Value, string Label, string Help) Choice<T>(T value, string label, string help) =>
        (value, label, help);

    private static FrameworkElement Section(string title, string? help, FrameworkElement content)
    {
        var body = new StackPanel();
        body.Children.Add(Heading(title));
        if (!string.IsNullOrWhiteSpace(help)) body.Children.Add(Lede(help!));
        body.Children.Add(content);
        return new Border { Child = body, Margin = new Thickness(0, 0, 0, 20) };
    }

    private static TextBlock Heading(string text) => new()
    {
        Text = text.ToUpperInvariant(),
        FontSize = 13.5,
        FontWeight = FontWeights.SemiBold,
        Margin = new Thickness(0, 0, 0, 4),
    };

    private static TextBlock Lede(string text, Thickness? margin = null) => new()
    {
        Text = text,
        TextWrapping = TextWrapping.Wrap,
        Opacity = 0.72,
        Margin = margin ?? new Thickness(0, 0, 0, 5),
    };

    private static Button ActionButton(string title, string help, Func<Task> action)
    {
        var body = new StackPanel();
        body.Children.Add(new TextBlock { Text = title, FontWeight = FontWeights.SemiBold });
        body.Children.Add(Lede(help, new Thickness(0, 1, 0, 0)));
        var button = new Button
        {
            Content = body,
            HorizontalContentAlignment = HorizontalAlignment.Left,
            Padding = new Thickness(8, 6, 8, 6),
            Margin = new Thickness(0, 1, 0, 1),
        };
        button.Click += (_, _) => Run(action);
        return button;
    }

    private static void Check<T>(IReadOnlyDictionary<T, RadioButton> controls, T value) where T : notnull
    {
        if (controls.TryGetValue(value, out var control)) control.IsChecked = true;
    }

    private void Update(Action<PacmonOptionsPage> change, Action<string> statusChanged)
    {
        if (syncing) return;
        var runtime = PacmonRuntime.Current;
        if (runtime is null) return;
        change(runtime.Options);
        runtime.Options.SaveSettingsToStorage();
        runtime.NotifyChanged();
        statusChanged("Settings saved");
    }

    private void SetActionsEnabled(bool hasManifest, bool hasNotes)
    {
        openNotes.IsEnabled = hasManifest;
        openManifest.IsEnabled = hasManifest;
        searchDependencies.IsEnabled = hasManifest;
        normalizeNotes.IsEnabled = hasNotes;
    }

    private static void Run(Func<Task> action) => ThreadHelper.JoinableTaskFactory.Run(action);
}

internal sealed class DependencyPickerDialog : DialogWindow
{
    private readonly TextBox search = new();
    private readonly ListBox results = new();
    private readonly IReadOnlyList<DependencyRow> rows;
    private DependencyRow? selected;

    public DependencyPickerDialog(CoverageContext context)
    {
        Title = "Depos — Search dependencies";
        Width = 540;
        Height = 460;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        var documented = new HashSet<string>(context.Analysis.Documented.Select(item => item.NoteKey), StringComparer.OrdinalIgnoreCase);
        rows = context.Dependencies
            .Select(item => new DependencyRow(item, documented.Contains(item.NoteKey)))
            .OrderBy(item => item.Label, StringComparer.OrdinalIgnoreCase)
            .ToArray();

        search.Margin = new Thickness(0, 0, 0, 8);
        search.TextChanged += (_, _) => RefreshResults();
        results.MouseDoubleClick += (_, _) => Accept();
        results.PreviewKeyDown += (_, args) =>
        {
            if (args.Key != Key.Enter) return;
            Accept();
            args.Handled = true;
        };

        var open = new Button { Content = "Open note", IsDefault = true, MinWidth = 88, Margin = new Thickness(8, 0, 0, 0) };
        var cancel = new Button { Content = "Cancel", IsCancel = true, MinWidth = 80, Margin = new Thickness(8, 0, 0, 0) };
        open.Click += (_, _) => Accept();
        var buttons = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 10, 0, 0) };
        buttons.Children.Add(open);
        buttons.Children.Add(cancel);
        var panel = new Grid { Margin = new Thickness(14) };
        panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        panel.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        panel.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Grid.SetRow(search, 0);
        Grid.SetRow(results, 1);
        Grid.SetRow(buttons, 2);
        panel.Children.Add(search);
        panel.Children.Add(results);
        panel.Children.Add(buttons);
        PacmonVisuals.ApplyNativeControlStyles(panel);
        Content = panel;
        Loaded += (_, _) =>
        {
            RefreshResults();
            search.Focus();
        };
    }

    public DependencyRow? Selected => selected;

    private void RefreshResults()
    {
        var term = search.Text.Trim();
        results.Items.Clear();
        foreach (var row in rows.Where(row => term.Length == 0 || row.Label.IndexOf(term, StringComparison.OrdinalIgnoreCase) >= 0))
        {
            var content = new DockPanel();
            var scope = new TextBlock { Text = row.Scope, Opacity = 0.68, Margin = new Thickness(10, 0, 0, 0) };
            DockPanel.SetDock(scope, Dock.Right);
            content.Children.Add(scope);
            content.Children.Add(new PacmonMarkControl
            {
                Documented = row.Documented,
                Width = 13,
                Height = 13,
                Margin = new Thickness(0, 2, 7, 0),
            });
            content.Children.Add(new TextBlock { Text = row.Label, FontWeight = FontWeights.SemiBold });
            var item = new ListBoxItem
            {
                Content = content,
                Tag = row,
                Padding = new Thickness(5, 4, 5, 4),
                HorizontalContentAlignment = HorizontalAlignment.Stretch,
            };
            results.Items.Add(item);
        }
        if (results.Items.Count > 0) results.SelectedIndex = 0;
    }

    private void Accept()
    {
        if (results.SelectedItem is not ListBoxItem { Tag: DependencyRow row }) return;
        selected = row;
        DialogResult = true;
        Close();
    }
}
