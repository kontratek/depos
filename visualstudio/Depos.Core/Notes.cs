using System.Text;
using System.Text.RegularExpressions;

namespace Depos.Core;

public static class Notes
{
    public const string FormatVersion = "dependency-notes/2";
    public const string Ecosystem = "nuget";
    public const string FileName = "DEPENDENCY-NOTES.md";
    public const string Title = "# Dependency Notes";
    public const string AgentHeading = "### Agent notes";
    public const string GeneratedHeading = "### Generated";

    private static readonly Regex HeadingPattern = new("^##(?!#)\\s+(.+?)\\s*$", RegexOptions.Compiled);
    private static readonly Regex SubheadingPattern = new("^###(?!#)\\s+(.+?)\\s*$", RegexOptions.Compiled);
    private static readonly Regex FencePattern = new("^\\s{0,3}(`{3,}|~{3,})", RegexOptions.Compiled);
    private static readonly Regex FrontmatterPattern = new("^([A-Za-z][\\w-]*):\\s*(.*?)\\s*$", RegexOptions.Compiled);
    private static readonly Regex AgentFieldPattern = new(
        "^\\s*[-*]\\s+([a-z][a-z0-9_-]*)\\s*:\\s*(.*)$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// The agent layer's fields, core first, in the order docs/format.md and
    /// assets/AGENT-RULES.md list them; NotesTests checks the rules file against it.
    /// </summary>
    public static IReadOnlyList<string> AgentFieldKeys { get; } = new[]
    {
        "purpose", "usage", "constraint", "verify", "log", "verified",
        "risk", "runtime", "exposure", "bump-with", "remove-when", "alternatives", "owner", "status", "links", "note",
    };

    private static readonly HashSet<string> AgentFields = new(AgentFieldKeys, StringComparer.OrdinalIgnoreCase);
    private static readonly string[] RuntimeValues = { "server", "client", "build", "dev", "deploy" };
    private static readonly string[] ExposureValues = { "untrusted-input", "internal" };
    private static readonly Regex StatusPattern = new(
        "^(dead|removal-planned|removed\\s+\\d{4}-\\d{2}(\\b.*)?)$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex VersionPattern = new("^v?\\d+(\\.\\d+)*", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    private static readonly Regex TitlePattern = new("^#(?!#)\\s+", RegexOptions.Compiled);

    /// <summary>
    /// The header comment belongs to the format: new files get it and Normalize
    /// rewrites it, in the words src/core/template.ts uses for every v2 file.
    /// </summary>
    private static readonly string[] HeaderCommentLines =
    {
        $"<!-- Each \"## name\" below is a package from the {Ecosystem} dependency manifest.",
        $"  The text under it is written by people. \"{AgentHeading}\" and everything below",
        "  it is written by AI agents — rules in .pacmon/AGENT-RULES.md. -->",
    };

    private static readonly (string Key, string Value)[] FrontmatterDefaults =
    {
        ("format", FormatVersion),
        ("ecosystem", Ecosystem),
        ("lang", "en"),
    };

    public static string NormalizeName(string value) => StripQuotes(value).Trim().ToLowerInvariant();

    public static NotesFileModel Parse(string input)
    {
        var hadBom = input.Length > 0 && input[0] == '\ufeff';
        var text = hadBom ? input.Substring(1) : input;
        var eol = text.Contains("\r\n") ? "\r\n" : "\n";
        var lines = Regex.Split(text, "\\r?\\n");
        var model = new NotesFileModel { Eol = eol, HadBom = hadBom, Lines = lines };
        var cursor = 0;

        if (lines.Length > 0 && lines[0] == "---")
        {
            for (var end = 1; end < lines.Length; end++)
            {
                if (lines[end] != "---") continue;
                string? format = null;
                string? language = null;
                string? ecosystem = null;
                for (var line = 1; line < end; line++)
                {
                    var match = FrontmatterPattern.Match(lines[line]);
                    if (!match.Success || match.Groups[2].Value.Length == 0) continue;
                    switch (match.Groups[1].Value)
                    {
                        case "format": format = match.Groups[2].Value; break;
                        case "lang": language = match.Groups[2].Value; break;
                        case "ecosystem": ecosystem = match.Groups[2].Value; break;
                    }
                }
                model.Frontmatter = new Frontmatter(0, end, format, language, ecosystem);
                cursor = end + 1;
                break;
            }
        }

        var inFence = false;
        for (var line = cursor; line < lines.Length; line++)
        {
            if (FencePattern.IsMatch(lines[line]))
            {
                inFence = !inFence;
                continue;
            }
            if (!inFence && lines[line].StartsWith("# ", StringComparison.Ordinal))
            {
                model.TitleLine = line;
                break;
            }
        }

        var headings = new List<(int Line, string Name)>();
        inFence = false;
        for (var line = cursor; line < lines.Length; line++)
        {
            if (FencePattern.IsMatch(lines[line]))
            {
                inFence = !inFence;
                continue;
            }
            if (inFence) continue;
            var match = HeadingPattern.Match(lines[line]);
            if (match.Success) headings.Add((line, match.Groups[1].Value.Trim()));
        }

        var firstByName = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < headings.Count; index++)
        {
            var heading = headings[index];
            var bodyEnd = index + 1 < headings.Count ? headings[index + 1].Line : lines.Length;
            int? agentHeading = null;
            int? generatedHeading = null;
            inFence = false;
            for (var line = heading.Line + 1; line < bodyEnd; line++)
            {
                if (FencePattern.IsMatch(lines[line]))
                {
                    inFence = !inFence;
                    continue;
                }
                if (inFence) continue;
                var subheading = SubheadingPattern.Match(lines[line]);
                if (!subheading.Success) continue;
                var key = subheading.Groups[1].Value.Trim();
                if (agentHeading is null && key.Equals("Agent notes", StringComparison.OrdinalIgnoreCase)) agentHeading = line;
                if (generatedHeading is null && key.Equals("Generated", StringComparison.OrdinalIgnoreCase)) generatedHeading = line;
            }

            model.Sections.Add(new NoteSection(
                heading.Name,
                heading.Line,
                heading.Line + 1,
                bodyEnd,
                agentHeading,
                generatedHeading));

            var normalized = NormalizeName(heading.Name);
            if (firstByName.TryGetValue(normalized, out var firstLine))
                model.Problems.Add(new NotesProblem("duplicateSection", heading.Name, heading.Line, firstLine));
            else
                firstByName[normalized] = heading.Line;
        }

        return model;
    }

    public static NoteSection? FindSection(NotesFileModel model, string name)
    {
        var normalized = NormalizeName(name);
        return model.Sections.FirstOrDefault(section => NormalizeName(section.Name) == normalized);
    }

    public static SectionLayers Layers(NotesFileModel model, NoteSection section)
    {
        var humanEnd = section.AgentHeadingLine ?? section.GeneratedHeadingLine ?? section.BodyEnd;
        var human = Slice(model, section.BodyStart, humanEnd);
        var agent = section.AgentHeadingLine.HasValue
            ? Slice(model, section.AgentHeadingLine.Value + 1, section.GeneratedHeadingLine ?? section.BodyEnd)
            : string.Empty;
        var generated = section.GeneratedHeadingLine.HasValue
            ? Slice(model, section.GeneratedHeadingLine.Value, section.BodyEnd)
            : string.Empty;
        return new SectionLayers(human, agent, generated);
    }

    public static string Preview(SectionLayers layers, InlineSource source = InlineSource.HumanFirst, int maxLength = 90)
    {
        var human = layers.Human.Split('\n').Select(line => line.Trim()).FirstOrDefault(line => line.Length > 0) ?? string.Empty;
        human = Regex.Replace(human, "^[-*]\\s+", string.Empty);
        var purpose = ParseAgentFields(layers.Agent)
            .FirstOrDefault(field => field.Key.Equals("purpose", StringComparison.OrdinalIgnoreCase)).Value ?? string.Empty;
        var text = source switch
        {
            InlineSource.HumanFirst => human.Length > 0 ? human : purpose,
            InlineSource.AiFirst => purpose.Length > 0 ? purpose : human,
            InlineSource.HumanOnly => human,
            InlineSource.AiOnly => purpose,
            _ => human,
        };
        if (text.Length == 0) return "note";
        return text.Length > maxLength ? text.Substring(0, maxLength - 1) + "…" : text;
    }

    public static IReadOnlyList<LintFinding> LintAgentText(string agent)
    {
        const string packageName = "depos-preview";
        var model = Parse(NewFile(packageName, string.Empty, agent));
        return Lint(model, new[] { packageName }).Where(IsAgentFinding).ToArray();
    }

    public static bool IsAgentFinding(LintFinding finding) =>
        finding.Kind == "unknownAgentKey"
        || finding.Kind == "emptyAgentValue"
        || finding.Kind == "badAgentValue"
        || finding.Kind == "removedButPresent";

    /// <summary>
    /// Preserves unknown agent fields by moving their complete contents under
    /// the supported <c>note:</c> key. Empty values remain visible for manual
    /// correction instead of being deleted silently.
    /// </summary>
    public static string FixAgentText(string agent)
    {
        var lines = Regex.Split(agent, "\\r?\\n");
        for (var index = 0; index < lines.Length; index++)
        {
            var match = AgentFieldPattern.Match(lines[index]);
            if (!match.Success
                || AgentFields.Contains(match.Groups[1].Value)
                || match.Groups[2].Value.StartsWith("//", StringComparison.Ordinal)) continue;
            var indent = Regex.Match(lines[index], "^\\s*").Value;
            lines[index] = $"{indent}- note: {match.Groups[1].Value}: {match.Groups[2].Value}".TrimEnd();
        }
        return string.Join("\n", lines);
    }

    public static string NewFile(string? packageName = null, string? human = null, string? agent = null)
    {
        var builder = new StringBuilder();
        builder.AppendLine("---");
        foreach (var (key, value) in FrontmatterDefaults) builder.AppendLine($"{key}: {value}");
        builder.AppendLine("---");
        builder.AppendLine();
        foreach (var line in HeaderCommentLines) builder.AppendLine(line);
        builder.AppendLine();
        builder.AppendLine(Title);
        if (!string.IsNullOrWhiteSpace(packageName))
        {
            builder.AppendLine();
            AppendSection(builder, packageName!, human ?? string.Empty, agent ?? string.Empty, string.Empty);
        }
        return builder.ToString();
    }

    public static string UpsertLayers(string input, string packageName, string human, string agent)
    {
        var model = Parse(input);
        var section = FindSection(model, packageName);
        var eol = model.Eol;
        var replacement = BuildSection(
            section?.Name ?? packageName,
            human.Trim(),
            agent.Trim(),
            section is null ? string.Empty : Layers(model, section).Generated,
            eol);

        if (section is null)
        {
            var baseText = input.TrimEnd('\r', '\n');
            if (baseText.Length == 0) baseText = NewFile().TrimEnd('\r', '\n');
            return baseText + eol + eol + replacement + eol;
        }

        var lines = model.Lines.ToList();
        lines.RemoveRange(section.HeadingLine, section.BodyEnd - section.HeadingLine);
        lines.InsertRange(section.HeadingLine, Regex.Split(replacement, "\\r?\\n"));
        var output = string.Join(eol, lines).TrimEnd('\r', '\n') + eol;
        return model.HadBom ? "\ufeff" + output : output;
    }

    /// <summary>
    /// The canonical form of docs/format.md, as the VS Code and JetBrains
    /// formatters write it: the frontmatter as written, with the format's own
    /// keys appended when missing; the format's header comment and title; the
    /// introduction; then every section in name order, duplicates included and in
    /// their original order, each body kept as written. Nothing else changes.
    /// </summary>
    public static string Normalize(string input)
    {
        var model = Parse(input);
        var lines = model.Lines;
        var output = new List<string> { "---" };
        var cursor = 0;
        if (model.Frontmatter is { } frontmatter)
        {
            var inner = lines.Skip(frontmatter.StartLine + 1).Take(frontmatter.EndLine - frontmatter.StartLine - 1).ToList();
            var present = new HashSet<string>(
                inner.Select(line => FrontmatterPattern.Match(line)).Where(match => match.Success).Select(match => match.Groups[1].Value),
                StringComparer.Ordinal);
            output.AddRange(inner);
            output.AddRange(FrontmatterDefaults.Where(field => !present.Contains(field.Key)).Select(field => $"{field.Key}: {field.Value}"));
            cursor = frontmatter.EndLine + 1;
        }
        else output.AddRange(FrontmatterDefaults.Select(field => $"{field.Key}: {field.Value}"));
        output.Add("---");

        // The header comment and the title belong to the format, so the ones the
        // file has are replaced; the comment is the first thing after the
        // frontmatter, when it is a complete HTML comment.
        cursor = SkipBlankLines(lines, cursor);
        if (cursor < lines.Count && lines[cursor].TrimStart().StartsWith("<!--", StringComparison.Ordinal))
        {
            var end = cursor;
            while (end < lines.Count && !lines[end].Contains("-->")) end++;
            if (end < lines.Count) cursor = end + 1;
        }
        cursor = SkipBlankLines(lines, cursor);
        if (cursor < lines.Count && TitlePattern.IsMatch(lines[cursor])) cursor++;

        output.Add(string.Empty);
        output.AddRange(HeaderCommentLines);
        output.Add(string.Empty);
        output.Add(Title);
        var firstHeading = model.Sections.Select(section => section.HeadingLine).Where(line => line >= cursor).DefaultIfEmpty(lines.Count).Min();
        var introduction = TrimmedLines(lines, cursor, firstHeading);
        if (introduction.Count > 0)
        {
            output.Add(string.Empty);
            output.AddRange(introduction);
        }

        // OrderBy is stable, so duplicate sections keep their order.
        foreach (var section in model.Sections.OrderBy(section => NormalizeName(section.Name), StringComparer.Ordinal))
        {
            output.Add(string.Empty);
            output.Add("## " + section.Name);
            var body = TrimmedLines(lines, section.BodyStart, section.BodyEnd);
            if (body.Count == 0) continue;
            output.Add(string.Empty);
            output.AddRange(body);
        }

        var normalized = string.Join(model.Eol, output) + model.Eol;
        return model.HadBom ? "\ufeff" + normalized : normalized;
    }

    private static int SkipBlankLines(IReadOnlyList<string> lines, int line)
    {
        while (line < lines.Count && string.IsNullOrWhiteSpace(lines[line])) line++;
        return line;
    }

    private static List<string> TrimmedLines(IReadOnlyList<string> lines, int start, int end)
    {
        while (start < end && string.IsNullOrWhiteSpace(lines[start])) start++;
        while (end > start && string.IsNullOrWhiteSpace(lines[end - 1])) end--;
        return lines.Skip(start).Take(end - start).ToList();
    }

    public static NotesAnalysis Analyze(IEnumerable<DependencyEntry> dependencies, NotesFileModel? notes)
    {
        var deps = dependencies.ToArray();
        var sections = new Dictionary<string, NoteSection>(StringComparer.OrdinalIgnoreCase);
        var depNames = new HashSet<string>(deps.Select(dependency => dependency.NoteKey), StringComparer.OrdinalIgnoreCase);
        var orphans = new List<NoteSection>();
        var removed = new List<NoteSection>();
        foreach (var section in notes?.Sections ?? Enumerable.Empty<NoteSection>())
        {
            if (!sections.ContainsKey(section.Name)) sections[section.Name] = section;
            if (!depNames.Contains(section.Name))
            {
                if (notes is not null && IsRemoved(Layers(notes, section).Agent)) removed.Add(section);
                else orphans.Add(section);
            }
        }

        var documented = new List<DependencyEntry>();
        var undocumented = new List<DependencyEntry>();
        var byDependency = new Dictionary<string, NoteSection>(StringComparer.OrdinalIgnoreCase);
        foreach (var dependency in deps)
        {
            if (sections.TryGetValue(dependency.NoteKey, out var section)
                && notes is not null
                && !IsEmpty(Layers(notes, section)))
            {
                documented.Add(dependency);
                byDependency[dependency.NoteKey] = section;
            }
            else undocumented.Add(dependency);
        }
        return new NotesAnalysis(documented, undocumented, orphans, removed, byDependency);
    }

    public static IReadOnlyList<LintFinding> Lint(NotesFileModel model, IEnumerable<string> dependencyNames)
    {
        var findings = new List<LintFinding>();
        var deps = new HashSet<string>(dependencyNames, StringComparer.OrdinalIgnoreCase);
        if (model.Frontmatter is null) findings.Add(new LintFinding("missingFrontmatter", 0, "Add dependency-notes/2 frontmatter."));
        else
        {
            if (model.Frontmatter.FormatVersion != FormatVersion)
                findings.Add(new LintFinding("unknownFormat", model.Frontmatter.StartLine, $"Expected format: {FormatVersion}."));
            if (!string.Equals(model.Frontmatter.Ecosystem, Ecosystem, StringComparison.Ordinal))
                findings.Add(new LintFinding("wrongEcosystem", model.Frontmatter.StartLine, $"Expected ecosystem: {Ecosystem}."));
        }
        if (model.TitleLine is null) findings.Add(new LintFinding("missingTitle", 0, $"Add {Title}."));
        else if (model.Lines[model.TitleLine.Value] != Title)
            findings.Add(new LintFinding("wrongTitle", model.TitleLine.Value, $"Use {Title}."));
        foreach (var problem in model.Problems)
            findings.Add(new LintFinding(problem.Kind, problem.Line, $"Duplicate section for {problem.Name}."));

        foreach (var section in model.Sections)
        {
            if (!section.AgentHeadingLine.HasValue) continue;
            for (var line = section.AgentHeadingLine.Value + 1;
                 line < (section.GeneratedHeadingLine ?? section.BodyEnd);
                 line++)
            {
                var match = AgentFieldPattern.Match(model.Lines[line]);
                if (!match.Success || match.Groups[2].Value.StartsWith("//", StringComparison.Ordinal)) continue;
                var key = match.Groups[1].Value;
                var value = match.Groups[2].Value.Trim();
                var keyStart = model.Lines[line].IndexOf(key, StringComparison.Ordinal);
                if (!AgentFields.Contains(key))
                    findings.Add(new LintFinding("unknownAgentKey", line, $"Unknown agent field: {key}.", keyStart, keyStart + key.Length));
                else if (value.Length == 0 || Regex.IsMatch(value, "^[-—–]*$"))
                    findings.Add(new LintFinding("emptyAgentValue", line, $"Agent field {key} has no value.", keyStart, keyStart + key.Length));
                else if (key.Equals("status", StringComparison.OrdinalIgnoreCase)
                         && value.StartsWith("removed", StringComparison.OrdinalIgnoreCase)
                         && deps.Contains(section.Name))
                    findings.Add(new LintFinding("removedButPresent", line, $"{section.Name} is still declared.", keyStart, keyStart + key.Length));
                else if (ValueProblem(key, value) is { } expected)
                {
                    var valueStart = model.Lines[line].Length - match.Groups[2].Value.Length;
                    findings.Add(new LintFinding("badAgentValue", line, $"\"{key}:\" expects {expected}.", valueStart, valueStart + value.Length));
                }
            }
        }
        return findings;
    }

    /// <summary>What the value of an enumerated field must look like, or null when it is fine.</summary>
    private static string? ValueProblem(string key, string value)
    {
        string? OneOf(string[] allowed) =>
            Regex.Split(value.ToLowerInvariant(), "\\s*[,|/]\\s*").All(item => allowed.Contains(item))
                ? null
                : "one of " + string.Join(" | ", allowed);
        switch (key.ToLowerInvariant())
        {
            case "runtime": return OneOf(RuntimeValues);
            case "exposure": return OneOf(ExposureValues);
            case "status": return StatusPattern.IsMatch(value) ? null : "dead | removal-planned | removed YYYY-MM — reason";
            case "verified": return VersionPattern.IsMatch(value) ? null : "a version, e.g. 4.18.2";
            default: return null;
        }
    }

    private static List<(string Key, string Value)> ParseAgentFields(string agent)
    {
        var result = new List<(string Key, string Value)>();
        foreach (var line in Regex.Split(agent, "\\r?\\n"))
        {
            var match = AgentFieldPattern.Match(line);
            if (match.Success) result.Add((match.Groups[1].Value.ToLowerInvariant(), match.Groups[2].Value.Trim()));
        }
        return result;
    }

    private static bool IsEmpty(SectionLayers layers) =>
        layers.Human.Length == 0 && layers.Agent.Length == 0 && layers.Generated.Length == 0;

    private static bool IsRemoved(string agent) => ParseAgentFields(agent)
        .Any(field => field.Key == "status" && field.Value.StartsWith("removed", StringComparison.OrdinalIgnoreCase));

    private static string Slice(NotesFileModel model, int start, int end)
    {
        while (start < end && string.IsNullOrWhiteSpace(model.Lines[start])) start++;
        while (end > start && string.IsNullOrWhiteSpace(model.Lines[end - 1])) end--;
        return string.Join("\n", model.Lines.Skip(start).Take(end - start));
    }

    private static string StripQuotes(string value)
    {
        var trimmed = value.Trim();
        if (trimmed.Length >= 2
            && ((trimmed[0] == '`' && trimmed[trimmed.Length - 1] == '`')
                || (trimmed[0] == '"' && trimmed[trimmed.Length - 1] == '"')
                || (trimmed[0] == '\'' && trimmed[trimmed.Length - 1] == '\'')))
            return trimmed.Substring(1, trimmed.Length - 2).Trim();
        return trimmed;
    }

    private static string BuildSection(string name, string human, string agent, string generated, string eol)
    {
        var builder = new StringBuilder();
        builder.Append("## ").Append(name.Trim());
        if (human.Length > 0) builder.Append(eol).Append(eol).Append(human.Replace("\r\n", "\n").Replace("\n", eol));
        if (agent.Length > 0) builder.Append(eol).Append(eol).Append(AgentHeading).Append(eol).Append(eol)
            .Append(agent.Replace("\r\n", "\n").Replace("\n", eol));
        if (generated.Length > 0) builder.Append(eol).Append(eol)
            .Append(generated.Replace("\r\n", "\n").Replace("\n", eol));
        return builder.ToString();
    }

    private static void AppendSection(StringBuilder builder, string name, string human, string agent, string generated) =>
        builder.AppendLine(BuildSection(name, human.Trim(), agent.Trim(), generated.Trim(), "\n"));
}
