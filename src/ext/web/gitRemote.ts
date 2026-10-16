/**
 * The GitHub repository of a workspace, from the text of its `.git/config`. The web
 * app matches it to a repository of an organization. GitHub only, like the web app.
 */

/** URL of `[remote "origin"]`, else of the first remote, else undefined. */
export function remoteUrlFromGitConfig(configText: string): string | undefined {
  const remotes: Array<{ name: string; url?: string }> = [];
  let current: { name: string; url?: string } | undefined;
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      const match = /^\[remote\s+"([^"]+)"\]$/.exec(line);
      current = match ? { name: match[1]! } : undefined;
      if (current) remotes.push(current);
      continue;
    }
    if (!current || current.url) continue;
    const kv = /^url\s*=\s*(.+)$/.exec(line);
    if (kv) current.url = kv[1]!.trim();
  }
  return (remotes.find((r) => r.name === 'origin') ?? remotes[0])?.url;
}

/**
 * `owner/name` of a github.com remote URL (https or ssh), else undefined. An ssh host
 * alias that starts with `github` (`github-work`, `github.com-work`: one per GitHub
 * account in ~/.ssh/config) counts as github.com too. A wrong guess costs nothing: the
 * web app matches only repositories of the user's organizations, anything else is a 404.
 */
export function githubFullName(remoteUrl: string): string | undefined {
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^(?:ssh:\/\/)?git@github[\w.-]*[:/](?:\d+\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(remoteUrl.trim());
    if (match) return `${match[1]}/${match[2]}`;
  }
  return undefined;
}
