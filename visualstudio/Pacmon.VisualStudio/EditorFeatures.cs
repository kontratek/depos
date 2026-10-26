using System.ComponentModel.Composition;
using System.IO;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using Microsoft.VisualStudio.Imaging;
using Microsoft.VisualStudio.Imaging.Interop;
using Microsoft.VisualStudio.Language.Intellisense;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Text;
using Microsoft.VisualStudio.Text.Adornments;
using Microsoft.VisualStudio.Text.Editor;
using Microsoft.VisualStudio.Text.Formatting;
using Microsoft.VisualStudio.Text.Tagging;
using Microsoft.VisualStudio.Utilities;
using Pacmon.Core;

namespace Pacmon.VisualStudio;

internal static class EditorFeatureHelpers
{
    public static bool IsManifest(ITextBuffer buffer, out PacmonRuntime runtime, out string path)
    {
        runtime = PacmonRuntime.Current!;
        path = string.Empty;
        if (runtime is null) return false;
        runtime.RegisterBuffer(buffer);
        path = runtime.PathFor(buffer) ?? string.Empty;
        return NugetManifest.MatchesPath(path);
    }

    public static DependencyEntry? DependencyAt(ITextBuffer buffer, int position) =>
        PacmonRuntime.Current is { } runtime
            ? NugetManifest.AtOffset(runtime.Dependencies(buffer), position)
            : null;

    public static SnapshotSpan Span(ITextSnapshot snapshot, SourceRange range)
    {
        var start = Math.Max(0, Math.Min(range.Offset, snapshot.Length));
        var length = Math.Max(0, Math.Min(range.Length, snapshot.Length - start));
        return new SnapshotSpan(snapshot, new Span(start, length));
    }

    public static int DeclarationLineEnd(string text, SourceRange declarationRange)
    {
        var start = Math.Max(0, Math.Min(declarationRange.Offset + declarationRange.Length, text.Length));
        for (var index = start; index < text.Length; index++)
        {
            if (text[index] is '\r' or '\n') return index;
        }
        return text.Length;
    }

    public static string? InlinePreviewText(
        bool documented,
        DecorationMode mode,
        SectionLayers layers,
        InlineSource source)
    {
        if (!documented || mode == DecorationMode.Off) return null;
        return mode == DecorationMode.Badge
            ? "▪ note"
            : $"▪ {Notes.Preview(layers, source)}";
    }
}

[Export(typeof(IAsyncQuickInfoSourceProvider))]
[Name("Pacmon NuGet Quick Info")]
[ContentType("text")]
[Order(Before = "Default Quick Info Presenter")]
internal sealed class PacmonQuickInfoProvider : IAsyncQuickInfoSourceProvider
{
    public IAsyncQuickInfoSource TryCreateQuickInfoSource(ITextBuffer textBuffer)
    {
        PacmonRuntime.Current?.RegisterBuffer(textBuffer);
        return new PacmonQuickInfoSource(textBuffer);
    }
}

internal sealed class PacmonQuickInfoSource : IAsyncQuickInfoSource
{
    private readonly ITextBuffer buffer;
    public PacmonQuickInfoSource(ITextBuffer buffer) => this.buffer = buffer;

    public void Dispose()
    {
    }

    public Task<QuickInfoItem?> GetQuickInfoItemAsync(IAsyncQuickInfoSession session, CancellationToken cancellationToken)
    {
        var point = session.GetTriggerPoint(buffer.CurrentSnapshot);
        if (!point.HasValue
            || !EditorFeatureHelpers.IsManifest(buffer, out var runtime, out var path))
            return Task.FromResult<QuickInfoItem?>(null);
        var dependency = EditorFeatureHelpers.DependencyAt(buffer, point.Value.Position);
        if (dependency is null) return Task.FromResult<QuickInfoItem?>(null);

        var hasNote = runtime.TryGetLayers(path, dependency.NoteKey, out var layers, out var notesPath);
        if (!hasNote) return Task.FromResult<QuickInfoItem?>(null);
        var elements = new List<object>
        {
            new ClassifiedTextElement(
                new ClassifiedTextRun("keyword", dependency.DisplayName, ClassifiedTextRunStyle.Bold),
                new ClassifiedTextRun("comment", $"  — {Path.GetFileName(notesPath)}")),
        };
        var ordered = runtime.Options.InlineSource is InlineSource.AiFirst or InlineSource.AiOnly
            ? new[] { ("Agent notes", layers.Agent), ("Your note", layers.Human) }
            : new[] { ("Your note", layers.Human), ("Agent notes", layers.Agent) };
        var shown = ordered.Where(layer => !string.IsNullOrWhiteSpace(layer.Item2)).ToArray();
        for (var index = 0; index < shown.Length; index++)
        {
            if (index > 0) elements.Add(new ClassifiedTextElement(new ClassifiedTextRun("comment", "────────")));
            elements.Add(new ClassifiedTextElement(
                new ClassifiedTextRun("text", shown[index].Item1, ClassifiedTextRunStyle.Bold)));
            elements.AddRange(MarkdownElements(shown[index].Item2));
        }
        elements.Add(new ClassifiedTextElement(
            new ClassifiedTextRun(
                "text",
                "Edit note",
                () => RunAction(() => runtime.AddOrEditAsync(path, dependency.NoteKey)),
                "Edit this dependency note",
                ClassifiedTextRunStyle.Underline),
            new ClassifiedTextRun("text", "  ·  "),
            new ClassifiedTextRun(
                "text",
                "Open notes file",
                () => RunAction(() => runtime.OpenNotesAsync(path, dependency.NoteKey)),
                notesPath,
                ClassifiedTextRunStyle.Underline)));
        var tracking = buffer.CurrentSnapshot.CreateTrackingSpan(
            EditorFeatureHelpers.Span(buffer.CurrentSnapshot, dependency.PrimaryRange).Span,
            SpanTrackingMode.EdgeInclusive);
        return Task.FromResult<QuickInfoItem?>(new QuickInfoItem(tracking, new ContainerElement(ContainerElementStyle.Stacked, elements)));
    }

    private static void RunAction(Func<Task> action) => ThreadHelper.JoinableTaskFactory.Run(action);

    private static IEnumerable<ClassifiedTextElement> MarkdownElements(string markdown)
    {
        foreach (var rawLine in Regex.Split(markdown.Trim(), "\\r?\\n"))
        {
            var line = rawLine;
            var lineStyle = ClassifiedTextRunStyle.Plain;
            var heading = Regex.Match(line, "^#{1,3}\\s+(.+)$");
            if (heading.Success)
            {
                line = heading.Groups[1].Value;
                lineStyle = ClassifiedTextRunStyle.Bold;
            }
            else if (Regex.IsMatch(line, "^\\s*[-*]\\s+"))
            {
                line = "•  " + Regex.Replace(line, "^\\s*[-*]\\s+", string.Empty);
            }

            if (line.Length == 0)
            {
                yield return new ClassifiedTextElement(new ClassifiedTextRun("text", " "));
                continue;
            }

            var runs = new List<ClassifiedTextRun>();
            var cursor = 0;
            foreach (Match match in Regex.Matches(line, "(`[^`]+`|\\*\\*[^*]+\\*\\*|\\[[^]]+\\]\\([^)]+\\))"))
            {
                if (match.Index > cursor)
                    runs.Add(new ClassifiedTextRun("text", line.Substring(cursor, match.Index - cursor), lineStyle));
                var value = match.Value;
                if (value.StartsWith("`", StringComparison.Ordinal))
                    runs.Add(new ClassifiedTextRun("identifier", value.Substring(1, value.Length - 2), ClassifiedTextRunStyle.UseClassificationFont));
                else if (value.StartsWith("**", StringComparison.Ordinal))
                    runs.Add(new ClassifiedTextRun("text", value.Substring(2, value.Length - 4), lineStyle | ClassifiedTextRunStyle.Bold));
                else
                {
                    var labelEnd = value.IndexOf("](", StringComparison.Ordinal);
                    runs.Add(new ClassifiedTextRun("text", value.Substring(1, labelEnd - 1), lineStyle | ClassifiedTextRunStyle.Underline));
                }
                cursor = match.Index + match.Length;
            }
            if (cursor < line.Length) runs.Add(new ClassifiedTextRun("text", line.Substring(cursor), lineStyle));
            yield return new ClassifiedTextElement(runs);
        }
    }
}

internal sealed class PacmonOrphanTag : IGlyphTag
{
    public PacmonOrphanTag(string packageName) => PackageName = packageName;
    public string PackageName { get; }
}

[Export(typeof(ITaggerProvider))]
[ContentType("text")]
[TagType(typeof(PacmonOrphanTag))]
internal sealed class PacmonOrphanTaggerProvider : ITaggerProvider
{
    public ITagger<T>? CreateTagger<T>(ITextBuffer buffer) where T : ITag => new PacmonOrphanTagger(buffer) as ITagger<T>;
}

internal sealed class PacmonOrphanTagger : ITagger<PacmonOrphanTag>, IDisposable
{
    private readonly ITextBuffer buffer;
    private readonly PacmonRuntime? runtime;
    public PacmonOrphanTagger(ITextBuffer buffer)
    {
        this.buffer = buffer;
        runtime = PacmonRuntime.Current;
        runtime?.RegisterBuffer(buffer);
        buffer.Changed += OnChanged;
        if (runtime is not null) runtime.Changed += OnRuntimeChanged;
    }

    public event EventHandler<SnapshotSpanEventArgs>? TagsChanged;

    public IEnumerable<ITagSpan<PacmonOrphanTag>> GetTags(NormalizedSnapshotSpanCollection spans)
    {
        if (spans.Count == 0 || runtime is null) yield break;
        var snapshot = spans[0].Snapshot;
        foreach (var orphan in runtime.OrphansForNotesBuffer(buffer))
        {
            if (orphan.HeadingLine < 0 || orphan.HeadingLine >= snapshot.LineCount) continue;
            var line = snapshot.GetLineFromLineNumber(orphan.HeadingLine);
            var span = line.Length > 0 ? new SnapshotSpan(line.Start, 1) : new SnapshotSpan(line.Start, 0);
            if (spans.IntersectsWith(span)) yield return new TagSpan<PacmonOrphanTag>(span, new PacmonOrphanTag(orphan.Name));
        }
    }

    public void Dispose()
    {
        buffer.Changed -= OnChanged;
        if (runtime is not null) runtime.Changed -= OnRuntimeChanged;
    }

    private void OnChanged(object sender, TextContentChangedEventArgs args) => Raise();
    private void OnRuntimeChanged(object sender, EventArgs args) => Raise();
    private void Raise()
    {
        var snapshot = buffer.CurrentSnapshot;
        TagsChanged?.Invoke(this, new SnapshotSpanEventArgs(new SnapshotSpan(snapshot, 0, snapshot.Length)));
    }
}

[Export(typeof(IGlyphFactoryProvider))]
[Name("Pacmon orphan note glyph")]
[ContentType("text")]
[TagType(typeof(PacmonOrphanTag))]
internal sealed class PacmonOrphanGlyphFactoryProvider : IGlyphFactoryProvider
{
    public IGlyphFactory GetGlyphFactory(IWpfTextView view, IWpfTextViewMargin margin) => new PacmonOrphanGlyphFactory();
}

internal sealed class PacmonOrphanGlyphFactory : IGlyphFactory
{
    public UIElement? GenerateGlyph(IWpfTextViewLine line, IGlyphTag tag)
    {
        if (tag is not PacmonOrphanTag orphan) return null;
        var glyph = new TextBlock
        {
            Text = "?",
            ToolTip = $"No current NuGet declaration matches {orphan.PackageName}. The note is kept as an orphan.",
            FontWeight = FontWeights.SemiBold,
            Opacity = 0.7,
        };
        glyph.SetResourceReference(TextBlock.ForegroundProperty, VsBrushes.ToolWindowTextKey);
        return glyph;
    }
}

[Export(typeof(IViewTaggerProvider))]
[Name("Pacmon inline dependency notes")]
[ContentType("text")]
[TextViewRole(PredefinedTextViewRoles.Document)]
[TagType(typeof(IntraTextAdornmentTag))]
internal sealed class PacmonInlineAdornmentProvider : IViewTaggerProvider
{
    public ITagger<T>? CreateTagger<T>(ITextView textView, ITextBuffer buffer) where T : ITag
    {
        if (textView is not IWpfTextView wpfTextView || textView.TextBuffer != buffer) return null;
        return wpfTextView.Properties.GetOrCreateSingletonProperty(
            () => new PacmonInlineAdornmentTagger(wpfTextView, buffer)) as ITagger<T>;
    }
}

internal sealed class PacmonInlineAdornmentTagger : ITagger<IntraTextAdornmentTag>, IDisposable
{
    private readonly IWpfTextView view;
    private readonly ITextBuffer buffer;
    private readonly PacmonRuntime? runtime;

    public PacmonInlineAdornmentTagger(IWpfTextView view, ITextBuffer buffer)
    {
        this.view = view;
        this.buffer = buffer;
        runtime = PacmonRuntime.Current;
        runtime?.RegisterBuffer(buffer);
        buffer.Changed += OnBufferChanged;
        view.Closed += OnClosed;
        if (runtime is not null) runtime.Changed += OnRuntimeChanged;
    }

    public event EventHandler<SnapshotSpanEventArgs>? TagsChanged;

    public IEnumerable<ITagSpan<IntraTextAdornmentTag>> GetTags(NormalizedSnapshotSpanCollection spans)
    {
        if (spans.Count == 0
            || runtime is null
            || !EditorFeatureHelpers.IsManifest(buffer, out _, out var path))
            yield break;
        var snapshot = spans[0].Snapshot;
        var text = snapshot.GetText();
        foreach (var dependency in runtime.Dependencies(buffer))
        {
            var documented = runtime.TryGetLayers(path, dependency.NoteKey, out var layers);
            var previewText = EditorFeatureHelpers.InlinePreviewText(
                documented,
                runtime.Options.Decorations,
                layers,
                runtime.Options.InlineSource);
            if (!runtime.Options.MarginIcon
                && previewText is null)
                continue;
            if (runtime.Options.MarginIcon)
            {
                var iconAnchor = Math.Max(0, Math.Min(dependency.IconRange.Offset, snapshot.Length));
                if (Contains(spans, iconAnchor))
                {
                    var span = new SnapshotSpan(snapshot, new Span(iconAnchor, 0));
                    yield return new TagSpan<IntraTextAdornmentTag>(
                        span,
                        new IntraTextAdornmentTag(
                            CreatePacmonIcon(path, dependency, documented),
                            null,
                            PositionAffinity.Predecessor));
                }
            }

            if (previewText is not null)
            {
                var previewAnchor = EditorFeatureHelpers.DeclarationLineEnd(text, dependency.DeclarationRange);
                if (Contains(spans, previewAnchor))
                {
                    var span = new SnapshotSpan(snapshot, new Span(previewAnchor, 0));
                    yield return new TagSpan<IntraTextAdornmentTag>(
                        span,
                        new IntraTextAdornmentTag(
                            CreatePreview(previewText),
                            null,
                            PositionAffinity.Predecessor));
                }
            }
        }
    }

    public void Dispose() => Detach();

    private static bool Contains(NormalizedSnapshotSpanCollection spans, int position) =>
        spans.Any(span => position >= span.Start.Position && position <= span.End.Position);

    private static FrameworkElement CreatePreview(string text)
    {
        var preview = new TextBlock
        {
            Text = text,
            FontStyle = FontStyles.Italic,
            Margin = new Thickness(18, 0, 3, 0),
            VerticalAlignment = VerticalAlignment.Center,
            IsHitTestVisible = false,
        };
        preview.SetResourceReference(TextBlock.ForegroundProperty, VsBrushes.GrayTextKey);
        return preview;
    }

    private static FrameworkElement CreatePacmonIcon(
        string manifestPath,
        DependencyEntry dependency,
        bool documented)
    {
        var mark = new PacmonMarkControl
        {
            Documented = documented,
            Width = 14,
            Height = 14,
            Margin = new Thickness(0, 0, 5, 0),
            Cursor = Cursors.Hand,
            ToolTip = documented ? "Edit dependency note" : "Add dependency note",
            VerticalAlignment = VerticalAlignment.Center,
        };
        mark.MouseLeftButtonDown += (_, args) =>
        {
            args.Handled = true;
            ThreadHelper.JoinableTaskFactory.Run(() =>
                PacmonRuntime.Current!.AddOrEditAsync(manifestPath, dependency.NoteKey));
        };
        return mark;
    }

    private void OnBufferChanged(object sender, TextContentChangedEventArgs args) => Raise();
    private void OnRuntimeChanged(object sender, EventArgs args) => Raise();
    private void OnClosed(object sender, EventArgs args)
    {
        Detach();
        view.Properties.RemoveProperty(typeof(PacmonInlineAdornmentTagger));
    }

    private void Detach()
    {
        buffer.Changed -= OnBufferChanged;
        view.Closed -= OnClosed;
        if (runtime is not null) runtime.Changed -= OnRuntimeChanged;
    }

    private void Raise()
    {
        var snapshot = buffer.CurrentSnapshot;
        TagsChanged?.Invoke(this, new SnapshotSpanEventArgs(new SnapshotSpan(snapshot, 0, snapshot.Length)));
    }
}

[Export(typeof(IMouseProcessorProvider))]
[Name("Pacmon dependency navigation")]
[ContentType("text")]
[TextViewRole(PredefinedTextViewRoles.Interactive)]
internal sealed class PacmonMouseProcessorProvider : IMouseProcessorProvider
{
    public IMouseProcessor GetAssociatedProcessor(IWpfTextView wpfTextView) => new PacmonMouseProcessor(wpfTextView);
}

internal sealed class PacmonMouseProcessor : MouseProcessorBase
{
    private readonly IWpfTextView view;
    public PacmonMouseProcessor(IWpfTextView view) => this.view = view;

    public override void PreprocessMouseLeftButtonDown(MouseButtonEventArgs args)
    {
        var runtime = PacmonRuntime.Current;
        if (runtime is null || !runtime.Options.Navigation || Keyboard.Modifiers != ModifierKeys.Control) return;
        var point = args.GetPosition(view.VisualElement);
        var line = view.TextViewLines.GetTextViewLineContainingYCoordinate(point.Y + view.ViewportTop);
        var bufferPoint = line?.GetBufferPositionFromXCoordinate(point.X + view.ViewportLeft);
        if (!bufferPoint.HasValue
            || !EditorFeatureHelpers.IsManifest(view.TextBuffer, out _, out var path)) return;
        var dependency = EditorFeatureHelpers.DependencyAt(view.TextBuffer, bufferPoint.Value.Position);
        if (dependency is null) return;
        args.Handled = true;
        ThreadHelper.JoinableTaskFactory.Run(() => runtime.NavigateToNoteAsync(path, dependency.NoteKey));
    }
}

[Export(typeof(ITaggerProvider))]
[ContentType("text")]
[TagType(typeof(IErrorTag))]
internal sealed class PacmonErrorTaggerProvider : ITaggerProvider
{
    public ITagger<T>? CreateTagger<T>(ITextBuffer buffer) where T : ITag => new PacmonErrorTagger(buffer) as ITagger<T>;
}

internal sealed class PacmonErrorTagger : ITagger<IErrorTag>, IDisposable
{
    private readonly ITextBuffer buffer;
    private readonly PacmonRuntime? runtime;
    public PacmonErrorTagger(ITextBuffer buffer)
    {
        this.buffer = buffer;
        runtime = PacmonRuntime.Current;
        runtime?.RegisterBuffer(buffer);
        buffer.Changed += OnChanged;
        if (runtime is not null) runtime.Changed += OnRuntimeChanged;
    }

    public event EventHandler<SnapshotSpanEventArgs>? TagsChanged;

    public IEnumerable<ITagSpan<IErrorTag>> GetTags(NormalizedSnapshotSpanCollection spans)
    {
        if (spans.Count == 0 || runtime is null) yield break;
        var snapshot = spans[0].Snapshot;
        foreach (var finding in runtime.LintNotesBuffer(buffer))
        {
            if (finding.Line < 0 || finding.Line >= snapshot.LineCount) continue;
            var line = snapshot.GetLineFromLineNumber(finding.Line);
            var start = Math.Min(line.End.Position, line.Start.Position + Math.Max(0, finding.StartColumn));
            var end = finding.EndColumn > finding.StartColumn
                ? Math.Min(line.End.Position, line.Start.Position + finding.EndColumn)
                : line.End.Position;
            var safeStart = start;
            var safeEnd = Math.Min(snapshot.Length, Math.Max(start + 1, end));
            if (safeEnd == safeStart && safeStart > 0) safeStart--;
            var span = new SnapshotSpan(snapshot, Span.FromBounds(safeStart, safeEnd));
            if (spans.IntersectsWith(span))
                yield return new TagSpan<IErrorTag>(span, new ErrorTag(PredefinedErrorTypeNames.Warning, finding.Message));
        }
    }

    public void Dispose()
    {
        buffer.Changed -= OnChanged;
        if (runtime is not null) runtime.Changed -= OnRuntimeChanged;
    }

    private void OnChanged(object sender, TextContentChangedEventArgs args) => Raise();
    private void OnRuntimeChanged(object sender, EventArgs args) => Raise();
    private void Raise()
    {
        var snapshot = buffer.CurrentSnapshot;
        TagsChanged?.Invoke(this, new SnapshotSpanEventArgs(new SnapshotSpan(snapshot, 0, snapshot.Length)));
    }
}

[Export(typeof(ISuggestedActionsSourceProvider))]
[Name("Pacmon dependency note actions")]
[ContentType("text")]
internal sealed class PacmonSuggestedActionsProvider : ISuggestedActionsSourceProvider
{
    public ISuggestedActionsSource CreateSuggestedActionsSource(ITextView textView, ITextBuffer textBuffer) =>
        new PacmonSuggestedActionsSource(textView, textBuffer);
}

internal sealed class PacmonSuggestedActionsSource : ISuggestedActionsSource
{
    private readonly ITextView view;
    private readonly ITextBuffer buffer;
    public PacmonSuggestedActionsSource(ITextView view, ITextBuffer buffer)
    {
        this.view = view;
        this.buffer = buffer;
    }

    public event EventHandler<EventArgs> SuggestedActionsChanged
    {
        add { }
        remove { }
    }

    public void Dispose()
    {
    }

    public Task<bool> HasSuggestedActionsAsync(ISuggestedActionCategorySet requestedActionCategories, SnapshotSpan range, CancellationToken cancellationToken) =>
        Task.FromResult(ActionAt(range.Start.Position) is not null);

    public IEnumerable<SuggestedActionSet> GetSuggestedActions(
        ISuggestedActionCategorySet requestedActionCategories,
        SnapshotSpan range,
        CancellationToken cancellationToken)
    {
        var action = ActionAt(range.Start.Position);
        return action is null
            ? Array.Empty<SuggestedActionSet>()
            : new[]
            {
                new SuggestedActionSet(
                    PredefinedSuggestedActionCategoryNames.Any,
                    new[] { action },
                    null,
                    SuggestedActionSetPriority.Medium,
                    range.Span),
            };
    }

    public bool TryGetTelemetryId(out Guid telemetryId)
    {
        telemetryId = Guid.Empty;
        return false;
    }

    private ISuggestedAction? ActionAt(int position)
    {
        var runtime = PacmonRuntime.Current;
        if (runtime is null || !runtime.Options.QuickAction) return null;
        runtime.RegisterBuffer(buffer);
        var documentPath = runtime.PathFor(buffer);
        if (documentPath is not null && PacmonRuntime.IsNotesPath(documentPath))
        {
            var line = buffer.CurrentSnapshot.GetLineFromPosition(Math.Min(position, buffer.CurrentSnapshot.Length));
            // Formatting does not help a file that is not read: its warning offers nothing.
            return runtime.LintNotesBuffer(buffer).Any(finding =>
                    finding.Line == line.LineNumber && finding.Kind != Notes.ShadowedKind)
                ? new PacmonNormalizeSuggestedAction(documentPath)
                : null;
        }
        if (!EditorFeatureHelpers.IsManifest(buffer, out _, out var path)) return null;
        var dependency = EditorFeatureHelpers.DependencyAt(buffer, position);
        return dependency is null ? null : new PacmonSuggestedAction(path, dependency);
    }
}

internal sealed class PacmonSuggestedAction : ISuggestedAction
{
    private readonly string path;
    private readonly DependencyEntry dependency;
    public PacmonSuggestedAction(string path, DependencyEntry dependency)
    {
        this.path = path;
        this.dependency = dependency;
    }

    public string DisplayText => $"Add/Edit dependency note for {dependency.DisplayName}";
    public ImageMoniker IconMoniker => KnownMonikers.Note;
    public string IconAutomationText => "Depos dependency note";
    public string InputGestureText => string.Empty;
    public bool HasActionSets => false;
    public bool HasPreview => false;
    public Task<IEnumerable<SuggestedActionSet>?> GetActionSetsAsync(CancellationToken cancellationToken) =>
        Task.FromResult<IEnumerable<SuggestedActionSet>?>(null);
    public Task<object?> GetPreviewAsync(CancellationToken cancellationToken) => Task.FromResult<object?>(null);
    public void Invoke(CancellationToken cancellationToken) =>
        ThreadHelper.JoinableTaskFactory.Run(() => PacmonRuntime.Current!.AddOrEditAsync(path, dependency.NoteKey));
    public bool TryGetTelemetryId(out Guid telemetryId)
    {
        telemetryId = Guid.Empty;
        return false;
    }
    public void Dispose()
    {
    }
}

internal sealed class PacmonNormalizeSuggestedAction : ISuggestedAction
{
    private readonly string path;
    public PacmonNormalizeSuggestedAction(string path) => this.path = path;
    public string DisplayText => "Format NuGet dependency notes";
    public ImageMoniker IconMoniker => KnownMonikers.FormatDocument;
    public string IconAutomationText => "Format dependency notes";
    public string InputGestureText => string.Empty;
    public bool HasActionSets => false;
    public bool HasPreview => false;
    public Task<IEnumerable<SuggestedActionSet>?> GetActionSetsAsync(CancellationToken cancellationToken) =>
        Task.FromResult<IEnumerable<SuggestedActionSet>?>(null);
    public Task<object?> GetPreviewAsync(CancellationToken cancellationToken) => Task.FromResult<object?>(null);
    public void Invoke(CancellationToken cancellationToken) =>
        ThreadHelper.JoinableTaskFactory.Run(() => PacmonRuntime.Current!.NormalizeNotesAsync(path));
    public bool TryGetTelemetryId(out Guid telemetryId)
    {
        telemetryId = Guid.Empty;
        return false;
    }
    public void Dispose()
    {
    }
}
