using System.ComponentModel.Design;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Pacmon.Core;

namespace Pacmon.VisualStudio;

[PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
[InstalledProductRegistration("Depos — Dependency Notes", "Dependency notes for .NET/NuGet manifests.", "0.4.0")]
[ProvideMenuResource("Menus.ctmenu", 1)]
[ProvideToolWindow(
    typeof(PacmonToolWindow),
    Style = VsDockStyle.Tabbed,
    Window = "3ae79031-e1bc-11d0-8f78-00a0c9110057")]
// "Depos" is only the category shown in Tools > Options: the settings are kept
// under the page's type name (DialogPage\Pacmon.VisualStudio.PacmonOptionsPage),
// so the class and its namespace keep their names.
[ProvideOptionPage(typeof(PacmonOptionsPage), "Depos", "General", 0, 0, true)]
[ProvideAutoLoad(VSConstants.UICONTEXT.SolutionExists_string, PackageAutoLoadFlags.BackgroundLoad)]
[ProvideAutoLoad(VSConstants.UICONTEXT.NoSolution_string, PackageAutoLoadFlags.BackgroundLoad)]
[Guid(PackageGuid)]
public sealed class PacmonPackage : AsyncPackage
{
    public const string PackageGuid = "0D148B7E-B648-46AA-92EF-E401D72AE221";
    public static readonly Guid CommandSet = new("A6EEA79E-0D28-481F-B55F-32E34EC61796");

    internal PacmonRuntime Runtime { get; private set; } = null!;
    internal PacmonOptionsPage Options => (PacmonOptionsPage)GetDialogPage(typeof(PacmonOptionsPage));

    protected override async Task InitializeAsync(CancellationToken cancellationToken, IProgress<ServiceProgressData> progress)
    {
        await JoinableTaskFactory.SwitchToMainThreadAsync(cancellationToken);
        Runtime = await PacmonRuntime.CreateAsync(this, cancellationToken);
        PacmonRuntime.Current = Runtime;
        await RegisterCommandsAsync(cancellationToken);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) Runtime?.Dispose();
        if (ReferenceEquals(PacmonRuntime.Current, Runtime)) PacmonRuntime.Current = null;
        base.Dispose(disposing);
    }

    internal async Task ShowToolWindowAsync(string? manifestPath = null, string? packageName = null)
    {
        await JoinableTaskFactory.SwitchToMainThreadAsync();
        var window = await ShowToolWindowAsync(typeof(PacmonToolWindow), 0, true, DisposalToken);
        if (window is null) throw new InvalidOperationException("Depos tool window could not be created.");
        if (window.Content is PacmonToolWindowControl control)
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
            (_, _) => JoinableTaskFactory.RunAsync(execute).FileAndForget("Pacmon/Command"),
            new CommandID(CommandSet, id));
        command.BeforeQueryStatus += (_, _) =>
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            var active = Runtime?.ActiveDocumentPath;
            command.Visible = id == 0x0100 || id == 0x0103 || id == 0x0105
                || (active is not null && (NugetManifest.MatchesPath(active) || PacmonRuntime.IsNotesPath(active)));
        };
        service.AddCommand(command);
    }
}
