import { baseName, lockfileForIn, type Lockfile } from './lockfile';

/**
 * The installed versions of a Conan project, from `conan.lock` (`conan lock create`).
 *
 * Conan 2 lists references by kind: `"requires": ["zlib/1.3.1#<revision>%<time>"]`,
 * and the same for `build_requires` and `python_requires`. Conan 1 wrote a graph:
 * `"graph_lock": {"nodes": {"1": {"ref": "zlib/1.2.11#<revision>"}}}`. Both are read.
 * A package locked at two versions (a host and a build context can differ) gives no
 * version. Names are matched as Conan writes them, lowercased.
 */

export const CONAN_LOCKFILE_NAMES = ['conan.lock'] as const;

const REFERENCE_RE = /^([a-z0-9][a-z0-9_+.-]*)\/([^@#%\s]+)(@[^#%\s]*)?/i;
const KINDS = ['requires', 'build_requires', 'python_requires', 'config_requires'];

export function isConanLockfilePath(path: string): boolean {
  return (CONAN_LOCKFILE_NAMES as readonly string[]).includes(baseName(path));
}

/** The lock file at or above the conanfile's directory. */
export function conanLockfileFor(manifestPath: string, paths: ReadonlySet<string>): string | undefined {
  return lockfileForIn(CONAN_LOCKFILE_NAMES, manifestPath, paths);
}

function referencesOf(lock: Record<string, unknown>): string[] {
  const references: string[] = [];
  for (const kind of KINDS) {
    const list = lock[kind];
    if (Array.isArray(list)) references.push(...list.filter((item): item is string => typeof item === 'string'));
  }
  const graph = lock.graph_lock;
  const nodes = graph && typeof graph === 'object' ? (graph as Record<string, unknown>).nodes : undefined;
  if (nodes && typeof nodes === 'object') {
    for (const node of Object.values(nodes as Record<string, unknown>)) {
      const ref = node && typeof node === 'object' ? (node as Record<string, unknown>).ref : undefined;
      if (typeof ref === 'string') references.push(ref);
    }
  }
  return references;
}

/** Throws when the text is not a Conan lock file. */
export function parseConanLockfile(_lockfilePath: string, text: string): Lockfile {
  const lock = JSON.parse(text) as unknown;
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) throw new Error('Not a Conan lock file.');
  const record = lock as Record<string, unknown>;
  if (!('requires' in record) && !('graph_lock' in record)) throw new Error('Not a Conan lock file.');
  // A package at two versions maps to null.
  const versions = new Map<string, string | null>();
  for (const reference of referencesOf(record)) {
    const match = REFERENCE_RE.exec(reference.trim());
    // A package with a user and channel is not ConanCenter's, as in the manifest.
    if (!match || match[3]) continue;
    const name = match[1]!.toLowerCase();
    const version = match[2]!;
    const seen = versions.get(name);
    versions.set(name, seen === undefined || seen === version ? version : null);
  }
  return {
    resolve(_manifestPath, name) {
      return versions.get(name.toLowerCase()) ?? undefined;
    },
  };
}
