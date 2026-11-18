import { isLockfilePathIn, type Lockfile, lockfileForIn } from './lockfile';

/**
 * The installed version of a Mix project's direct dependencies, read from `mix.lock`.
 *
 * Each top-level entry is `"app": {:hex, :package, "1.7.10", "checksum", [:mix],
 * [deps], "hexpm", "checksum"}` on one line, as Mix writes it. Only entries from
 * hex.pm's public repository count: a git or path entry (`{:git, …}`, `{:path, …}`)
 * is not a release, and one from a private repository (`"hexpm:org"`) is not
 * published under that name on hex.pm. An umbrella's apps share the root's lockfile,
 * so the closest one at or above a manifest covers it.
 */

export const MIX_LOCKFILE_NAMES = ['mix.lock'] as const;

/** `"app": {:hex, :package, "version"` — the package atom quoted or bare. */
const HEX_ENTRY_RE = /^\s*"([^"]+)":\s*\{:hex,\s*:(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)),\s*"([^"]+)"/;

export function isMixLockfilePath(path: string): boolean {
  return isLockfilePathIn(MIX_LOCKFILE_NAMES, path);
}

/** The lockfile that covers a manifest: the closest one at or above its directory. */
export function mixLockfileFor(manifestPath: string, paths: ReadonlySet<string>): string | undefined {
  return lockfileForIn(MIX_LOCKFILE_NAMES, manifestPath, paths);
}

/** Throws when the text is not a Mix lockfile. */
export function parseMixLockfile(_lockfilePath: string, text: string): Lockfile {
  if (!/^\s*%\{/.test(text)) throw new Error('Not a Mix lockfile.');
  const versions = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = HEX_ENTRY_RE.exec(line);
    if (!match) continue;
    const [, app, quotedPackage, barePackage, version] = match;
    // Another repository's package, and a package installed under another app name, are not this name on hex.pm.
    if (/"hexpm:/.test(line) || (quotedPackage ?? barePackage) !== app) continue;
    versions.set(app!, version!);
  }
  return {
    resolve(_manifestPath, name, versionSpec) {
      // A git, path, umbrella, renamed or private dependency (mixManifest.ts) has no hex.pm release under this name.
      if (versionSpec !== undefined && /^(?:git\+|file:|workspace:|registry:|package:)/.test(versionSpec)) return undefined;
      return versions.get(name);
    },
  };
}
