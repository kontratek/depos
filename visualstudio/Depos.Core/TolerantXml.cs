using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace Depos.Core;

public static class TolerantXml
{
    private static readonly Regex EntityPattern = new(
        "&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static string Decode(string value) => EntityPattern.Replace(value, match =>
    {
        var body = match.Groups[1].Value.ToLowerInvariant();
        switch (body)
        {
            case "amp": return "&";
            case "lt": return "<";
            case "gt": return ">";
            case "quot": return "\"";
            case "apos": return "'";
        }

        var hex = body.StartsWith("#x", StringComparison.Ordinal);
        var digits = body.Substring(hex ? 2 : 1);
        if (!int.TryParse(digits, hex ? NumberStyles.HexNumber : NumberStyles.Integer,
                CultureInfo.InvariantCulture, out var code)
            || code < 0
            || code > 0x10ffff
            || code is >= 0xd800 and <= 0xdfff)
        {
            return match.Value;
        }

        return char.ConvertFromUtf32(code);
    });

    public static IReadOnlyList<XmlNode> Parse(string text)
    {
        var roots = new List<XmlNode>();
        var stack = new List<XmlNode>();
        var cursor = 0;
        while (cursor < text.Length)
        {
            var open = text.IndexOf('<', cursor);
            if (open < 0) break;
            if (StartsWith(text, open, "<!--"))
            {
                cursor = SkipDelimited(text, open + 4, "-->");
                continue;
            }
            if (StartsWith(text, open, "<![CDATA["))
            {
                cursor = SkipDelimited(text, open + 9, "]]>");
                continue;
            }
            if (StartsWith(text, open, "<?"))
            {
                cursor = SkipDelimited(text, open + 2, "?>");
                continue;
            }
            if (StartsWith(text, open, "<!"))
            {
                cursor = SkipDelimited(text, open + 2, ">");
                continue;
            }

            char? quote = null;
            var end = open + 1;
            for (; end < text.Length; end++)
            {
                var current = text[end];
                if (quote.HasValue)
                {
                    if (current == quote.Value) quote = null;
                }
                else if (current is '\'' or '"') quote = current;
                else if (current == '>') break;
            }
            if (end >= text.Length) break;

            var contentStart = open + 1;
            while (contentStart < end && char.IsWhiteSpace(text[contentStart])) contentStart++;
            if (contentStart < end && text[contentStart] == '/')
            {
                contentStart++;
                while (contentStart < end && char.IsWhiteSpace(text[contentStart])) contentStart++;
                var nameEnd = contentStart;
                while (nameEnd < end && !char.IsWhiteSpace(text[nameEnd])) nameEnd++;
                var name = LocalName(text.Substring(contentStart, nameEnd - contentStart));
                for (var index = stack.Count - 1; index >= 0; index--)
                {
                    if (!string.Equals(stack[index].Name, name, StringComparison.Ordinal)) continue;
                    stack[index].CloseStart = open;
                    stack.RemoveRange(index, stack.Count - index);
                    break;
                }
            }
            else
            {
                var nameEnd = contentStart;
                while (nameEnd < end && !char.IsWhiteSpace(text[nameEnd]) && text[nameEnd] != '/') nameEnd++;
                var rawName = text.Substring(contentStart, nameEnd - contentStart);
                if (rawName.Length > 0)
                {
                    var selfClosing = IsSelfClosing(text, nameEnd, end);
                    var node = new XmlNode
                    {
                        Name = LocalName(rawName),
                        OpenStart = open,
                        OpenEnd = end + 1,
                        CloseStart = end + 1,
                        Attributes = ReadAttributes(text, nameEnd, end),
                    };
                    if (stack.Count > 0) stack[stack.Count - 1].Children.Add(node);
                    else roots.Add(node);
                    if (!selfClosing) stack.Add(node);
                }
            }

            cursor = end + 1;
        }

        foreach (var node in stack) node.CloseStart = text.Length;
        return roots;
    }

    private static IReadOnlyList<XmlAttribute> ReadAttributes(string text, int start, int end)
    {
        var result = new List<XmlAttribute>();
        var cursor = start;
        while (cursor < end)
        {
            while (cursor < end && char.IsWhiteSpace(text[cursor])) cursor++;
            if (cursor >= end || text[cursor] == '/') break;
            var nameStart = cursor;
            while (cursor < end && !char.IsWhiteSpace(text[cursor]) && text[cursor] != '=' && text[cursor] != '/') cursor++;
            var rawName = text.Substring(nameStart, cursor - nameStart);
            while (cursor < end && char.IsWhiteSpace(text[cursor])) cursor++;
            if (rawName.Length == 0 || cursor >= end || text[cursor] != '=')
            {
                while (cursor < end && !char.IsWhiteSpace(text[cursor]) && text[cursor] != '/') cursor++;
                continue;
            }

            cursor++;
            while (cursor < end && char.IsWhiteSpace(text[cursor])) cursor++;
            if (cursor >= end || (text[cursor] != '"' && text[cursor] != '\'')) continue;
            var quote = text[cursor++];
            var valueStart = cursor;
            while (cursor < end && text[cursor] != quote) cursor++;
            if (cursor >= end) break;
            var rawValue = text.Substring(valueStart, cursor - valueStart);
            var leading = rawValue.Length - rawValue.TrimStart().Length;
            var trimmed = rawValue.Trim();
            result.Add(new XmlAttribute(
                LocalName(rawName),
                Decode(trimmed),
                new SourceRange(valueStart + leading, trimmed.Length)));
            cursor++;
        }

        return result;
    }

    private static bool IsSelfClosing(string text, int start, int end)
    {
        for (var index = end - 1; index >= start; index--)
        {
            if (char.IsWhiteSpace(text[index])) continue;
            return text[index] == '/';
        }
        return false;
    }

    private static string LocalName(string name)
    {
        var colon = name.LastIndexOf(':');
        return colon < 0 ? name : name.Substring(colon + 1);
    }

    private static bool StartsWith(string text, int start, string value) =>
        start + value.Length <= text.Length
        && string.CompareOrdinal(text, start, value, 0, value.Length) == 0;

    private static int SkipDelimited(string text, int start, string delimiter)
    {
        var end = text.IndexOf(delimiter, start, StringComparison.Ordinal);
        return end < 0 ? text.Length : end + delimiter.Length;
    }
}
