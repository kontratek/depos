using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.Imaging.Interop;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;

namespace Depos.VisualStudio;

internal enum InfoBarKind
{
    Information,
    Warning,
    Error,
}

/// <summary>An action of an info bar: a link that runs on the UI thread.</summary>
internal sealed record InfoBarAction(string Label, Func<Task> Run);

/// <summary>
/// Visual Studio's info bars for Depos: one at a time at the top of the main
/// window for what the IDE would show as a notification, and one per document
/// frame for the notice on a notes file Depos replaces.
/// </summary>
internal sealed class DeposInfoBars
{
    private readonly AsyncPackage package;
    private InfoBarHandle? main;

    public DeposInfoBars(AsyncPackage package) => this.package = package;

    /// <summary>Replaces the main window's Depos bar.</summary>
    public async Task ShowAsync(string text, InfoBarKind kind, params InfoBarAction[] actions)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        main?.Close();
        main = null;
        var shell = await package.GetServiceAsync(typeof(SVsShell)) as IVsShell;
        if (shell is null) return;
        if (shell.GetProperty((int)__VSSPROPID7.VSSPROPID_MainWindowInfoBarHost, out var value) != 0
            || value is not IVsInfoBarHost host) return;
        main = await CreateAsync(host, text, kind, actions);
    }

    /// <summary>Closes the main window's Depos bar when it still shows <paramref name="text"/>.</summary>
    public async Task CloseAsync(string text)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        if (main is null || main.Text != text) return;
        main.Close();
        main = null;
    }

    /// <summary>A bar in <paramref name="host"/>, such as a document frame's; the caller closes it.</summary>
    public async Task<InfoBarHandle?> CreateAsync(IVsInfoBarHost host, string text, InfoBarKind kind, params InfoBarAction[] actions)
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        if (await package.GetServiceAsync(typeof(SVsInfoBarUIFactory)) is not IVsInfoBarUIFactory factory) return null;
        ImageMoniker image = kind switch
        {
            InfoBarKind.Error => KnownMonikers.StatusError,
            InfoBarKind.Warning => KnownMonikers.StatusWarning,
            _ => KnownMonikers.StatusInformation,
        };
        var model = new InfoBarModel(
            new[] { new InfoBarTextSpan(text) },
            actions.Select(action => new InfoBarHyperlink(action.Label, action)).ToArray(),
            image,
            isCloseButtonVisible: true);
        var element = factory.CreateInfoBar(model);
        var handle = new InfoBarHandle(host, element, text);
        host.AddInfoBar(element);
        return handle;
    }
}

/// <summary>One shown bar. Its links run their action; closing it, by the user or by code, is final.</summary>
internal sealed class InfoBarHandle : IVsInfoBarUIEvents
{
    private readonly IVsInfoBarHost host;
    private readonly IVsInfoBarUIElement element;
    private uint cookie;
    private bool closed;

    public InfoBarHandle(IVsInfoBarHost host, IVsInfoBarUIElement element, string text)
    {
        ThreadHelper.ThrowIfNotOnUIThread();
        this.host = host;
        this.element = element;
        Text = text;
        element.Advise(this, out cookie);
    }

    public string Text { get; }
    public bool Closed => closed;

    public void Close()
    {
        ThreadHelper.ThrowIfNotOnUIThread();
        if (closed) return;
        closed = true;
        element.Unadvise(cookie);
        host.RemoveInfoBar(element);
    }

    public void OnClosed(IVsInfoBarUIElement infoBarUIElement)
    {
        ThreadHelper.ThrowIfNotOnUIThread();
        if (closed) return;
        closed = true;
        infoBarUIElement.Unadvise(cookie);
    }

    public void OnActionItemClicked(IVsInfoBarUIElement infoBarUIElement, IVsInfoBarActionItem actionItem)
    {
        ThreadHelper.ThrowIfNotOnUIThread();
        if (actionItem.ActionContext is InfoBarAction action) DeposPackage.Forget(action.Run, "Depos/InfoBar");
    }
}
