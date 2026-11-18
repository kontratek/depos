import { isLockfilePathIn, type Lockfile, lockfileForIn } from './lockfile';

/**
 * The installed version of a Composer project's direct requirements, read from
 * `composer.lock`: its `packages` and `packages-dev` lists name each installed
 * package once, with its version as Packagist writes it (`3.5.0`, `v6.4.0`).
 *
 * A package installed from a path repository (`dist.type` `path`) is the project's
 * own, and a branch (`dev-main`, `2.x-dev`) is no release: neither gives a version.
 */

export const COMPOSER_LOCKFILE_NAMES = ['composer.lock'] as const;

/** A branch Composer installs at a commit, not a tagged release. */
const BRANCH_VERSION_RE = /^dev-|-dev$/i;

type Raw = Record<string, unknown>;

export function isComposerLockfilePath(path: string): boolean {
  return isLockfilePathIn(COMPOSER_LOCKFILE_NAMES, path);
}

/** The lockfile that covers a manifest: the closest one at or above its directory. */
export function composerLockfileFor(manifestPath: string, paths: ReadonlySet<string>): string | undefined {
  return lockfileForIn(COMPOSER_LOCKFILE_NAMES, manifestPath, paths);
}

function record(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {};
}

/** Throws when the text is not a Composer lockfile. */
export function parseComposerLockfile(_lockfilePath: string, text: string): Lockfile {
  let root: Raw;
  try {
    root = record(JSON.parse(text));
  } catch {
    throw new Error('Not a Composer lockfile.');
  }
  if (!Array.isArray(root.packages)) throw new Error('Not a Composer lockfile.');
  const versions = new Map<string, string>();
  for (const list of [root.packages, root['packages-dev']]) {
    for (const item of Array.isArray(list) ? list : []) {
      const pkg = record(item);
      if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue;
      if (BRANCH_VERSION_RE.test(pkg.version) || record(pkg.dist).type === 'path') continue;
      versions.set(pkg.name.toLowerCase(), pkg.version);
    }
  }
  return {
    resolve(_manifestPath, name) {
      return versions.get(name.toLowerCase());
    },
  };
}
