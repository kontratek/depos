using System.ComponentModel.Design;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Depos.Core;

namespace Depos.VisualStudio;

[PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
[InstalledProductRegistration("Depos — Dependency Notes", "Dependency notes for .NET/NuGet manifests.", "0.4.0")]
[ProvideMenuResource("Menus.ctmenu", 1)]
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
    public const string PackageGuid = "F797BD3C-55F1-4225-8D64-BC10034919EC";
    public static readonly Guid CommandSet = new("9C0D68A1-5643-4FBD-A674-D9171E992BB0");

    internal DeposRuntime Runtime { get; private set; } = null!;
    internal DeposOptionsPage Options => (DeposOptionsPage)GetDialogPage(typeof(DeposOptionsPage));

    protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
    {
        await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        Runtime = await DeposRuntime.CreateAsync(this, cancellationToken);
        DeposRuntime.Current = Runtime;
        await RegisterCommandsAsync(cancellationToken);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) Runtime?.Dispose();
        if (ReferenceEquals(DeposRuntime.Current, Runtime)) DeposRuntime.Current = null;
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
            command.Visible = id == 0x0100 || id == 0x0103 || id == 0x0105
                || (active is not null && (NugetManifest.MatchesPath(active) || DeposRuntime.IsNotesPath(active)));
        };
        service.AddCommand(command);
    }
}
