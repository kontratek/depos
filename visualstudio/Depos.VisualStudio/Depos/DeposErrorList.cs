using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;

namespace Depos.VisualStudio;

/// <summary>
/// The Error List entries of the open manifests and notes files: the same
/// problems their squiggles show (<see cref="DeposRuntime.Problems"/>), so a
/// Denied package, a Not listed one and a notes file Depos replaces are listed
/// with the build's errors. The code of each is in its help keyword, as VS
/// Code's diagnostic codes: <c>org-denied</c>, <c>org-not-listed</c>,
/// <c>org-mode-notes-file</c>, or the lint finding's kind.
/// </summary>
internal sealed class DeposErrorList : IDisposable
{
    private readonly DeposRuntime runtime;
    private readonly ErrorListProvider provider;

    public DeposErrorList(IServiceProvider services, DeposRuntime runtime)
    {
        this.runtime = runtime;
        provider = new ErrorListProvider(services) { ProviderName = "Depos", ProviderGuid = new Guid("5E0E2B44-1E1B-4A8B-9D0E-6C2E0D6C7F31") };
        runtime.Changed += OnChanged;
    }

    public void Dispose()
    {
        runtime.Changed -= OnChanged;
        provider.Tasks.Clear();
        provider.Dispose();
    }

    private void OnChanged(object sender, EventArgs args)
    {
        ThreadHelper.ThrowIfNotOnUIThread();
        provider.SuspendRefresh();
        try
        {
            provider.Tasks.Clear();
            foreach (var path in runtime.OpenDocumentPaths())
            {
                if (runtime.OpenBuffer(path) is not { } buffer) continue;
                foreach (var problem in runtime.Problems(buffer, buffer.CurrentSnapshot))
                {
                    var task = new ErrorTask
                    {
                        Category = TaskCategory.Misc,
                        ErrorCategory = problem.Severity == DeposSeverity.Error ? TaskErrorCategory.Error : TaskErrorCategory.Warning,
                        Text = problem.Message,
                        HelpKeyword = problem.Code,
                        Document = path,
                        Line = problem.Line,
                        Column = problem.Column,
                    };
                    task.Navigate += (_, _) =>
                    {
                        ThreadHelper.ThrowIfNotOnUIThread();
                        // Navigate counts lines from one.
                        task.Line++;
                        provider.Navigate(task, VSConstants.LOGVIEWID_Code);
                        task.Line--;
                    };
                    provider.Tasks.Add(task);
                }
            }
        }
        finally
        {
            provider.ResumeRefresh();
        }
    }
}
