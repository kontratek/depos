using System.IO;
using System.Text;
using System.Windows;
using EnvDTE;
using EnvDTE80;
using Microsoft.VisualStudio.ComponentModelHost;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Editor;
using Microsoft.VisualStudio.Settings;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Shell.Settings;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.TextManager.Interop;
using Depos.Core;
using Depos.Core.Org;

namespace Depos.VisualStudio;

internal sealed class DependencyContext
{
    public DependencyContext(string manifestPath, string root, DependencyEntry dependency)
    {
        ManifestPath = manifestPath;
        Root = root;
        Dependency = dependency;
    }

    public string ManifestPath { get; }
    public string Root { get; }
    public DependencyEntry Dependency { get; }
}

internal sealed class CoverageContext
{
    public CoverageContext(
        string manifestPath,
        string root,
        string notesPath,
        IReadOnlyList<DependencyEntry> dependencies,
        NotesFileModel? notes,
        OrgNotesState? org = null)
    {
        ManifestPath = manifestPath;
        Root = root;
        NotesPath = notesPath;
        Dependencies = dependencies;
        Notes = notes;
        Org = org;
        Analysis = Depos.Core.Notes.Analyze(dependencies, notes);
    }

    public string ManifestPath { get; }
    public string Root { get; }
    public string NotesPath { get; }
    public IReadOnlyList<DependencyEntry> Dependencies { get; }
    public NotesFileModel? Notes { get; }
    public NotesAnalysis Analysis { get; }

    /// <summary>Set in org mode: the notes come from Depos, not from <see cref="NotesPath"/>.</summary>
    public OrgNotesState? Org { get; }
}

internal enum DeposSeverity
{
    Warning,
    Error,
}

/// <summary>A problem in an open manifest or notes file, for the squiggle and the Error List.</summary>
internal sealed record DeposProblem(int Start, int Length, int Line, int Column, string Message, DeposSeverity Severity, string Code);

internal sealed class DeposRuntime : IDisposable
{
    private readonly DeposPackage package;
    private readonly DTE2 dte;
    private readonly IVsEditorAdaptersFactoryService adapters;
    private readonly ITextDocumentFactoryService documents;
    private readonly IVsTextManager textManager;
    private readonly Dictionary<string, WeakReference<ITextBuffer>> buffers = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<ITextBuffer, EventHandler<TextContentChangedEventArgs>> bufferHandlers = new();
    private readonly RuntimeFileSystem fileSystem;
    private FileSystemWatcher? watcher;
    private string? watcherRoot;
    private System.Threading.Timer? changeTimer;
    private readonly object changeGate = new();
    private bool disposed;

    private DeposRuntime(
        DeposPackage package,
        DTE2 dte,
        IVsEditorAdaptersFactoryService adapters,
        ITextDocumentFactoryService documents,
        IVsTextManager textManager)
    {
        this.package = package;
        this.dte = dte;
        this.adapters = adapters;
        this.documents = documents;
        this.textManager = textManager;
        fileSystem = new RuntimeFileSystem(this);
        documents.TextDocumentCreated += OnTextDocumentCreated;
        documents.TextDocumentDisposed += OnTextDocumentDisposed;
    }

    public static DeposRuntime? Current { get; set; }

    public event EventHandler? Changed;

    public DeposOptionsPage Options => package.Options;

    /// <summary>The optional connection to Depos and org mode.</summary>
    public DeposService Depos { get; private set; } = null!;

    public string? ActiveDocumentPath
    {
        get
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var path = dte.ActiveDocument?.FullName;
            return string.IsNullOrWhiteSpace(path) ? null : Path.GetFullPath(path);
        }
    }

    public static async Task<DeposRuntime> CreateAsync(DeposPackage package, CancellationToken cancellationToken)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        var dte = await package.GetServiceAsync(typeof(SDTE)) as DTE2
            ?? throw new InvalidOperationException("Visual Studio automation service is unavailable.");
        var componentModel = await package.GetServiceAsync(typeof(SComponentModel)) as IComponentModel
            ?? throw new InvalidOperationException("Visual Studio component model is unavailable.");
        var textManager = await package.GetServiceAsync(typeof(SVsTextManager)) as IVsTextManager
            ?? throw new InvalidOperationException("Visual Studio text manager is unavailable.");
        var runtime = new DeposRuntime(
            package,
            dte,
            componentModel.GetService<IVsEditorAdaptersFactoryService>(),
            componentModel.GetService<ITextDocumentFactoryService>(),
            textManager);
        var solution = dte.Solution?.FullName;
        if (!string.IsNullOrWhiteSpace(solution)) runtime.ConfigureWatcher(Path.GetDirectoryName(solution)!);
        else
        {
            var folder = await runtime.TryGetOpenFolderRootAsync();
            if (!string.IsNullOrWhiteSpace(folder)) runtime.ConfigureWatcher(folder!);
        }
        runtime.Depos = new DeposService(package, runtime, dte);
        runtime.Depos.Start();
        return runtime;
    }

    /// <summary>A NuGet notes file under .depos/, or under .pacmon/ in a repository from before Pacmon became Depos.</summary>
    public static bool IsNotesPath(string path) => NugetManifest.IsNotesPath(path);

    public void RegisterBuffer(ITextBuffer buffer)
    {
        if (!documents.TryGetTextDocument(buffer, out var document)) return;
        RegisterDocument(document);
    }

    public string? PathFor(ITextBuffer buffer)
    {
        RegisterBuffer(buffer);
        return documents.TryGetTextDocument(buffer, out var document) ? document.FilePath : null;
    }

    public string ReadDocument(string path)
    {
        var fullPath = Path.GetFullPath(path);
        if (TryGetBuffer(fullPath, out var buffer)) return buffer.CurrentSnapshot.GetText();
        return File.Exists(fullPath) ? File.ReadAllText(fullPath) : string.Empty;
    }

    public IReadOnlyList<DependencyEntry> Dependencies(ITextBuffer buffer)
    {
        var path = PathFor(buffer);
        return path is null || !NugetManifest.MatchesPath(path)
            ? Array.Empty<DependencyEntry>()
            : NugetManifest.ExtractDependencies(buffer.CurrentSnapshot.GetText(), path);
    }

    public bool TryGetLayers(string manifestPath, string packageName, out SectionLayers layers)
    {
        return TryGetLayers(manifestPath, packageName, out layers, out _);
    }

    public bool TryGetLayers(string manifestPath, string packageName, out SectionLayers layers, out string notesPath)
    {
        var root = KnownRootFor(manifestPath);
        var model = NotesForManifest(manifestPath, root, out notesPath);
        var section = model is null ? null : Notes.FindSection(model, packageName);
        if (model is null || section is null)
        {
            layers = new SectionLayers(string.Empty, string.Empty, string.Empty);
            return false;
        }
        layers = Notes.Layers(model, section);
        return layers.Human.Length > 0 || layers.Agent.Length > 0 || layers.Generated.Length > 0;
    }

    public async Task OpenNotesAsync(string manifestPath, string? packageName = null)
    {
        if (OrgFor(manifestPath) is not null)
        {
            await Depos.OpenOrgNotesAsync(manifestPath);
            return;
        }
        var root = await RootForAsync(manifestPath);
        var workspace = new NugetWorkspace(fileSystem);
        var notesPath = workspace.ResolveNotesPath(manifestPath, root, Options.Monorepo)
            ?? workspace.CreationTarget(manifestPath, root);
        if (!FileExists(notesPath))
        {
            await WriteDocumentAsync(notesPath, Notes.NewFile(directoryName: Notes.DirectoryNameOf(notesPath)));
            await WriteAgentRulesAsync(workspace, root, overwrite: false);
        }
        await OpenDocumentAsync(notesPath, packageName);
    }

    public async Task OpenFileAsync(string path) => await OpenDocumentAsync(path);

    public IReadOnlyList<LintFinding> LintNotesBuffer(ITextBuffer buffer)
    {
        var path = PathFor(buffer);
        if (path is null || !IsNotesPath(path) || OrgFor(path) is not null) return Array.Empty<LintFinding>();
        var root = KnownRootFor(path);
        var workspace = new NugetWorkspace(fileSystem);
        var dependencies = workspace.DependenciesForNotes(path, root, Options.Monorepo);
        var findings = Notes.Lint(Notes.Parse(buffer.CurrentSnapshot.GetText()), dependencies.Select(item => item.NoteKey));
        // A .pacmon/ file with a .depos/ one beside it is never read.
        return workspace.ShadowingNotesPath(path) is { } current
            ? new[] { Notes.ShadowedFinding(NugetWorkspace.RelativePath(current, root)) }.Concat(findings).ToArray()
            : findings;
    }

    public IReadOnlyList<NoteSection> OrphansForNotesBuffer(ITextBuffer buffer)
    {
        var path = PathFor(buffer);
        if (path is null || !IsNotesPath(path) || OrgFor(path) is not null) return Array.Empty<NoteSection>();
        var root = KnownRootFor(path);
        var workspace = new NugetWorkspace(fileSystem);
        // No manifest reads a .pacmon/ file with a .depos/ one beside it: its warning says so, not one mark per section.
        if (workspace.ShadowingNotesPath(path) is not null) return Array.Empty<NoteSection>();
        var dependencies = workspace.DependenciesForNotes(path, root, Options.Monorepo);
        var model = Notes.Parse(buffer.CurrentSnapshot.GetText());
        return Notes.Analyze(dependencies, model).Orphans;
    }

    public NotesFileModel? NotesForManifest(string manifestPath, string root, out string notesPath)
    {
        var workspace = new NugetWorkspace(fileSystem);
        notesPath = workspace.ResolveNotesPath(manifestPath, root, Options.Monorepo)
            ?? workspace.CreationTarget(manifestPath, root);
        // Org mode: the notes from Depos; the notes file is not read.
        if (Depos.Sync.NotesModel(manifestPath) is { } org) return org;
        return FileExists(notesPath) ? Notes.Parse(ReadDocument(notesPath)) : null;
    }

    /// <summary>The org mode of the folder that holds <paramref name="path"/>; null outside org mode.</summary>
    public OrgNotesState? OrgFor(string path) => Depos.Sync.NotesFor(path);

    public async Task<string> RootForAsync(string path)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var solution = dte.Solution?.FullName;
        if (!string.IsNullOrWhiteSpace(solution))
        {
            var root = Path.GetDirectoryName(solution)!;
            ConfigureWatcher(root);
            return root;
        }

        var folderRoot = await TryGetOpenFolderRootAsync();
        if (!string.IsNullOrWhiteSpace(folderRoot))
        {
            ConfigureWatcher(folderRoot!);
            return folderRoot!;
        }

        var directory = Path.GetDirectoryName(Path.GetFullPath(path))!;
        ConfigureWatcher(directory);
        return directory;
    }

    public async Task<DependencyContext?> ActiveDependencyAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var path = ActiveDocumentPath;
        if (path is null || !NugetManifest.MatchesPath(path)) return null;
        var text = ReadDocument(path);
        var dependencies = NugetManifest.ExtractDependencies(text, path);
        if (dependencies.Count == 0) return null;
        var offset = ActiveCaretOffset();
        var dependency = offset.HasValue ? NugetManifest.AtOffset(dependencies, offset.Value) : null;
        dependency ??= dependencies[0];
        return new DependencyContext(path, await RootForAsync(path), dependency);
    }

    public async Task<CoverageContext?> CoverageAsync(string? manifestPath = null)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var path = manifestPath;
        if (string.IsNullOrWhiteSpace(path) || !NugetManifest.MatchesPath(path!))
            path = ActiveDocumentPath;
        if (string.IsNullOrWhiteSpace(path) || !NugetManifest.MatchesPath(path!))
        {
            path = await FindFirstManifestAsync();
            if (path is null) return null;
        }
        var root = await RootForAsync(path!);
        var workspace = new NugetWorkspace(fileSystem);
        var notesPath = workspace.ResolveNotesPath(path!, root, Options.Monorepo)
            ?? workspace.CreationTarget(path!, root);
        var dependencies = workspace.DependenciesForManifest(path!, root, Options.Monorepo);
        var org = OrgFor(path!);
        var notes = org is not null
            ? Depos.Sync.NotesModel(path!)
            : FileExists(notesPath) ? Notes.Parse(ReadDocument(notesPath)) : null;
        return new CoverageContext(path!, root, notesPath, dependencies, notes, org);
    }

    public async Task AddOrEditActiveDependencyAsync()
    {
        var context = await ActiveDependencyAsync();
        if (context is null)
        {
            await ShowInfoAsync("Open a .csproj, .fsproj, .vbproj, or Directory.Packages.props dependency first.");
            return;
        }
        await AddOrEditAsync(context.ManifestPath, context.Dependency.NoteKey);
    }

    public async Task AddOrEditAsync(string manifestPath, string packageName)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var org = OrgFor(manifestPath);
        // Org mode edits in the tool window, which shows who may change the note and the allowlist result;
        // Quick input stays for admins.
        var entry = Options.NoteEntry;
        if (org is not null && (entry == NoteEntryMode.OpenBeside || !org.CanEdit)) entry = NoteEntryMode.ToolWindow;
        switch (entry)
        {
            case NoteEntryMode.ToolWindow:
                await package.ShowToolWindowAsync(manifestPath, packageName);
                break;
            case NoteEntryMode.QuickInput:
            {
                var root = await RootForAsync(manifestPath);
                var model = NotesForManifest(manifestPath, root, out _);
                var section = model is null ? null : Notes.FindSection(model, packageName);
                var existing = section is null || model is null ? string.Empty : Notes.Layers(model, section).Human;
                var dialog = new QuickInputDialog(packageName, existing);
                if (dialog.ShowModal() != true) break;
                try
                {
                    await SaveLayersAsync(manifestPath, packageName, dialog.Value,
                        section is null || model is null ? string.Empty : Notes.Layers(model, section).Agent);
                }
                catch (DeposException error)
                {
                    await Depos.InfoBars.ShowAsync(error.Message, InfoBarKind.Error);
                }
                break;
            }
            case NoteEntryMode.OpenBeside:
                await EnsureSectionAndOpenAsync(manifestPath, packageName);
                break;
        }
    }

    /// <summary>
    /// Saves a note: to the notes file, or in org mode to Depos, which throws
    /// <see cref="DeposException"/> with a message for the user when it refuses.
    /// </summary>
    public async Task SaveLayersAsync(string manifestPath, string packageName, string human, string agent)
    {
        if (OrgFor(manifestPath) is not null)
        {
            await Depos.SaveNoteAsync(manifestPath, packageName, human, agent);
            return;
        }
        var root = await RootForAsync(manifestPath);
        var workspace = new NugetWorkspace(fileSystem);
        var notesPath = workspace.ResolveNotesPath(manifestPath, root, Options.Monorepo)
            ?? workspace.CreationTarget(manifestPath, root);
        var directoryName = Notes.DirectoryNameOf(notesPath);
        var original = FileExists(notesPath) ? ReadDocument(notesPath) : Notes.NewFile(directoryName: directoryName);
        await WriteDocumentAsync(notesPath, Notes.UpsertLayers(original, packageName, human, agent, directoryName));
        await WriteAgentRulesAsync(workspace, root, overwrite: false);
    }

    public async Task OpenNotesForActiveManifestAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var path = ActiveDocumentPath;
        if (path is null || !NugetManifest.MatchesPath(path))
        {
            await ShowInfoAsync("Open a supported NuGet manifest first.");
            return;
        }
        if (OrgFor(path) is not null)
        {
            await Depos.OpenOrgNotesAsync(path);
            return;
        }
        var root = await RootForAsync(path);
        var workspace = new NugetWorkspace(fileSystem);
        var notesPath = workspace.ResolveNotesPath(path, root, Options.Monorepo) ?? workspace.CreationTarget(path, root);
        if (!FileExists(notesPath))
        {
            await WriteDocumentAsync(notesPath, Notes.NewFile(directoryName: Notes.DirectoryNameOf(notesPath)));
            await WriteAgentRulesAsync(workspace, root, overwrite: false);
        }
        await OpenDocumentAsync(notesPath);
    }

    public async Task OpenManifestForActiveNotesAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var path = ActiveDocumentPath;
        if (path is null)
        {
            await ShowInfoAsync("Open a NuGet dependency notes file first.");
            return;
        }
        if (NugetManifest.MatchesPath(path))
        {
            await OpenDocumentAsync(path);
            return;
        }
        if (!IsNotesPath(path))
        {
            await ShowInfoAsync("Open a NuGet DEPENDENCY-NOTES.md first.");
            return;
        }
        var root = KnownRootFor(path);
        var manifest = new NugetWorkspace(fileSystem).ManifestsForNotes(path, root, Options.Monorepo).FirstOrDefault();
        if (manifest is null) await ShowInfoAsync("No NuGet manifest uses this notes file.");
        else await OpenDocumentAsync(manifest);
    }

    public async Task EnsureSectionAndOpenAsync(string manifestPath, string packageName)
    {
        if (OrgFor(manifestPath) is not null)
        {
            await package.ShowToolWindowAsync(manifestPath, packageName);
            return;
        }
        var root = await RootForAsync(manifestPath);
        var model = NotesForManifest(manifestPath, root, out var notesPath);
        if (model is null || Notes.FindSection(model, packageName) is null)
            await SaveLayersAsync(manifestPath, packageName, string.Empty, string.Empty);
        await OpenDocumentAsync(notesPath, packageName);
    }

    public async Task NavigateToNoteAsync(string manifestPath, string packageName)
    {
        if (OrgFor(manifestPath) is not null)
        {
            await package.ShowToolWindowAsync(manifestPath, packageName);
            return;
        }
        var root = await RootForAsync(manifestPath);
        var model = NotesForManifest(manifestPath, root, out var notesPath);
        if (model is null || Notes.FindSection(model, packageName) is null)
            await AddOrEditAsync(manifestPath, packageName);
        else
            await OpenDocumentAsync(notesPath, packageName);
    }

    public async Task NormalizeActiveNotesAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var path = ActiveDocumentPath;
        if (path is null || !IsNotesPath(path))
        {
            await ShowInfoAsync("Open a NuGet DEPENDENCY-NOTES.md first.");
            return;
        }
        await NormalizeNotesAsync(path);
    }

    public async Task NormalizeNotesAsync(string path)
    {
        // Org mode does not use the notes file, so it does not rewrite it either: the file is to be deleted.
        if (OrgFor(path) is { } org)
        {
            await Depos.InfoBars.ShowAsync(DeposStrings.OrgModeNotesFile(org.OrgName), InfoBarKind.Warning);
            return;
        }
        await WriteDocumentAsync(path, Notes.Normalize(ReadDocument(path), Notes.DirectoryNameOf(path)));
    }

    /// <summary>
    /// Two writes, as in the other editors: AGENT-RULES.md, in the repository's
    /// notes directory, is rewritten from the extension's own copy, and each
    /// instruction file the user picks (<c>AGENTS.md</c>, <c>CLAUDE.md</c>, …) gets
    /// the three-line pointer to it, inserted or updated between markers.
    /// </summary>
    public async Task SetupAiInstructionsAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var seed = ActiveDocumentPath ?? dte.Solution?.FullName;
        if (string.IsNullOrWhiteSpace(seed))
        {
            await ShowInfoAsync("Open a solution or a file in the workspace first.");
            return;
        }
        var root = await RootForAsync(seed!);
        var dialog = new AiInstructionsTargetsDialog(root);
        if (dialog.ShowModal() != true) return;
        var workspace = new NugetWorkspace(fileSystem);
        var directoryName = workspace.NotesDirectoryFor(root);
        // Rewritten on every run, as the other editors do, so an old copy gets the current rules.
        var rules = await WriteAgentRulesAsync(workspace, root, overwrite: true);
        var written = new List<string> { AgentRules.RelativePath(directoryName) };
        foreach (var target in dialog.SelectedTargets)
        {
            var path = Path.Combine(root, target.Replace('/', Path.DirectorySeparatorChar));
            await WriteDocumentAsync(path, AiInstructions.Upsert(FileExists(path) ? ReadDocument(path) : string.Empty, directoryName));
            written.Add(target);
        }
        await OpenDocumentAsync(rules);
        await Depos.InfoBars.ShowAsync($"Depos: AI instructions written to {string.Join(", ", written)}.", InfoBarKind.Information);
    }

    /// <summary>
    /// AGENT-RULES.md at the workspace root, in the repository's notes directory
    /// (.depos/, or .pacmon/ for a repository that keeps its notes there, with
    /// the rules' paths there too): the rules every notes file's header comment
    /// points agents to. Written when it is missing, and always when
    /// <paramref name="overwrite"/> is set.
    /// </summary>
    private async Task<string> WriteAgentRulesAsync(NugetWorkspace workspace, string root, bool overwrite)
    {
        var directoryName = workspace.NotesDirectoryFor(root);
        var rulesPath = Path.Combine(root, directoryName, AgentRules.FileName);
        if (overwrite || !FileExists(rulesPath)) await WriteDocumentAsync(rulesPath, AgentRules.TextIn(directoryName));
        return rulesPath;
    }

    /// <summary>
    /// "Move Notes to .depos/", as in the other editors (<see cref="MoveNotes"/>).
    /// Never run without asking: a teammate on a version from before Depos reads
    /// .pacmon/ only.
    /// </summary>
    public async Task MoveNotesToDeposAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var seed = ActiveDocumentPath ?? dte.Solution?.FullName;
        if (string.IsNullOrWhiteSpace(seed))
        {
            await ShowInfoAsync("Open a solution or a file in the workspace first.");
            return;
        }
        var root = await RootForAsync(seed!);
        var legacy = new NugetWorkspace(fileSystem).LegacyNotesDirectories(root);
        if (legacy.Count == 0)
        {
            await ShowInfoAsync(MoveNotes.None);
            return;
        }
        if (MoveNotes.Conflicts(legacy) is { Count: > 0 } conflicts)
        {
            ShowMessage(MoveNotes.Conflict(string.Join(", ", conflicts.Select(directory => NugetWorkspace.RelativePath(directory, root)))), OLEMSGICON.OLEMSGICON_WARNING);
            return;
        }
        if (ShowMessage(MoveNotes.Confirm(legacy.Count), OLEMSGICON.OLEMSGICON_WARNING, OLEMSGBUTTON.OLEMSGBUTTON_OKCANCEL) != (int)VSConstants.MessageBoxResult.IDOK) return;

        // A file open under a directory that moves is saved and closed, and opened again from where it went.
        var reopen = new List<string>();
        foreach (var document in dte.Documents.Cast<Document>().ToArray())
        {
            var path = document.FullName;
            if (!legacy.Any(directory => IsUnder(path, directory))) continue;
            reopen.Add(path);
            document.Close(vsSaveChanges.vsSaveChangesYes);
        }
        var outcome = await MoveNotes.MoveAsync(root, legacy, path => FileExists(path) ? ReadDocument(path) : null, WriteDocumentAsync);
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        foreach (var path in reopen)
        {
            var moved = outcome.Moved.FirstOrDefault(directory => IsUnder(path, directory.From));
            var now = moved is null ? path : moved.To + path.Substring(moved.From.Length);
            if (File.Exists(now)) await OpenDocumentAsync(now);
        }
        NotifyChanged();
        if (outcome.Moved.Count > 0) await Depos.InfoBars.ShowAsync(MoveNotes.Done(outcome.Moved.Count), InfoBarKind.Information);
        if (outcome.Failure is { } failure) ShowMessage(failure, OLEMSGICON.OLEMSGICON_CRITICAL);
    }

    private static bool IsUnder(string path, string directory) =>
        Path.GetFullPath(path).StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Once per solution, when a notes file under .pacmon/ is opened: the move,
    /// offered. Not in org mode, where the notes file is not used at all.
    /// </summary>
    private void SuggestMoveNotes(string path)
    {
        if (!string.Equals(Path.GetFileName(path), Notes.FileName, StringComparison.OrdinalIgnoreCase)
            || Notes.DirectoryNameOf(path) != Notes.LegacyDirectoryName) return;
        DeposPackage.Forget(async () =>
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            if (Depos is null || OrgFor(path) is not null) return;
            const string collection = "Depos\\MoveNotesSuggested";
            var root = (await RootForAsync(path)).Replace('\\', '/');
            var store = new ShellSettingsManager(package).GetWritableSettingsStore(SettingsScope.UserSettings);
            if (store.CollectionExists(collection) && store.PropertyExists(collection, root)) return;
            store.CreateCollection(collection);
            store.SetBoolean(collection, root, true);
            await Depos.InfoBars.ShowAsync(MoveNotes.Suggest, InfoBarKind.Information, new InfoBarAction(MoveNotes.Action, MoveNotesToDeposAsync));
        }, "Depos/MoveNotes");
    }

    /// <summary>Raises <see cref="Changed"/> on the UI thread, once for a burst of calls. Safe from any thread.</summary>
    public void NotifyChanged()
    {
        lock (changeGate)
        {
            if (disposed) return;
            changeTimer?.Dispose();
            changeTimer = new System.Threading.Timer(
                _ => ThreadHelper.JoinableTaskFactory.Run(async () =>
                {
                    await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                    Changed?.Invoke(this, EventArgs.Empty);
                }),
                null,
                180,
                Timeout.Infinite);
        }
    }

    /// <summary>The files open in an editor, by full path. On the UI thread.</summary>
    public IReadOnlyList<string> OpenDocumentPaths()
    {
        var open = new List<string>();
        foreach (var pair in buffers.ToArray())
        {
            if (pair.Value.TryGetTarget(out _)) open.Add(pair.Key);
        }
        return open;
    }

    /// <summary>The open buffer of a file, if it is open in an editor. On the UI thread.</summary>
    public ITextBuffer? OpenBuffer(string path) => TryGetBuffer(path, out var buffer) ? buffer : null;

    /// <summary>The first manifest a notes file describes, or null.</summary>
    public string? ManifestForNotes(string notesPath) =>
        new NugetWorkspace(fileSystem).ManifestsForNotes(notesPath, KnownRootFor(notesPath), Options.Monorepo).FirstOrDefault();

    /// <summary>
    /// What is wrong in an open file: lint findings in a notes file, the notice on
    /// a notes file Depos replaces, and Denied or Not listed packages of a manifest
    /// in org mode. The squiggles and the Error List both show it.
    /// </summary>
    public IReadOnlyList<DeposProblem> Problems(ITextBuffer buffer, ITextSnapshot snapshot)
    {
        var path = PathFor(buffer);
        if (path is null) return Array.Empty<DeposProblem>();
        var problems = new List<DeposProblem>();
        if (IsNotesPath(path))
        {
            if (OrgFor(path) is { } org)
            {
                var first = snapshot.GetLineFromLineNumber(0);
                problems.Add(new DeposProblem(
                    first.Start.Position,
                    Math.Min(Math.Max(1, first.Length), snapshot.Length),
                    0,
                    0,
                    DeposStrings.OrgModeNotesFile(org.OrgName),
                    DeposSeverity.Error,
                    "org-mode-notes-file"));
                return problems;
            }
            foreach (var finding in LintNotesBuffer(buffer))
            {
                if (finding.Line < 0 || finding.Line >= snapshot.LineCount) continue;
                var line = snapshot.GetLineFromLineNumber(finding.Line);
                var start = Math.Min(line.End.Position, line.Start.Position + Math.Max(0, finding.StartColumn));
                var end = finding.EndColumn > finding.StartColumn
                    ? Math.Min(line.End.Position, line.Start.Position + finding.EndColumn)
                    : line.End.Position;
                var safeEnd = Math.Min(snapshot.Length, Math.Max(start + 1, end));
                if (safeEnd == start && start > 0) start--;
                problems.Add(new DeposProblem(
                    start,
                    safeEnd - start,
                    finding.Line,
                    start - line.Start.Position,
                    finding.Message,
                    DeposSeverity.Warning,
                    finding.Kind));
            }
            return problems;
        }
        if (!NugetManifest.MatchesPath(path)) return problems;
        foreach (var dependency in NugetManifest.ExtractDependencies(snapshot.GetText(), path))
        {
            // Looked up in the local copy, so a line just typed is judged at once.
            if (Depos.Sync.Allowlist(path, dependency.NoteKey) is not { } allowlist || !allowlist.Result.IsViolation) continue;
            var range = dependency.PrimaryRange;
            var start = Math.Max(0, Math.Min(range.Offset, snapshot.Length));
            var length = Math.Max(0, Math.Min(range.Length, snapshot.Length - start));
            var line = snapshot.GetLineFromPosition(start);
            var denied = allowlist.Result.Kind == OrgResultKind.Denied;
            problems.Add(new DeposProblem(
                start,
                length,
                line.LineNumber,
                start - line.Start.Position,
                denied
                    ? DeposStrings.OrgDenied(dependency.DisplayName, allowlist.OrgName, allowlist.Result.Reason)
                    : DeposStrings.OrgUnlisted(dependency.DisplayName, allowlist.OrgName),
                allowlist.Result.Mode == PolicyMode.Enforce ? DeposSeverity.Error : DeposSeverity.Warning,
                denied ? "org-denied" : "org-not-listed"));
        }
        return problems;
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        documents.TextDocumentCreated -= OnTextDocumentCreated;
        documents.TextDocumentDisposed -= OnTextDocumentDisposed;
        foreach (var pair in bufferHandlers) pair.Key.Changed -= pair.Value;
        bufferHandlers.Clear();
        watcher?.Dispose();
        lock (changeGate) changeTimer?.Dispose();
        Depos?.Dispose();
    }

    private void RegisterDocument(ITextDocument document)
    {
        var path = Path.GetFullPath(document.FilePath);
        buffers[path] = new WeakReference<ITextBuffer>(document.TextBuffer);
        if (bufferHandlers.ContainsKey(document.TextBuffer)) return;
        EventHandler<TextContentChangedEventArgs> handler = (_, _) => NotifyChanged();
        document.TextBuffer.Changed += handler;
        bufferHandlers[document.TextBuffer] = handler;
        // A file just opened may need the org-mode notice and Error List entries.
        if (IsNotesPath(path) || NugetManifest.MatchesPath(path)) NotifyChanged();
        SuggestMoveNotes(path);
    }

    private void OnTextDocumentCreated(object sender, TextDocumentEventArgs args) => RegisterDocument(args.TextDocument);

    private void OnTextDocumentDisposed(object sender, TextDocumentEventArgs args)
    {
        var path = Path.GetFullPath(args.TextDocument.FilePath);
        buffers.Remove(path);
        if (!bufferHandlers.TryGetValue(args.TextDocument.TextBuffer, out var handler)) return;
        args.TextDocument.TextBuffer.Changed -= handler;
        bufferHandlers.Remove(args.TextDocument.TextBuffer);
    }

    private bool TryGetBuffer(string path, out ITextBuffer buffer)
    {
        buffer = null!;
        var fullPath = Path.GetFullPath(path);
        if (!buffers.TryGetValue(fullPath, out var weak) || !weak.TryGetTarget(out buffer))
        {
            buffers.Remove(fullPath);
            return false;
        }
        return true;
    }

    private bool FileExists(string path) => TryGetBuffer(path, out _) || File.Exists(path);

    private async Task WriteDocumentAsync(string path, string text)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var fullPath = Path.GetFullPath(path);
        if (TryGetBuffer(fullPath, out var buffer))
        {
            using var edit = buffer.CreateEdit();
            edit.Replace(new Span(0, buffer.CurrentSnapshot.Length), text);
            edit.Apply();
        }
        else
        {
            Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
            var temporary = fullPath + ".depos.tmp";
            File.WriteAllText(temporary, text, new UTF8Encoding(false));
            if (File.Exists(fullPath))
            {
                var backup = fullPath + ".depos.bak";
                try { File.Replace(temporary, fullPath, backup, true); }
                finally { if (File.Exists(backup)) File.Delete(backup); }
            }
            else File.Move(temporary, fullPath);
        }
        NotifyChanged();
    }

    private async Task OpenDocumentAsync(string path, string? packageName = null)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var window = dte.ItemOperations.OpenFile(path, EnvDTE.Constants.vsViewKindTextView);
        window.Activate();
        if (packageName is null) return;
        var model = Notes.Parse(ReadDocument(path));
        var section = Notes.FindSection(model, packageName);
        if (section is not null && dte.ActiveDocument?.Selection is TextSelection selection)
            selection.GotoLine(section.BodyStart + 1, true);
    }

    private int? ActiveCaretOffset()
    {
        ThreadHelper.ThrowIfNotOnUIThread();
        if (textManager.GetActiveView(1, null, out var nativeView) != VSConstants.S_OK) return null;
        var view = adapters.GetWpfTextView(nativeView);
        return view?.Caret.Position.BufferPosition.Position;
    }

    private async Task<string?> FindFirstManifestAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var active = ActiveDocumentPath;
        var seed = active ?? dte.Solution?.FullName;
        if (string.IsNullOrWhiteSpace(seed)) return null;
        var root = await RootForAsync(seed!);
        return new NugetWorkspace(fileSystem).DiscoverManifests(root).FirstOrDefault();
    }

    public Task<string?> OpenFolderRootAsync() => TryGetOpenFolderRootAsync();

    private async Task<string?> TryGetOpenFolderRootAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        const string typeName = "Microsoft.VisualStudio.Workspace.VSIntegration.Contracts.IVsFolderWorkspaceService, Microsoft.VisualStudio.Workspace.VSIntegration.Contracts";
        var serviceType = Type.GetType(typeName, false);
        if (serviceType is null) return null;
        var service = await package.GetServiceAsync(serviceType);
        var workspace = serviceType.GetProperty("CurrentWorkspace")?.GetValue(service);
        return workspace?.GetType().GetProperty("Location")?.GetValue(workspace) as string;
    }

    private string KnownRootFor(string path)
    {
        var known = watcherRoot;
        if (!string.IsNullOrWhiteSpace(known))
        {
            var full = Path.GetFullPath(path);
            var root = Path.GetFullPath(known!);
            if (string.Equals(full, root, StringComparison.OrdinalIgnoreCase)
                || full.StartsWith(root.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                return root;
        }
        return Path.GetDirectoryName(Path.GetFullPath(path))!;
    }

    private void ConfigureWatcher(string root)
    {
        if (string.Equals(watcherRoot, root, StringComparison.OrdinalIgnoreCase)) return;
        watcher?.Dispose();
        watcherRoot = root;
        if (!Directory.Exists(root)) return;
        watcher = new FileSystemWatcher(root)
        {
            IncludeSubdirectories = true,
            Filter = "*.*",
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.DirectoryName,
            EnableRaisingEvents = true,
        };
        FileSystemEventHandler changed = (_, args) =>
        {
            // A whole .depos/ or .pacmon/ directory moved or removed, too: a renamed directory is one event.
            if (NugetManifest.MatchesPath(args.FullPath)
                || IsNotesPath(args.FullPath)
                || Notes.DirectoryNames.Contains(Path.GetFileName(args.FullPath), StringComparer.OrdinalIgnoreCase))
                NotifyChanged();
        };
        watcher.Changed += changed;
        watcher.Created += changed;
        watcher.Deleted += changed;
        watcher.Renamed += (_, args) => changed(watcher, args);
    }

    private async Task ShowInfoAsync(string message)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        ShowMessage(message, OLEMSGICON.OLEMSGICON_INFO);
    }

    /// <summary>A Depos message box on the UI thread; the button pressed.</summary>
    private int ShowMessage(string message, OLEMSGICON icon, OLEMSGBUTTON buttons = OLEMSGBUTTON.OLEMSGBUTTON_OK)
    {
        ThreadHelper.ThrowIfNotOnUIThread();
        return VsShellUtilities.ShowMessageBox(package, message, "Depos", icon, buttons, OLEMSGDEFBUTTON.OLEMSGDEFBUTTON_FIRST);
    }

    private sealed class RuntimeFileSystem : IWorkspaceFileSystem
    {
        private static readonly HashSet<string> Excluded = new(StringComparer.OrdinalIgnoreCase)
        {
            ".git", ".vs", "bin", "obj", "dist", "build",
        };

        private readonly DeposRuntime runtime;
        public RuntimeFileSystem(DeposRuntime runtime) => this.runtime = runtime;
        public bool FileExists(string path) => runtime.FileExists(path);
        public string ReadAllText(string path) => runtime.ReadDocument(path);
        public IEnumerable<string> EnumerateFiles(string root) => Enumerate(root);

        private static IEnumerable<string> Enumerate(string directory)
        {
            IEnumerable<string> files;
            IEnumerable<string> children;
            try
            {
                files = Directory.EnumerateFiles(directory);
                children = Directory.EnumerateDirectories(directory);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                yield break;
            }
            foreach (var file in files) yield return file;
            foreach (var child in children)
            {
                if (Excluded.Contains(Path.GetFileName(child))) continue;
                foreach (var file in Enumerate(child)) yield return file;
            }
        }
    }
}
