using System.Diagnostics;
using System.IO;
using System.Windows;
using Depos.Core;
using Depos.Core.Org;
using EnvDTE;
using EnvDTE80;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.TaskStatusCenter;
using Microsoft.VisualStudio.Threading;

namespace Depos.VisualStudio;

/// <summary>
/// The optional connection to Depos in Visual Studio: sign-in, org mode and its
/// triggers, and the Depos commands. The logic is <see cref="DeposConnection"/>
/// and <see cref="OrgSync"/> in Depos.Core; this adds the browser, the progress,
/// the info bars and the solution's folders. Signed out, nothing here makes a
/// network request.
/// </summary>
internal sealed class DeposService : IDisposable
{
    private const string LogSource = "Depos";

    private readonly DeposPackage package;
    private readonly DeposRuntime runtime;
    private readonly DTE2 dte;
    private readonly DeposHttpClient http;
    private readonly Dictionary<string, InfoBarHandle> notesFileBars = new(StringComparer.OrdinalIgnoreCase);
    private SolutionEvents? solutionEvents;
    private DeposErrorList? errorList;
    private System.Threading.Timer? timer;
    private System.Windows.Window? mainWindow;
    private string lastAddress;
    private bool disposed;

    public DeposService(DeposPackage package, DeposRuntime runtime, DTE2 dte)
    {
        this.package = package;
        this.runtime = runtime;
        this.dte = dte;
        http = new DeposHttpClient("Depos-VisualStudio/" + DeposBuild.Version);
        lastAddress = Address;
        Connection = new DeposConnection(http, new WindowsCredentialStore(), () => Address);
        Sync = new OrgSync(Connection, new OrgStore(Path.Combine(StorageRoot, "depos")), RootsAsync, log: Log);
        InfoBars = new DeposInfoBars(package);
    }

    public DeposConnection Connection { get; }
    public OrgSync Sync { get; }
    public DeposInfoBars InfoBars { get; }

    /// <summary>Everything Depos keeps on this machine, outside every solution.</summary>
    private static string StorageRoot => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Depos", "VisualStudio");

    private string Address => package.Options.DeposAddress ?? string.Empty;

    /// <summary>Listeners, the 5-minute timer and the first fetch.</summary>
    public void Start()
    {
        ThreadHelper.ThrowIfNotOnUIThread();
        Connection.Changed += (_, _) =>
        {
            runtime.NotifyChanged();
            Sync.Refresh();
        };
        Sync.Changed += (_, _) => runtime.NotifyChanged();
        runtime.Changed += (_, _) => DeposPackage.Forget(UpdateNotesFileBarsAsync, "Depos/Banner");
        errorList = new DeposErrorList(package, runtime);

        solutionEvents = dte.Events.SolutionEvents;
        solutionEvents.Opened += Sync.Refresh;
        solutionEvents.AfterClosing += Sync.Refresh;
        solutionEvents.ProjectAdded += _ => Sync.Refresh();
        solutionEvents.ProjectRemoved += _ => Sync.Refresh();

        mainWindow = Application.Current?.MainWindow;
        if (mainWindow is not null) mainWindow.Activated += OnMainWindowActivated;

        timer = new System.Threading.Timer(_ => Sync.Refresh(), null, OrgSync.RefreshInterval, OrgSync.RefreshInterval);
        Sync.Refresh();
    }

    /// <summary>The address option was applied: a changed one starts over, signed out until its own token is found.</summary>
    public void AddressApplied()
    {
        if (Address == lastAddress) return;
        lastAddress = Address;
        Connection.AddressChanged();
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        Sync.Dispose();
        timer?.Dispose();
        ThreadHelper.JoinableTaskFactory.Run(async () =>
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            if (mainWindow is not null) mainWindow.Activated -= OnMainWindowActivated;
            errorList?.Dispose();
        });
        http.Dispose();
    }

    private void OnMainWindowActivated(object sender, EventArgs args)
    {
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - Sync.LastRun > OrgSync.FocusMinGap.TotalMilliseconds) Sync.Refresh();
    }

    private void Log(string message) => ActivityLog.TryLogInformation(LogSource, message);

    // Folders.

    /// <summary>
    /// The solution's folders, as VS Code's workspace folders: the git work tree
    /// of the solution, of an open folder, and of each project.
    /// </summary>
    public async Task<IReadOnlyList<OrgRoot>> RootsAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var directories = new List<string>();
        var solution = dte.Solution?.FullName;
        if (!string.IsNullOrWhiteSpace(solution)) directories.Add(Path.GetDirectoryName(solution)!);
        var folder = await runtime.OpenFolderRootAsync();
        if (!string.IsNullOrWhiteSpace(folder)) directories.Add(folder!);
        if (dte.Solution?.Projects is { } projects)
        {
            foreach (Project project in projects) AddProjectDirectories(project, directories);
        }
        await TaskScheduler.Default;
        return directories
            .Select(GitRemote.WorkTreeOf)
            .Where(root => root is not null)
            .Select(root => root!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(root => new OrgRoot(Path.GetFileName(root.TrimEnd(Path.DirectorySeparatorChar)) is { Length: > 0 } name ? name : root, root))
            .ToArray();
    }

    private static void AddProjectDirectories(Project project, List<string> directories)
    {
        ThreadHelper.ThrowIfNotOnUIThread();
        try
        {
            if (project.Kind == ProjectKinds.vsProjectKindSolutionFolder)
            {
                foreach (ProjectItem item in project.ProjectItems)
                {
                    if (item.SubProject is { } child) AddProjectDirectories(child, directories);
                }
                return;
            }
            var path = project.FullName;
            if (!string.IsNullOrWhiteSpace(path) && Path.IsPathRooted(path)) directories.Add(Path.GetDirectoryName(path)!);
        }
        catch (Exception error) when (error is System.Runtime.InteropServices.COMException or NotImplementedException or ArgumentException)
        {
            // An unloaded or unusual project has no folder to offer.
        }
    }

    // Commands.

    /// <summary>The configured origin, after telling the user what is wrong with it. Asks for one when it is empty.</summary>
    private async Task<string?> OriginAsync(bool promptIfEmpty)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var raw = Address;
        if (raw.Trim().Length == 0 && promptIfEmpty)
        {
            var dialog = QuickInputDialog.Text("Depos", $"{DeposStrings.WebUrlPrompt}, such as {DeposStrings.WebUrlPlaceholder}", string.Empty);
            if (dialog.ShowModal() != true || dialog.Value.Length == 0) return null;
            raw = dialog.Value;
            if (DeposServerUrl.Parse(raw) is { Ok: true } entered)
            {
                package.Options.DeposAddress = entered.Origin!;
                package.Options.SaveSettingsToStorage();
                lastAddress = Address;
            }
        }
        var url = DeposServerUrl.Parse(raw);
        switch (url.Problem)
        {
            case DeposUrlProblem.Invalid:
                await InfoBars.ShowAsync(DeposStrings.WebUrlInvalid, InfoBarKind.Error);
                return null;
            case DeposUrlProblem.Insecure:
                await InfoBars.ShowAsync(DeposStrings.WebUrlInsecure, InfoBarKind.Error);
                return null;
            case DeposUrlProblem.Empty:
                return null;
            default:
                return url.Origin;
        }
    }

    /// <summary>The device flow: a code, the browser, a cancellable wait in the Task Status Center.</summary>
    public async Task SignInAsync()
    {
        var origin = await OriginAsync(promptIfEmpty: true);
        if (origin is null) return;
        if (await package.GetServiceAsync(typeof(SVsTaskStatusCenterService)) is not IVsTaskStatusCenterService center) return;
        var options = default(TaskHandlerOptions);
        options.Title = "Depos: signing in";
        options.ActionsAfterCompletion = CompletionActions.None;
        var data = default(TaskProgressData);
        data.CanBeCanceled = true;
        var handler = center.PreRegister(options, data);
        // The Task Status Center follows the wait and offers Cancel; the command returns at once.
        handler.RegisterTask(SignInAsync(origin, handler));
    }

    private async Task SignInAsync(string origin, ITaskHandler handler)
    {
        await TaskScheduler.Default;
        var cancellation = handler.UserCancellation;
        DeviceCode code;
        try
        {
            code = await DeviceFlow.RequestDeviceCodeAsync(Connection.Http, origin, cancellation);
        }
        catch (Exception error) when (!cancellation.IsCancellationRequested)
        {
            Log($"depos: sign-in at {origin} could not start: {error.Message}");
            await InfoBars.ShowAsync(error is DeposException ? error.Message : DeposStrings.WebUnreachable(origin), InfoBarKind.Error);
            return;
        }
        catch (OperationCanceledException)
        {
            return;
        }
        Log($"depos: sign-in started at {origin}");
        OpenBrowser(code.VerificationUriComplete);
        // The browser may not open (remote session, blocked): the link opens it again.
        var prompt = DeposStrings.WebSignInCode(code.UserCode);
        await InfoBars.ShowAsync(prompt, InfoBarKind.Information, new InfoBarAction(DeposStrings.WebOpenBrowser, () =>
        {
            OpenBrowser(code.VerificationUriComplete);
            return Task.CompletedTask;
        }));
        handler.Progress.Report(new TaskProgressData { ProgressText = DeposStrings.WebWaiting(code.UserCode), CanBeCanceled = true });

        DevicePollResult result;
        try
        {
            result = await DeviceFlow.PollForTokenAsync(Connection.Http, origin, code, SystemDeviceFlowClock.Instance, cancellation);
        }
        catch (Exception error) when (!cancellation.IsCancellationRequested)
        {
            Log($"depos: sign-in at {origin} stopped: {error.Message}");
            await InfoBars.ShowAsync(error is DeposException ? error.Message : DeposStrings.WebUnreachable(origin), InfoBarKind.Error);
            return;
        }
        catch (OperationCanceledException)
        {
            result = new DevicePollResult(DevicePollKind.Cancelled);
        }
        await InfoBars.CloseAsync(prompt);
        switch (result.Kind)
        {
            case DevicePollKind.Denied:
                await InfoBars.ShowAsync(DeposStrings.WebDenied, InfoBarKind.Warning);
                break;
            case DevicePollKind.Expired:
                await InfoBars.ShowAsync(DeposStrings.WebExpired, InfoBarKind.Warning);
                break;
            case DevicePollKind.Token:
                Connection.StoreToken(origin, result.Token);
                Log($"depos: signed in at {origin}");
                await ShowConnectionNowAsync(origin, result.Token!);
                break;
        }
    }

    public async Task SignOutAsync()
    {
        var origin = await OriginAsync(promptIfEmpty: false);
        if (origin is null) return;
        await TaskScheduler.Default;
        if (!await Connection.SignOutAsync(origin))
        {
            await InfoBars.ShowAsync(DeposStrings.WebNotSignedIn, InfoBarKind.Information);
            return;
        }
        Log($"depos: signed out of {origin}");
        DeleteViews();
        await InfoBars.ShowAsync(DeposStrings.WebSignedOut, InfoBarKind.Information);
    }

    /// <summary>Who is signed in, and which organization each folder belongs to.</summary>
    public async Task ShowConnectionAsync()
    {
        var origin = await OriginAsync(promptIfEmpty: false);
        if (origin is null)
        {
            await InfoBars.ShowAsync(DeposStrings.WebNotSignedIn, InfoBarKind.Information);
            return;
        }
        await TaskScheduler.Default;
        var token = Connection.ReadToken(origin);
        if (token is null)
        {
            await InfoBars.ShowAsync(DeposStrings.WebNotSignedIn, InfoBarKind.Information, new InfoBarAction(DeposStrings.WebSignIn, SignInAsync));
            return;
        }
        await ShowConnectionNowAsync(origin, token);
    }

    private async Task ShowConnectionNowAsync(string origin, string token)
    {
        try
        {
            var roots = await RootsAsync();
            await TaskScheduler.Default;
            var (name, email, lines) = await Connection.DescribeAsync(origin, token, roots.Select(root => (root.Name, root.Path)));
            foreach (var line in lines) Log("depos: " + line);
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            VsShellUtilities.ShowMessageBox(
                package,
                lines.Count == 0 ? " " : string.Join("\n", lines),
                DeposStrings.WebSignedIn(name, email),
                OLEMSGICON.OLEMSGICON_INFO,
                OLEMSGBUTTON.OLEMSGBUTTON_OK,
                OLEMSGDEFBUTTON.OLEMSGDEFBUTTON_FIRST);
        }
        catch (DeposSessionEndedException)
        {
            Connection.StoreToken(origin, null);
            await InfoBars.ShowAsync(DeposStrings.WebSessionExpired, InfoBarKind.Warning, new InfoBarAction(DeposStrings.WebSignIn, SignInAsync));
        }
        catch (Exception error)
        {
            Log("depos: show connection failed: " + error.Message);
            await InfoBars.ShowAsync(DeposStrings.WebUnreachable(origin), InfoBarKind.Error);
        }
    }

    public Task RefreshAsync()
    {
        Sync.Refresh();
        return Task.CompletedTask;
    }

    /// <summary>The MCP setup of a folder in org mode, on the clipboard.</summary>
    public async Task CopyMcpSetupAsync()
    {
        var folders = Sync.OrgFolders(await RootsAsync());
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        OrgFolder? folder = folders.Count switch
        {
            0 => null,
            1 => folders[0],
            _ => ChoiceDialog.Pick(DeposStrings.McpPickFolder, folders, item => item.RepoFullName ?? item.Name),
        };
        if (folders.Count == 0)
        {
            await InfoBars.ShowAsync(DeposStrings.McpNoOrgFolder, InfoBarKind.Information);
            return;
        }
        if (folder is null) return;
        Clipboard.SetText(DeposMcp.VisualStudioJson(folder.Origin, folder.RepoUlid));
        var keys = DeposMcp.KeysPage(folder.Origin, folder.OrgUlid);
        await InfoBars.ShowAsync(
            DeposStrings.McpCopied(folder.RepoFullName ?? folder.Name),
            InfoBarKind.Information,
            new InfoBarAction(DeposStrings.McpOpenKeys, () =>
            {
                OpenBrowser(keys);
                return Task.CompletedTask;
            }));
    }

    // Notes from Depos.

    /// <summary>
    /// Save a note in org mode, off the UI thread: it is a request. A refused save
    /// throws <see cref="DeposException"/> with the message for the user; agent
    /// lines that are not fields are left out, and a warning says so.
    /// </summary>
    public async Task SaveNoteAsync(string manifestPath, string packageName, string human, string agent)
    {
        await TaskScheduler.Default;
        var dropped = await Sync.SaveNoteAsync(manifestPath, packageName, human, agent);
        if (dropped > 0) await InfoBars.ShowAsync(DeposStrings.OrgNoteDropped(dropped), InfoBarKind.Warning);
    }

    /// <summary>
    /// The notes from Depos for a manifest's folder, read-only in an editor tab:
    /// a file under the local storage, rewritten from the copy each time.
    /// </summary>
    public async Task OpenOrgNotesAsync(string manifestPath)
    {
        var state = Sync.NotesFor(manifestPath);
        var text = Sync.NotesText(manifestPath);
        if (state is null || text is null) return;
        var path = Path.Combine(StorageRoot, "views", SafeName(state.RepoUlid), $"Notes from Depos ({DeposEcosystems.NuGet}).md");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (File.Exists(path)) File.SetAttributes(path, FileAttributes.Normal);
        File.WriteAllText(path, text.Replace("\n", "\r\n"), new System.Text.UTF8Encoding(false));
        File.SetAttributes(path, FileAttributes.ReadOnly);
        await runtime.OpenFileAsync(path);
    }

    private static string SafeName(string value) => new(value.Where(char.IsLetterOrDigit).ToArray());

    private void DeleteViews()
    {
        var views = Path.Combine(StorageRoot, "views");
        try
        {
            if (!Directory.Exists(views)) return;
            foreach (var file in Directory.EnumerateFiles(views, "*", SearchOption.AllDirectories)) File.SetAttributes(file, FileAttributes.Normal);
            Directory.Delete(views, recursive: true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // A tab still open keeps its file until the next sign-out.
        }
    }

    /// <summary>
    /// A red bar on each open DEPENDENCY-NOTES.md of a folder in org mode: the
    /// file is no longer used. The bar goes when the folder leaves org mode.
    /// </summary>
    private async Task UpdateNotesFileBarsAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        var open = runtime.OpenDocumentPaths().Where(DeposRuntime.IsNotesPath).ToArray();
        foreach (var path in notesFileBars.Keys.ToArray())
        {
            var bar = notesFileBars[path];
            // A bar the user closed stays closed while the file is open.
            if (open.Contains(path, StringComparer.OrdinalIgnoreCase) && Sync.NotesFor(path) is not null) continue;
            bar.Close();
            notesFileBars.Remove(path);
        }
        foreach (var path in open)
        {
            if (notesFileBars.ContainsKey(path) || Sync.NotesFor(path) is not { } state) continue;
            if (!VsShellUtilities.IsDocumentOpen(package, path, Guid.Empty, out _, out _, out var frame) || frame is null) continue;
            if (frame.GetProperty((int)__VSFPROPID7.VSFPROPID_InfoBarHost, out var value) != 0 || value is not IVsInfoBarHost host) continue;
            var manifest = runtime.ManifestForNotes(path);
            var actions = manifest is null
                ? Array.Empty<InfoBarAction>()
                : new[] { new InfoBarAction(DeposStrings.OrgOpenOrgNotes, () => OpenOrgNotesAsync(manifest)) };
            var handle = await InfoBars.CreateAsync(host, DeposStrings.OrgModeNotesFile(state.OrgName), InfoBarKind.Error, actions);
            if (handle is not null) notesFileBars[path] = handle;
        }
    }

    /// <summary>Opens an http or https address in the browser; anything else from a server answer is ignored.</summary>
    internal static void OpenBrowser(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)) return;
        System.Diagnostics.Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
    }
}
