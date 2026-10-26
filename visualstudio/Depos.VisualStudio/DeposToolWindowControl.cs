using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using Microsoft.VisualStudio.Shell;
using Depos.Core;

namespace Depos.VisualStudio;

internal sealed class DependencyRow
{
    public DependencyRow(DependencyEntry dependency, bool documented)
    {
        Dependency = dependency;
        Documented = documented;
        Label = dependency.DisplayName;
        Scope = dependency.Scope;
    }

    public DependencyEntry Dependency { get; }
    public bool Documented { get; }
    public string Label { get; }
    public string Scope { get; }
}

internal static class ToolWindowState
{
    internal static bool PreserveAgentExpansion(string? currentPackage, string nextPackage, bool expanded) =>
        expanded && string.Equals(currentPackage, nextPackage, StringComparison.OrdinalIgnoreCase);
}

internal sealed class NoteLayerControl : StackPanel
{
    private readonly MarkdownPresenter markdown = new();
    private readonly Border preview = new() { Padding = new Thickness(8), MinHeight = 58, Cursor = Cursors.IBeam };
    private readonly TextBox editor = new();
    private readonly Button edit = new() { Content = "Edit", Padding = new Thickness(8, 2, 8, 2) };
    private readonly string emptyText;
    private bool loading;

    public NoteLayerControl(string? title, string emptyText)
    {
        this.emptyText = emptyText;
        var titleRow = new DockPanel { Margin = new Thickness(0, 0, 0, 4), LastChildFill = true };
        DockPanel.SetDock(edit, Dock.Right);
        titleRow.Children.Add(edit);
        if (!string.IsNullOrWhiteSpace(title))
        {
            titleRow.Children.Add(new TextBlock
            {
                Text = title,
                FontWeight = FontWeights.SemiBold,
                VerticalAlignment = VerticalAlignment.Center,
            });
        }
        Children.Add(titleRow);

        DeposVisuals.ApplyBorderTheme(preview);
        DeposVisuals.ApplyPrimaryTextTheme(preview);
        preview.BorderThickness = new Thickness(1);
        preview.Child = markdown;
        preview.MouseLeftButtonDown += (_, _) => BeginEdit();
        Children.Add(preview);

        editor.AcceptsReturn = true;
        editor.AcceptsTab = true;
        editor.TextWrapping = TextWrapping.Wrap;
        editor.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        editor.MinHeight = 95;
        editor.Visibility = Visibility.Collapsed;
        DeposVisuals.ApplyPrimaryTextTheme(editor);
        editor.TextChanged += (_, _) =>
        {
            if (!loading) Changed?.Invoke(this, EventArgs.Empty);
        };
        editor.PreviewKeyDown += (_, args) =>
        {
            if (args.Key == Key.Escape || (args.Key == Key.Enter && Keyboard.Modifiers == ModifierKeys.Control))
            {
                EndEdit();
                CommitRequested?.Invoke(this, EventArgs.Empty);
                args.Handled = true;
            }
        };
        Children.Add(editor);
        edit.Click += EditClick;
        SetText(string.Empty);
    }

    public event EventHandler? Changed;
    public event EventHandler? CommitRequested;
    public string Text => editor.Text;

    public void SetText(string value)
    {
        loading = true;
        editor.Text = value ?? string.Empty;
        loading = false;
        RefreshPreview();
    }

    public void BeginEdit()
    {
        preview.Visibility = Visibility.Collapsed;
        editor.Visibility = Visibility.Visible;
        edit.Content = "Preview";
        edit.Click -= EditClick;
        edit.Click -= PreviewClick;
        edit.Click += PreviewClick;
        editor.Focus();
        editor.CaretIndex = editor.Text.Length;
    }

    public void EndEdit()
    {
        RefreshPreview();
        editor.Visibility = Visibility.Collapsed;
        preview.Visibility = Visibility.Visible;
        edit.Content = "Edit";
        edit.Click -= PreviewClick;
        edit.Click -= EditClick;
        edit.Click += EditClick;
    }

    public void RefreshPreview() => markdown.SetMarkdown(editor.Text, emptyText);

    private void EditClick(object sender, RoutedEventArgs args) => BeginEdit();
    private void PreviewClick(object sender, RoutedEventArgs args) => EndEdit();
}

public sealed class DeposToolWindowControl : UserControl
{
    private readonly ContentControl viewHost = new();
    private readonly Button settingsButton = new() { Content = "Settings", Padding = new Thickness(9, 3, 9, 3), Margin = new Thickness(0, 0, 6, 0) };
    private readonly Button refreshButton = new() { Content = "Refresh", Padding = new Thickness(9, 3, 9, 3) };
    private readonly Border footer = new() { Padding = new Thickness(0, 7, 0, 0) };
    private readonly TextBlock packageTitle = new();
    private readonly TextBlock packageScope = new() { Opacity = 0.7 };
    private readonly TextBlock notesPath = new() { Opacity = 0.7, TextWrapping = TextWrapping.Wrap };
    private readonly NoteLayerControl human = new("Your note", "Nothing written yet — click to write.");
    private readonly NoteLayerControl agent = new(null, "No agent notes yet — click to add.");
    private readonly Expander agentBox = new();
    private readonly TextBlock agentHeader = new();
    private readonly Border agentProblems = new() { Padding = new Thickness(8), Margin = new Thickness(0, 8, 0, 0) };
    private readonly TextBlock agentProblemsText = new() { TextWrapping = TextWrapping.Wrap };
    private readonly Button fixAgent = new() { Content = "Fix", Padding = new Thickness(9, 2, 9, 2), Margin = new Thickness(8, 0, 0, 0) };
    private readonly TextBlock saveStatus = new() { Opacity = 0.78 };
    private readonly Button openNotes = new() { Content = "Open notes file", Padding = new Thickness(8, 3, 8, 3) };
    private readonly Button save = new() { Content = "Save", Padding = new Thickness(12, 3, 12, 3), Margin = new Thickness(6, 0, 0, 0) };
    private readonly DispatcherTimer saveTimer;
    private DeposSettingsControl settingsView = null!;
    private FrameworkElement detailView = null!;
    private CoverageContext? context;
    private DependencyRow? selected;
    private bool loading;
    private bool subscribed;
    private bool dirty;
    private bool showingSettings = true;
    private bool initialized;
    private DateTime suppressReloadUntil;

    public DeposToolWindowControl()
    {
        saveTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(650) };
        saveTimer.Tick += (_, _) => Run(SaveCurrentAsync);
        var ui = BuildUi();
        DeposVisuals.ApplyNativeControlStyles(ui);
        Content = ui;
        Loaded += (_, _) => Run(OnLoadedAsync);
        Unloaded += (_, _) =>
        {
            if (subscribed && DeposRuntime.Current is { } runtime) runtime.Changed -= RuntimeChanged;
            subscribed = false;
            Run(SaveCurrentAsync);
        };
    }

    internal event Action<string>? CaptionChanged;

    public async Task SetContextAsync(string? manifestPath, string? packageName)
    {
        initialized = true;
        await SaveCurrentAsync();
        var runtime = DeposRuntime.Current;
        if (runtime is null) return;

        if (string.IsNullOrWhiteSpace(manifestPath) || string.IsNullOrWhiteSpace(packageName))
        {
            var active = await runtime.ActiveDependencyAsync();
            if (active is not null)
            {
                manifestPath ??= active.ManifestPath;
                packageName ??= active.Dependency.NoteKey;
            }
        }

        context = await runtime.CoverageAsync(manifestPath);
        RenderCoverage();
        if (context is null)
        {
            selected = null;
            RenderDetail();
            ShowSettingsView();
            return;
        }

        var dependency = packageName is null
            ? context.Dependencies.FirstOrDefault()
            : context.Dependencies.FirstOrDefault(item =>
                string.Equals(item.NoteKey, packageName, StringComparison.OrdinalIgnoreCase));
        dependency ??= context.Dependencies.FirstOrDefault();
        if (dependency is null)
        {
            selected = null;
            RenderDetail();
            ShowSettingsView();
            return;
        }

        var documented = context.Analysis.Documented.Any(item =>
            string.Equals(item.NoteKey, dependency.NoteKey, StringComparison.OrdinalIgnoreCase));
        await SelectAsync(new DependencyRow(dependency, documented));
    }

    public async Task ShowSettingsAsync()
    {
        initialized = true;
        await SaveCurrentAsync();
        var runtime = DeposRuntime.Current;
        if (runtime is null) return;
        context = await runtime.CoverageAsync(context?.ManifestPath);
        RenderCoverage();
        settingsView.SyncFromOptions();
        ShowSettingsView();
    }

    private Grid BuildUi()
    {
        var root = new Grid { Margin = new Thickness(10) };
        DeposVisuals.ApplyToolWindowTheme(root);
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var header = BuildHeader();
        Grid.SetRow(header, 0);
        root.Children.Add(header);

        detailView = BuildDetail();
        settingsView = BuildSettings();
        DeposVisuals.ApplyToolWindowViewTheme(detailView);
        DeposVisuals.ApplyToolWindowViewTheme(settingsView);
        viewHost.Content = settingsView;
        Grid.SetRow(viewHost, 1);
        root.Children.Add(viewHost);

        footer.Child = saveStatus;
        Grid.SetRow(footer, 2);
        root.Children.Add(footer);
        return root;
    }

    private FrameworkElement BuildHeader()
    {
        var header = new StackPanel { Margin = new Thickness(0, 0, 0, 10) };
        var titleRow = new DockPanel();
        refreshButton.Click += (_, _) => Run(async () =>
        {
            if (showingSettings) await ShowSettingsAsync();
            else await SetContextAsync(context?.ManifestPath, selected?.Dependency.NoteKey);
        });
        settingsButton.Click += (_, _) => Run(ShowSettingsAsync);
        DockPanel.SetDock(refreshButton, Dock.Right);
        DockPanel.SetDock(settingsButton, Dock.Right);
        titleRow.Children.Add(refreshButton);
        titleRow.Children.Add(settingsButton);
        var title = new StackPanel { Orientation = Orientation.Horizontal };
        title.Children.Add(new DeposMarkControl { Documented = true, Width = 16, Height = 16, Margin = new Thickness(0, 2, 7, 0) });
        title.Children.Add(new TextBlock { Text = "Depos", FontSize = 18, FontWeight = FontWeights.SemiBold });
        titleRow.Children.Add(title);
        header.Children.Add(titleRow);
        return header;
    }

    private DeposSettingsControl BuildSettings() => new(
        async () =>
        {
            var runtime = DeposRuntime.Current;
            if (runtime is not null && context is not null) await runtime.OpenNotesAsync(context.ManifestPath);
        },
        async () =>
        {
            var runtime = DeposRuntime.Current;
            if (runtime is not null && context is not null) await runtime.OpenFileAsync(context.ManifestPath);
        },
        ShowDependencyPickerAsync,
        async () =>
        {
            var runtime = DeposRuntime.Current;
            if (runtime is null || context?.Notes is null) return;
            await runtime.NormalizeNotesAsync(context.NotesPath);
            saveStatus.Text = "Notes file formatted";
        },
        async () =>
        {
            var runtime = DeposRuntime.Current;
            if (runtime is not null) await runtime.SetupAiInstructionsAsync();
        },
        status => saveStatus.Text = status);

    private FrameworkElement BuildDetail()
    {
        var body = new StackPanel();
        packageTitle.FontSize = 16;
        packageTitle.FontWeight = FontWeights.SemiBold;
        DeposVisuals.ApplyPrimaryTextTheme(packageTitle);
        DeposVisuals.ApplySecondaryTextTheme(packageScope);
        DeposVisuals.ApplySecondaryTextTheme(notesPath);
        DeposVisuals.ApplySecondaryTextTheme(saveStatus);
        body.Children.Add(packageTitle);
        body.Children.Add(packageScope);
        notesPath.Margin = new Thickness(0, 2, 0, 12);
        body.Children.Add(notesPath);

        human.Changed += LayerChanged;
        human.CommitRequested += (_, _) => Run(SaveCurrentAsync);
        body.Children.Add(human);

        agentHeader.FontWeight = FontWeights.SemiBold;
        agentBox.Header = agentHeader;
        agentBox.IsExpanded = false;
        agentBox.Margin = new Thickness(0, 12, 0, 0);
        var agentContent = new StackPanel { Margin = new Thickness(10, 5, 0, 0) };
        var agentHelp = new TextBlock
        {
            Text = "Written by AI agents as '- key: value' lines. Unknown fields can be preserved as note entries.",
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 0, 0, 7),
        };
        DeposVisuals.ApplySecondaryTextTheme(agentHelp);
        agentContent.Children.Add(agentHelp);
        agent.Changed += LayerChanged;
        agent.CommitRequested += (_, _) => Run(SaveCurrentAsync);
        agentContent.Children.Add(agent);
        DeposVisuals.ApplyBorderTheme(agentProblems);
        agentProblems.BorderThickness = new Thickness(1);
        var problemRow = new DockPanel();
        DockPanel.SetDock(fixAgent, Dock.Right);
        problemRow.Children.Add(fixAgent);
        problemRow.Children.Add(agentProblemsText);
        agentProblems.Child = problemRow;
        DeposVisuals.ApplyPrimaryTextTheme(agentHeader);
        DeposVisuals.ApplyPrimaryTextTheme(agentProblemsText);
        agentContent.Children.Add(agentProblems);
        agentBox.Content = agentContent;
        fixAgent.Click += (_, _) =>
        {
            agent.SetText(Notes.FixAgentText(agent.Text));
            agent.BeginEdit();
            LayerChanged(agent, EventArgs.Empty);
            Run(SaveCurrentAsync);
        };
        body.Children.Add(agentBox);

        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 12, 0, 0),
        };
        openNotes.Click += (_, _) => Run(async () =>
        {
            if (context is not null && selected is not null)
            {
                await SaveCurrentAsync();
                await DeposRuntime.Current!.EnsureSectionAndOpenAsync(context.ManifestPath, selected.Dependency.NoteKey);
            }
        });
        save.Click += (_, _) => Run(SaveCurrentAsync);
        buttons.Children.Add(openNotes);
        buttons.Children.Add(save);
        body.Children.Add(buttons);

        return new ScrollViewer
        {
            Content = body,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
        };
    }

    private async Task OnLoadedAsync()
    {
        var runtime = DeposRuntime.Current;
        if (runtime is null) return;
        if (!subscribed)
        {
            runtime.Changed += RuntimeChanged;
            subscribed = true;
        }
        if (!initialized)
        {
            initialized = true;
            await ShowSettingsAsync();
        }
    }

    private void RuntimeChanged(object sender, EventArgs args) => Run(async () =>
    {
        if (DateTime.UtcNow < suppressReloadUntil) return;
        if (showingSettings)
        {
            var runtime = DeposRuntime.Current;
            if (runtime is null) return;
            context = await runtime.CoverageAsync(context?.ManifestPath);
            RenderCoverage();
            settingsView.SyncFromOptions();
            return;
        }
        if (dirty || human.IsKeyboardFocusWithin || agent.IsKeyboardFocusWithin)
        {
            saveStatus.Text = "Workspace changed; your unsaved text is preserved.";
            return;
        }
        await SetContextAsync(context?.ManifestPath, selected?.Dependency.NoteKey);
    });

    private async Task SelectAsync(DependencyRow row)
    {
        var keepAgentExpanded = ToolWindowState.PreserveAgentExpansion(
            selected?.Dependency.NoteKey,
            row.Dependency.NoteKey,
            agentBox.IsExpanded);
        await SaveCurrentAsync();
        selected = row;
        loading = true;
        try
        {
            packageTitle.Text = row.Label;
            packageScope.Text = row.Scope;
            notesPath.Text = context is null ? string.Empty : context.NotesPath;
            var layers = new SectionLayers(string.Empty, string.Empty, string.Empty);
            if (context?.Notes is { } notes)
            {
                var section = Notes.FindSection(notes, row.Dependency.NoteKey);
                if (section is not null) layers = Notes.Layers(notes, section);
            }
            human.SetText(layers.Human);
            agent.SetText(layers.Agent);
            human.EndEdit();
            agent.EndEdit();
            agentBox.IsExpanded = keepAgentExpanded;
            dirty = false;
            saveStatus.Text = row.Documented ? "Saved" : "No note yet";
            UpdateAgentProblems();
        }
        finally
        {
            loading = false;
        }
        RenderDetail();
        ShowDetailView();
        if (!row.Documented) human.BeginEdit();
    }

    private void LayerChanged(object? sender, EventArgs args)
    {
        if (loading) return;
        dirty = true;
        saveStatus.Text = "Unsaved changes";
        saveTimer.Stop();
        saveTimer.Start();
        UpdateAgentProblems();
    }

    private async Task SaveCurrentAsync()
    {
        saveTimer.Stop();
        var runtime = DeposRuntime.Current;
        var currentContext = context;
        var current = selected;
        if (loading || !dirty || runtime is null || currentContext is null || current is null) return;
        var targetManifest = currentContext.ManifestPath;
        var targetPackage = current.Dependency.NoteKey;
        var humanText = human.Text;
        var agentText = agent.Text;
        dirty = false;
        saveStatus.Text = "Saving…";
        try
        {
            suppressReloadUntil = DateTime.UtcNow.AddSeconds(1);
            await runtime.SaveLayersAsync(targetManifest, targetPackage, humanText, agentText);
            if (selected?.Dependency.NoteKey == targetPackage && human.Text == humanText && agent.Text == agentText)
            {
                human.RefreshPreview();
                agent.RefreshPreview();
                saveStatus.Text = $"Saved at {DateTime.Now:HH:mm:ss}";
                var refreshed = await runtime.CoverageAsync(targetManifest);
                if (refreshed is not null)
                {
                    context = refreshed;
                    selected = new DependencyRow(current.Dependency, true);
                    RenderCoverage();
                }
            }
        }
        catch
        {
            dirty = true;
            saveStatus.Text = "Could not save. Your text is preserved.";
            throw;
        }
    }

    private void UpdateAgentProblems()
    {
        var findings = Notes.LintAgentText(agent.Text);
        var lineCount = agent.Text.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None).Count(line => !string.IsNullOrWhiteSpace(line));
        agentHeader.Text = lineCount == 0 ? "Agent notes" : $"Agent notes  {lineCount} lines";
        agentProblems.Visibility = findings.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
        if (findings.Count == 0) return;
        agentProblemsText.Text = string.Join("\n", findings.Select(finding => $"⚠ {finding.Message}"));
        fixAgent.Visibility = findings.Any(finding => finding.Kind == "unknownAgentKey")
            ? Visibility.Visible
            : Visibility.Collapsed;
    }

    private void RenderCoverage()
    {
        settingsView?.SetCoverage(context);
        if (showingSettings || context is null) return;
        var documented = new HashSet<string>(context.Analysis.Documented.Select(item => item.NoteKey), StringComparer.OrdinalIgnoreCase);
        var lintCount = context.Notes is null ? 0 : Notes.Lint(context.Notes, context.Dependencies.Select(item => item.NoteKey)).Count;
        var problemCount = lintCount + context.Analysis.Orphans.Count;
        CaptionChanged?.Invoke(problemCount == 0
            ? $"Depos — {documented.Count}/{context.Dependencies.Count}"
            : $"Depos — {documented.Count}/{context.Dependencies.Count}, {problemCount} problems");
    }

    private void ShowSettingsView()
    {
        showingSettings = true;
        DeposVisuals.ApplyToolWindowViewTheme(settingsView);
        viewHost.Content = settingsView;
        settingsButton.Visibility = Visibility.Collapsed;
        saveStatus.Text = string.Empty;
        CaptionChanged?.Invoke("Depos — Settings");
    }

    private void ShowDetailView()
    {
        showingSettings = false;
        DeposVisuals.ApplyToolWindowViewTheme(detailView);
        viewHost.Content = detailView;
        settingsButton.Visibility = Visibility.Visible;
        RenderCoverage();
    }

    private async Task ShowDependencyPickerAsync()
    {
        var runtime = DeposRuntime.Current;
        if (runtime is null) return;
        context ??= await runtime.CoverageAsync();
        if (context is null || context.Dependencies.Count == 0) return;
        var dialog = new DependencyPickerDialog(context);
        if (dialog.ShowModal() == true && dialog.Selected is { } selectedRow)
            await SetContextAsync(context.ManifestPath, selectedRow.Dependency.NoteKey);
    }

    private void RenderDetail()
    {
        var enabled = selected is not null;
        openNotes.IsEnabled = enabled;
        save.IsEnabled = enabled;
        if (!enabled)
        {
            packageTitle.Text = "Select a dependency in a supported NuGet manifest.";
            packageScope.Text = "Use the Depos mark or Add/Edit Dependency Note command.";
            notesPath.Text = string.Empty;
            human.Visibility = Visibility.Collapsed;
            agentBox.Visibility = Visibility.Collapsed;
        }
        else
        {
            human.Visibility = Visibility.Visible;
            agentBox.Visibility = Visibility.Visible;
        }
    }

    private static void Run(Func<Task> action) => ThreadHelper.JoinableTaskFactory.Run(action);
}
