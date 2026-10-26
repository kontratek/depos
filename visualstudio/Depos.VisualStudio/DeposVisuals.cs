using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;

namespace Depos.VisualStudio;

internal sealed class DeposMarkControl : Canvas
{
    private bool themeSubscribed;

    public static readonly DependencyProperty DocumentedProperty = DependencyProperty.Register(
        nameof(Documented),
        typeof(bool),
        typeof(DeposMarkControl),
        new FrameworkPropertyMetadata(false, (source, _) => ((DeposMarkControl)source).Draw()));

    public DeposMarkControl()
    {
        Width = 14;
        Height = 14;
        SnapsToDevicePixels = true;
        Loaded += OnLoaded;
        Unloaded += OnUnloaded;
    }

    public bool Documented
    {
        get => (bool)GetValue(DocumentedProperty);
        set => SetValue(DocumentedProperty, value);
    }

    private void Draw()
    {
        Children.Clear();
        Opacity = Documented ? 1 : 0.68;
        var brush = DeposMarkPalette.Brush(Documented, DeposMarkPalette.IsDarkTheme());
        AddBar(3.5, 0, 10.5, 3.2, brush);
        AddBar(0, 5.4, 10.5, 3.2, brush);
        AddBar(0, 10.8, 10.5, 3.2, brush);
    }

    private void AddBar(double left, double top, double width, double height, Brush brush)
    {
        var bar = new Rectangle
        {
            Width = width,
            Height = height,
            Fill = Documented ? brush : Brushes.Transparent,
            Stroke = Documented ? null : brush,
            StrokeThickness = Documented ? 0 : 1,
            SnapsToDevicePixels = true,
        };
        SetLeft(bar, left);
        SetTop(bar, top);
        Children.Add(bar);
    }

    private void OnLoaded(object sender, RoutedEventArgs args)
    {
        if (!themeSubscribed)
        {
            VSColorTheme.ThemeChanged += OnThemeChanged;
            themeSubscribed = true;
        }
        Draw();
    }

    private void OnUnloaded(object sender, RoutedEventArgs args)
    {
        if (!themeSubscribed) return;
        VSColorTheme.ThemeChanged -= OnThemeChanged;
        themeSubscribed = false;
    }

    private void OnThemeChanged(ThemeChangedEventArgs args) => Draw();
}

internal static class DeposMarkPalette
{
    private const int DocumentedDarkRgb = 0x00ff66;
    private const int DocumentedLightRgb = 0x00662f;
    private const int UndocumentedDarkRgb = 0x9d9d9d;
    private const int UndocumentedLightRgb = 0x8c8c8c;
    private static readonly Brush DocumentedDark = FrozenBrush(DocumentedDarkRgb);
    private static readonly Brush DocumentedLight = FrozenBrush(DocumentedLightRgb);
    private static readonly Brush UndocumentedDark = FrozenBrush(UndocumentedDarkRgb);
    private static readonly Brush UndocumentedLight = FrozenBrush(UndocumentedLightRgb);

    public static Brush Brush(bool documented, bool darkTheme) => documented
        ? darkTheme ? DocumentedDark : DocumentedLight
        : darkTheme ? UndocumentedDark : UndocumentedLight;

    public static int Rgb(bool documented, bool darkTheme) => documented
        ? darkTheme ? DocumentedDarkRgb : DocumentedLightRgb
        : darkTheme ? UndocumentedDarkRgb : UndocumentedLightRgb;

    public static bool IsDarkTheme()
    {
        var background = VSColorTheme.GetThemedColor(EnvironmentColors.ToolWindowBackgroundColorKey);
        return IsDark(background.R, background.G, background.B);
    }

    public static bool IsDark(byte red, byte green, byte blue) =>
        (red * 299 + green * 587 + blue * 114) < 128000;

    private static Brush FrozenBrush(int rgb)
    {
        var brush = new SolidColorBrush(Color.FromRgb(
            (byte)((rgb >> 16) & 0xff),
            (byte)((rgb >> 8) & 0xff),
            (byte)(rgb & 0xff)));
        brush.Freeze();
        return brush;
    }
}

internal sealed class MarkdownPresenter : StackPanel
{
    private static readonly Regex InlinePattern = new(
        "(`[^`]+`|\\*\\*[^*]+\\*\\*|\\[[^]]+\\]\\([^)]+\\))",
        RegexOptions.Compiled);

    public MarkdownPresenter()
    {
        Orientation = Orientation.Vertical;
    }

    public void SetMarkdown(string markdown, string emptyText)
    {
        Children.Clear();
        var lines = Regex.Split(markdown ?? string.Empty, "\\r?\\n");
        if (lines.All(string.IsNullOrWhiteSpace))
        {
            var empty = new TextBlock
            {
                Text = emptyText,
                Opacity = 0.68,
                TextWrapping = TextWrapping.Wrap,
                FontStyle = FontStyles.Italic,
            };
            DeposVisuals.ApplySecondaryTextTheme(empty);
            Children.Add(empty);
            return;
        }

        foreach (var rawLine in lines)
        {
            var line = rawLine.TrimEnd();
            if (line.Length == 0)
            {
                Children.Add(new Border { Height = 7 });
                continue;
            }

            var text = new TextBlock { TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 1, 0, 1) };
            DeposVisuals.ApplyPrimaryTextTheme(text);
            var heading = Regex.Match(line, "^(#{1,3})\\s+(.+)$");
            if (heading.Success)
            {
                text.FontWeight = FontWeights.SemiBold;
                text.FontSize += 3 - heading.Groups[1].Value.Length;
                AppendInline(text, heading.Groups[2].Value);
            }
            else if (Regex.IsMatch(line, "^\\s*[-*]\\s+"))
            {
                text.Inlines.Add(new Run("•  ") { FontWeight = FontWeights.SemiBold });
                AppendInline(text, Regex.Replace(line, "^\\s*[-*]\\s+", string.Empty));
            }
            else
            {
                AppendInline(text, line);
            }
            Children.Add(text);
        }
    }

    private static void AppendInline(TextBlock target, string text)
    {
        var cursor = 0;
        foreach (Match match in InlinePattern.Matches(text))
        {
            if (match.Index > cursor) target.Inlines.Add(new Run(text.Substring(cursor, match.Index - cursor)));
            var value = match.Value;
            if (value.StartsWith("`", StringComparison.Ordinal))
            {
                target.Inlines.Add(new Run(value.Substring(1, value.Length - 2))
                {
                    FontFamily = new FontFamily("Consolas"),
                });
            }
            else if (value.StartsWith("**", StringComparison.Ordinal))
            {
                target.Inlines.Add(new Run(value.Substring(2, value.Length - 4)) { FontWeight = FontWeights.SemiBold });
            }
            else
            {
                var labelEnd = value.IndexOf("](", StringComparison.Ordinal);
                target.Inlines.Add(new Run(value.Substring(1, labelEnd - 1))
                {
                    TextDecorations = TextDecorations.Underline,
                });
            }
            cursor = match.Index + match.Length;
        }
        if (cursor < text.Length) target.Inlines.Add(new Run(text.Substring(cursor)));
    }
}

internal static class DeposVisuals
{
    public static void ApplyToolWindowTheme(FrameworkElement element)
    {
        element.SetResourceReference(Panel.BackgroundProperty, VsBrushes.ToolWindowBackgroundKey);
        element.SetResourceReference(TextElement.ForegroundProperty, VsBrushes.ToolWindowTextKey);
    }

    public static void ApplyBorderTheme(Border border) =>
        border.SetResourceReference(Border.BorderBrushProperty, VsBrushes.CommandBarBorderKey);

    public static void ApplyPrimaryTextTheme(FrameworkElement element) =>
        element.SetResourceReference(TextElement.ForegroundProperty, VsBrushes.ToolWindowTextKey);

    public static void ApplySecondaryTextTheme(FrameworkElement element) =>
        element.SetResourceReference(TextElement.ForegroundProperty, VsBrushes.GrayTextKey);

    public static void ApplyToolWindowViewTheme(FrameworkElement element)
    {
        ApplyToolWindowTheme(element);
        ApplyNativeControlStyles(element);
    }

    public static void ApplyNativeControlStyles(DependencyObject root)
    {
        if (root is Expander expander)
            expander.SetResourceReference(Control.ForegroundProperty, VsBrushes.ToolWindowTextKey);

        switch (root)
        {
            case Button button:
                button.SetResourceReference(FrameworkElement.StyleProperty, VsResourceKeys.ButtonStyleKey);
                break;
            case CheckBox checkBox:
                checkBox.SetResourceReference(FrameworkElement.StyleProperty, VsResourceKeys.CheckBoxStyleKey);
                break;
            case RadioButton radioButton:
                radioButton.SetResourceReference(FrameworkElement.StyleProperty, VsResourceKeys.ThemedDialogRadioButtonStyleKey);
                break;
            case ComboBox comboBox:
                comboBox.SetResourceReference(FrameworkElement.StyleProperty, VsResourceKeys.ComboBoxStyleKey);
                break;
            case TextBox textBox:
                textBox.SetResourceReference(FrameworkElement.StyleProperty, VsResourceKeys.TextBoxStyleKey);
                break;
            case ProgressBar progressBar:
                progressBar.SetResourceReference(FrameworkElement.StyleProperty, VsResourceKeys.ProgressBarStyleKey);
                break;
            case ListView listView:
                listView.SetResourceReference(FrameworkElement.StyleProperty, VsResourceKeys.ThemedDialogListViewStyleKey);
                break;
            case ListBox listBox:
                listBox.SetResourceReference(FrameworkElement.StyleProperty, VsResourceKeys.ThemedDialogListBoxStyleKey);
                break;
            case ScrollViewer scrollViewer:
                scrollViewer.SetResourceReference(FrameworkElement.StyleProperty, VsResourceKeys.ScrollViewerStyleKey);
                break;
        }

        foreach (var child in LogicalTreeHelper.GetChildren(root).OfType<DependencyObject>())
            ApplyNativeControlStyles(child);
    }
}
