using System.IO;
using System.Text;
using System.Windows;
using EnvDTE;
using EnvDTE80;
using Microsoft.VisualStudio.ComponentModelHost;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Editor;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.TextManager.Interop;
using Pacmon.Core;

namespace Pacmon.VisualStudio;

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
    public CoverageContext(string manifestPath, string root, string notesPath, IReadOnlyList<DependencyEntry> dependencies, NotesFileModel? notes)
    {
        ManifestPath = manifestPath;
        Root = root;
        NotesPath = notesPath;
        Dependencies = dependencies;
        Notes = notes;
        Analysis = Pacmon.Core.Notes.Analyze(dependencies, notes);
    }

    public string ManifestPath { get; }
    public string Root { get; }
    public string NotesPath { get; }
    public IReadOnlyList<DependencyEntry> Dependencies { get; }
    public NotesFileModel? Notes { get; }
    public NotesAnalysis Analysis { get; }
}

internal sealed class PacmonRuntime : IDisposable
{
    private readonly PacmonPackage package;
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
    private bool disposed;

    private PacmonRuntime(
        PacmonPackage package,
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

    public static PacmonRuntime? Current { get; set; }

    public event EventHandler? Changed;

    public PacmonOptionsPage Options => package.Options;

    public string? ActiveDocumentPath
    {
        get
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var path = dte.ActiveDocument?.FullName;
            return string.IsNullOrWhiteSpace(path) ? null : Path.GetFullPath(path);
        }
    }

    public static async Task<PacmonRuntime> CreateAsync(PacmonPackage package, CancellationToken cancellationToken)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        var dte = await package.GetServiceAsync(typeof(SDTE)) as DTE2
            ?? throw new InvalidOperationException("Visual Studio automation service is unavailable.");
        var componentModel = await package.GetServiceAsync(typeof(SComponentModel)) as IComponentModel
            ?? throw new InvalidOperationException("Visual Studio component model is unavailable.");
        var textManager = await package.GetServiceAsync(typeof(SVsTextManager)) as IVsTextManager
            ?? throw new InvalidOperationException("Visual Studio text manager is unavailable.");
        var runtime = new PacmonRuntime(
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
        if (path is null || !IsNotesPath(path)) return Array.Empty<LintFinding>();
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
        if (path is null || !IsNotesPath(path)) return Array.Empty<NoteSection>();
        var root = KnownRootFor(path);
        var workspace = new NugetWorkspace(fileSystem);
        var dependencies = workspace.DependenciesForNotes(path, root, Options.Monorepo);
        var model = Notes.Parse(buffer.CurrentSnapshot.GetText());
        return Notes.Analyze(dependencies, model).Orphans;
    }

    public NotesFileModel? NotesForManifest(string manifestPath, string root, out string notesPath)
    {
        var workspace = new NugetWorkspace(fileSystem);
        notesPath = workspace.ResolveNotesPath(manifestPath, root, Options.Monorepo)
            ?? workspace.CreationTarget(manifestPath, root);
        return FileExists(notesPath) ? Notes.Parse(ReadDocument(notesPath)) : null;
    }

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
        var notes = FileExists(notesPath) ? Notes.Parse(ReadDocument(notesPath)) : null;
        return new CoverageContext(path!, root, notesPath, dependencies, notes);
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
        switch (Options.NoteEntry)
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
                if (dialog.ShowModal() == true)
                    await SaveLayersAsync(manifestPath, packageName, dialog.Value,
                        section is null || model is null ? string.Empty : Notes.Layers(model, section).Agent);
                break;
            }
            case NoteEntryMode.OpenBeside:
                await EnsureSectionAndOpenAsync(manifestPath, packageName);
                break;
        }
    }

    public async Task SaveLayersAsync(string manifestPath, string packageName, string human, string agent)
    {
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
        var root = await RootForAsync(manifestPath);
        var model = NotesForManifest(manifestPath, root, out var notesPath);
        if (model is null || Notes.FindSection(model, packageName) is null)
            await SaveLayersAsync(manifestPath, packageName, string.Empty, string.Empty);
        await OpenDocumentAsync(notesPath, packageName);
    }

    public async Task NavigateToNoteAsync(string manifestPath, string packageName)
    {
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

    public async Task NormalizeNotesAsync(string path) =>
        await WriteDocumentAsync(path, Notes.Normalize(ReadDocument(path), Notes.DirectoryNameOf(path)));

    public async Task SetupAiInstructionsAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var active = ActiveDocumentPath;
        if (active is null)
        {
            await ShowInfoAsync("Open a file in the workspace first.");
            return;
        }
        var root = await RootForAsync(active);
        // Rewritten on every run, as the VS Code extension does, so an old copy
        // gets the current rules.
        await OpenDocumentAsync(await WriteAgentRulesAsync(new NugetWorkspace(fileSystem), root, overwrite: true));
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

    public void NotifyChanged()
    {
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

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        documents.TextDocumentCreated -= OnTextDocumentCreated;
        documents.TextDocumentDisposed -= OnTextDocumentDisposed;
        foreach (var pair in bufferHandlers) pair.Key.Changed -= pair.Value;
        bufferHandlers.Clear();
        watcher?.Dispose();
        changeTimer?.Dispose();
    }

    private void RegisterDocument(ITextDocument document)
    {
        var path = Path.GetFullPath(document.FilePath);
        buffers[path] = new WeakReference<ITextBuffer>(document.TextBuffer);
        if (bufferHandlers.ContainsKey(document.TextBuffer)) return;
        EventHandler<TextContentChangedEventArgs> handler = (_, _) => NotifyChanged();
        document.TextBuffer.Changed += handler;
        bufferHandlers[document.TextBuffer] = handler;
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
            if (NugetManifest.MatchesPath(args.FullPath) || IsNotesPath(args.FullPath)) NotifyChanged();
        };
        watcher.Changed += changed;
        watcher.Created += changed;
        watcher.Deleted += changed;
        watcher.Renamed += (_, args) => changed(watcher, args);
    }

    private async Task ShowInfoAsync(string message)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        VsShellUtilities.ShowMessageBox(
            package,
            message,
            "Depos",
            OLEMSGICON.OLEMSGICON_INFO,
            OLEMSGBUTTON.OLEMSGBUTTON_OK,
            OLEMSGDEFBUTTON.OLEMSGDEFBUTTON_FIRST);
    }

    private sealed class RuntimeFileSystem : IWorkspaceFileSystem
    {
        private static readonly HashSet<string> Excluded = new(StringComparer.OrdinalIgnoreCase)
        {
            ".git", ".vs", "bin", "obj", "dist", "build",
        };

        private readonly PacmonRuntime runtime;
        public RuntimeFileSystem(PacmonRuntime runtime) => this.runtime = runtime;
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
