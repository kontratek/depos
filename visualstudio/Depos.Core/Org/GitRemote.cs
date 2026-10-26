using System.IO;
using System.Text.RegularExpressions;

namespace Depos.Core.Org;

/// <summary>
/// The GitHub repository of a folder, from its <c>.git/config</c>. A port of
/// <c>src/ext/web/gitRemote.ts</c> and the JetBrains <c>GitRemote.kt</c>. Depos
/// matches it to a repository of an organization. GitHub only, like Depos.
/// </summary>
public static class GitRemote
{
    private static readonly Regex RemoteHeader = new("^\\[remote\\s+\"([^\"]+)\"\\]$");
    private static readonly Regex UrlLine = new("^url\\s*=\\s*(.+)$");
    private static readonly Regex GitdirLine = new("^gitdir:\\s*(.+)$", RegexOptions.Multiline);
    private static readonly Regex AbsolutePath = new("^([a-zA-Z]:)?[\\\\/]");
    private static readonly Regex[] GithubPatterns =
    {
        new("^https?://(?:[^@/]+@)?github\\.com/([^/]+)/([^/]+?)(?:\\.git)?/?$", RegexOptions.IgnoreCase),
        new("^(?:ssh://)?git@github[\\w.-]*[:/](?:\\d+/)?([^/]+)/([^/]+?)(?:\\.git)?/?$", RegexOptions.IgnoreCase),
    };

    /// <summary>URL of <c>[remote "origin"]</c>, else of the first remote, else null.</summary>
    public static string? RemoteUrlFromGitConfig(string configText)
    {
        var remotes = new List<(string Name, string? Url)>();
        var current = -1;
        foreach (var rawLine in Regex.Split(configText, "\\r?\\n"))
        {
            var line = rawLine.Trim();
            if (line.StartsWith("[", StringComparison.Ordinal))
            {
                var header = RemoteHeader.Match(line);
                current = -1;
                if (header.Success)
                {
                    remotes.Add((header.Groups[1].Value, null));
                    current = remotes.Count - 1;
                }
                continue;
            }
            if (current < 0 || remotes[current].Url is not null) continue;
            var url = UrlLine.Match(line);
            if (url.Success) remotes[current] = (remotes[current].Name, url.Groups[1].Value.Trim());
        }
        var origin = remotes.FindIndex(remote => remote.Name == "origin");
        return origin >= 0 ? remotes[origin].Url : remotes.Count > 0 ? remotes[0].Url : null;
    }

    /// <summary>
    /// <c>owner/name</c> of a github.com remote URL (https or ssh), else null. An
    /// ssh host alias that starts with <c>github</c> counts too: a wrong guess
    /// costs nothing, Depos answers 404 for anything that is not one of the
    /// user's repositories.
    /// </summary>
    public static string? GithubFullName(string remoteUrl)
    {
        var value = remoteUrl.Trim();
        foreach (var pattern in GithubPatterns)
        {
            var match = pattern.Match(value);
            if (match.Success) return $"{match.Groups[1].Value}/{match.Groups[2].Value}";
        }
        return null;
    }

    /// <summary><c>owner/name</c> of the folder's GitHub remote. Follows a <c>.git</c> file (worktree, submodule).</summary>
    public static string? RepositoryOf(string root)
    {
        var config = ReadGitConfig(root);
        var url = config is null ? null : RemoteUrlFromGitConfig(config);
        return url is null ? null : GithubFullName(url);
    }

    /// <summary>The folder that holds <c>.git</c>, from <paramref name="path"/> upwards; null outside a repository.</summary>
    public static string? WorkTreeOf(string path)
    {
        try
        {
            var directory = new DirectoryInfo(Path.GetFullPath(path));
            for (var current = directory; current is not null; current = current.Parent)
            {
                var dotGit = Path.Combine(current.FullName, ".git");
                if (Directory.Exists(dotGit) || File.Exists(dotGit)) return current.FullName;
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            // A path that cannot be walked is not in a repository.
        }
        return null;
    }

    private static string? ReadGitConfig(string root)
    {
        try
        {
            var dotGit = Path.Combine(root, ".git");
            var gitDir = dotGit;
            if (File.Exists(dotGit))
            {
                // "gitdir: <path>": a worktree or a submodule. Its config is in the common dir.
                var pointer = GitdirLine.Match(File.ReadAllText(dotGit));
                var target = pointer.Success ? pointer.Groups[1].Value.Trim() : string.Empty;
                if (target.Length == 0) return null;
                gitDir = AbsolutePath.IsMatch(target) ? target : Path.Combine(root, target);
                var commonDir = Path.Combine(gitDir, "commondir");
                if (File.Exists(commonDir))
                {
                    var common = File.ReadAllText(commonDir).Trim();
                    if (common.Length > 0) gitDir = Path.Combine(gitDir, common);
                }
            }
            var config = Path.Combine(gitDir, "config");
            return File.Exists(config) ? File.ReadAllText(config) : null;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return null;
        }
    }
}
