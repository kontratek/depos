import { isLockfilePathIn, type Lockfile, lockfileForIn } from './lockfile';

/**
 * The installed version of a crate's direct dependencies, read from `Cargo.lock`.
 *
 * A workspace has one lockfile at its root, so the closest one at or above a
 * manifest covers it. Each `[[package]]` block is one resolved crate; only those
 * whose `source` is a registry count. A workspace member has no source, and a git
 * dependency's source is `git+…`: neither is a release published under that name.
 *
 * Cargo can hold two versions of one crate at once (two majors in the tree). Then
 * the one the manifest's requirement accepts is the direct dependency's; when the
 * requirement cannot tell them apart, no version is reported rather than a guess.
 */

export const CARGO_LOCKFILE_NAMES = ['Cargo.lock'] as const;

const LINE_RE = /^\s*(name|version|source)\s*=\s*"([^"\\]*)"\s*$/;
const REGISTRY_SOURCE_RE = /^(?:registry|sparse)\+/;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

interface Resolved {
  version: string;
  source?: string;
}

export function isCargoLockfilePath(path: string): boolean {
  return isLockfilePathIn(CARGO_LOCKFILE_NAMES, path);
}

/** The lockfile that covers a manifest: the closest one at or above its directory. */
export function cargoLockfileFor(manifestPath: string, paths: ReadonlySet<string>): string | undefined {
  return lockfileForIn(CARGO_LOCKFILE_NAMES, manifestPath, paths);
}

function numbers(version: string): [number, number, number] | undefined {
  const match = VERSION_RE.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/**
 * Whether `version` meets a requirement as far as telling two locked versions apart
 * needs: a caret (Cargo's default, `1.2` and `^1.2`), a tilde, an exact `=` or `*`.
 * Anything else (comparisons, several clauses) accepts every version, so two
 * candidates stay two and none is chosen.
 */
export function meetsCargoRequirement(version: string, requirement: string): boolean {
  const have = numbers(version);
  const text = requirement.trim();
  if (!have || text === '' || text === '*' || text.includes(',')) return true;
  const match = /^([\^~=])?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!match) return true;
  const op = match[1] ?? '^';
  const want = [Number(match[2]), match[3] === undefined ? undefined : Number(match[3]), match[4] === undefined ? undefined : Number(match[4])] as const;
  if (op === '=') return have[0] === want[0] && (want[1] === undefined || have[1] === want[1]) && (want[2] === undefined || have[2] === want[2]);
  if (op === '~') return have[0] === want[0] && (want[1] === undefined || have[1] === want[1]);
  // Caret: the leftmost non-zero part is fixed.
  if (want[0] !== 0) return have[0] === want[0];
  if (want[1] === undefined || want[1] !== 0) return have[0] === 0 && (want[1] === undefined || have[1] === want[1]);
  return have[0] === 0 && have[1] === 0 && (want[2] === undefined || have[2] === want[2]);
}

function scan(text: string): Map<string, Resolved[]> {
  const byName = new Map<string, Resolved[]>();
  let current: { name?: string } & Partial<Resolved> | undefined;
  const flush = (): void => {
    if (current?.name && current.version) {
      const list = byName.get(current.name) ?? [];
      list.push({ version: current.version, source: current.source });
      byName.set(current.name, list);
    }
    current = undefined;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      flush();
      if (line === '[[package]]') current = {};
      continue;
    }
    if (!current) continue;
    const match = LINE_RE.exec(raw);
    if (match) current[match[1] as 'name' | 'version' | 'source'] = match[2];
  }
  flush();
  return byName;
}

/** Throws when the text is not a Cargo lockfile. */
export function parseCargoLockfile(_lockfilePath: string, text: string): Lockfile {
  if (!/^\s*\[\[package\]\]\s*$/m.test(text) && !/^\s*version\s*=\s*\d+\s*$/m.test(text)) {
    throw new Error('Not a Cargo lockfile.');
  }
  const byName = scan(text);
  return {
    resolve(_manifestPath, name, versionSpec) {
      const released = (byName.get(name) ?? []).filter(entry => entry.source !== undefined && REGISTRY_SOURCE_RE.test(entry.source));
      // A git, path, renamed or other-registry dependency (cargo-manifest.ts) has no crates.io release under this name.
      if (versionSpec !== undefined && /^(?:git\+|file:|registry:|package:)/.test(versionSpec)) return undefined;
      const candidates = released.length > 1 && versionSpec !== undefined
        ? released.filter(entry => meetsCargoRequirement(entry.version, versionSpec))
        : released;
      const versions = [...new Set(candidates.map(entry => entry.version))];
      return versions.length === 1 ? versions[0] : undefined;
    },
  };
}
