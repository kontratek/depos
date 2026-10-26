using System.ComponentModel.Design;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Depos.Core;

namespace Depos.VisualStudio;

[PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
[InstalledProductRegistration("Depos — Dependency Notes", "Dependency notes for .NET/NuGet manifests.", DeposBuild.Version)]
// Version 2: the package GUID is the one from before Pacmon became Depos, and a
// new version makes Visual Studio merge the changed command table again.
[ProvideMenuResource("Menus.ctmenu", 2)]
[ProvideToolWindow(
    typeof(DeposToolWindow),
    Style = VsDockStyle.Tabbed,
    Window = "3ae79031-e1bc-11d0-8f78-00a0c9110057")]
[ProvideOptionPage(typeof(DeposOptionsPage), "Depos", "General", 0, 0, true)]
[ProvideAutoLoad(VSConstants.UICONTEXT.SolutionExists_string, PackageAutoLoadFlags.BackgroundLoad)]
[ProvideAutoLoad(VSConstants.UICONTEXT.NoSolution_string, PackageAutoLoadFlags.BackgroundLoad)]
[Guid(PackageGuid)]
public sealed class DeposPackage : AsyncPackage
{
    // From before Pacmon became Depos, as in Depos.vsct: Visual Studio keeps the
    // package's state and the commands' customizations under these.
    public const string PackageGuid = "0D148B7E-B648-46AA-92EF-E401D72AE221";
    public static readonly Guid CommandSet = new("A6EEA79E-0D28-481F-B55F-32E34EC61796");

    private static DeposPackage? instance;

    internal DeposRuntime Runtime { get; private set; } = null!;

    /// <summary>
    /// Runs <paramref name="work"/> without blocking the caller, on the package's
    /// task factory so Visual Studio waits for it at shutdown; a fault is reported
    /// under <paramref name="faultEvent"/>.
    /// </summary>
    internal static void Forget(Func<Task> work, string faultEvent)
    {
        if (instance is { } package) package.JoinableTaskFactory.RunAsync(work).FileAndForget(faultEvent);
    }
    internal DeposOptionsPage Options => (DeposOptionsPage)GetDialogPage(typeof(DeposOptionsPage));

    protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
    {
        await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        instance = this;
        Runtime = await DeposRuntime.CreateAsync(this, cancellationToken);
        DeposRuntime.Current = Runtime;
        await RegisterCommandsAsync(cancellationToken);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) Runtime?.Dispose();
        if (ReferenceEquals(DeposRuntime.Current, Runtime)) DeposRuntime.Current = null;
        if (ReferenceEquals(instance, this)) instance = null;
        base.Dispose(disposing);
    }

    internal async Task ShowToolWindowAsync(string? manifestPath = null, string? packageName = null)
    {
        await JoinableTaskFactory.SwitchToMainThreadAsync();
        var window = await ShowToolWindowAsync(typeof(DeposToolWindow), 0, true, DisposalToken);
        if (window is null) throw new InvalidOperationException("Depos tool window could not be created.");
        if (window.Content is DeposToolWindowControl control)
        {
            if (string.IsNullOrWhiteSpace(manifestPath) && string.IsNullOrWhiteSpace(packageName))
                await control.ShowSettingsAsync();
            else
                await control.SetContextAsync(manifestPath, packageName);
        }
    }

    private async Task RegisterCommandsAsync(CancellationToken cancellationToken)
    {
        await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        var service = await GetServiceAsync(typeof(IMenuCommandService)) as OleMenuCommandService;
        if (service is null) return;

        AddCommand(service, 0x0100, async () => await ShowToolWindowAsync());
        AddCommand(service, 0x0101, async () => await Runtime.AddOrEditActiveDependencyAsync());
        AddCommand(service, 0x0102, async () => await Runtime.OpenNotesForActiveManifestAsync());
        AddCommand(service, 0x0107, async () => await Runtime.OpenManifestForActiveNotesAsync());
        AddCommand(service, 0x0103, async () => await ShowToolWindowAsync());
        AddCommand(service, 0x0104, async () => await Runtime.NormalizeActiveNotesAsync());
        AddCommand(service, 0x0105, async () => await Runtime.SetupAiInstructionsAsync());
        AddCommand(service, 0x0106, async () =>
        {
            Options.MarginIcon = !Options.MarginIcon;
            Options.SaveSettingsToStorage();
            Runtime.NotifyChanged();
            await Task.CompletedTask;
        });
        AddCommand(service, 0x0108, async () => await Runtime.Depos.SignInAsync());
        AddCommand(service, 0x0109, async () => await Runtime.Depos.SignOutAsync());
        AddCommand(service, 0x010A, async () => await Runtime.Depos.ShowConnectionAsync());
        AddCommand(service, 0x010B, async () => await Runtime.Depos.RefreshAsync());
        AddCommand(service, 0x010C, async () => await Runtime.Depos.CopyMcpSetupAsync());
        AddCommand(service, 0x010D, async () => await Runtime.MoveNotesToDeposAsync());
    }

    private void AddCommand(OleMenuCommandService service, int id, Func<Task> execute)
    {
        var command = new OleMenuCommand(
            (_, _) => JoinableTaskFactory.RunAsync(execute).FileAndForget("Depos/Command"),
            new CommandID(CommandSet, id));
        command.BeforeQueryStatus += (_, _) =>
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var active = Runtime?.ActiveDocumentPath;
            command.Visible = id == 0x0100 || id == 0x0103 || id == 0x0105 || id >= 0x0108
                || (active is not null && (NugetManifest.MatchesPath(active) || DeposRuntime.IsNotesPath(active)));
        };
        service.AddCommand(command);
    }
}
