import { isLockfilePathIn, type Lockfile, lockfileForIn } from './lockfile';

/**
 * The installed version of a Gleam project's direct dependencies, read from the
 * `manifest.toml` Gleam writes beside `gleam.toml`. Its `packages` array holds one
 * inline table a line: `{ name = "gleam_stdlib", version = "0.44.0", …, source = "hex", … }`.
 * Only `source = "hex"` entries count: a git or local entry is not a release
 * published under that name on hex.pm.
 */

export const GLEAM_LOCKFILE_NAMES = ['manifest.toml'] as const;

export function isGleamLockfilePath(path: string): boolean {
  return isLockfilePathIn(GLEAM_LOCKFILE_NAMES, path);
}

/** The lockfile that covers a manifest: the closest one at or above its directory. */
export function gleamLockfileFor(manifestPath: string, paths: ReadonlySet<string>): string | undefined {
  return lockfileForIn(GLEAM_LOCKFILE_NAMES, manifestPath, paths);
}

function field(line: string, key: string): string | undefined {
  return new RegExp(`(?:^|[{,\\s])${key}\\s*=\\s*"([^"\\\\]*)"`).exec(line)?.[1];
}

/** Throws when the text is not a Gleam manifest. */
export function parseGleamLockfile(_lockfilePath: string, text: string): Lockfile {
  if (!/^\s*packages\s*=\s*\[/m.test(text)) throw new Error('Not a Gleam manifest.');
  const versions = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('{')) continue;
    const name = field(line, 'name');
    const version = field(line, 'version');
    if (name && version && field(line, 'source') === 'hex') versions.set(name, version);
  }
  return {
    resolve(_manifestPath, name, versionSpec) {
      // A git, path or renamed dependency (gleam-manifest.ts) has no hex.pm release under this name.
      if (versionSpec !== undefined && /^(?:git\+|file:|package:)/.test(versionSpec)) return undefined;
      return versions.get(name);
    },
  };
}
