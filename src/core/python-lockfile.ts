import { isLockfilePathIn, type Lockfile, lockfileForIn } from './lockfile';
import { normalizePythonPackageName } from './python-manifest';
import { commentStart, lineRecords, nestingDelta, unquotedEquals } from './toml-scan';

/**
 * The installed version of a project's direct Python dependencies, read from
 * `uv.lock` or `poetry.lock`.
 *
 * Both resolve a project once and list the result as `[[package]]` blocks, so a
 * name has one version for the whole file and `resolve` needs no directory
 * lookup — as with `yarn.lock`, which also keys by name alone. Which lockfile
 * covers which manifest is `pythonLockfileFor`'s answer.
 *
 * Only the `name` and `version` of each block are read, and only at the block's
 * own level: `dependencies = [{ name = "idna" }]` lists the package's
 * dependencies, not another package. A multi-line basic string (`"""…"""`) is
 * not understood, which neither tool writes for these two keys.
 */

/** In the order they win when a directory holds more than one. */
export const PYTHON_LOCKFILE_NAMES = ['uv.lock', 'poetry.lock'] as const;

/**
 * A source that is a local path or a checkout, not a package index: its version
 * is the project's own, not one published under that name. uv writes the kind
 * inline (`source = { editable = "." }`), Poetry in a `[package.source]` table
 * (`type = "git"`). Poetry's `legacy` is an alternate index, so it stays.
 */
const LOCAL_SOURCES: ReadonlySet<string> = new Set(['editable', 'virtual', 'directory', 'path', 'file', 'git', 'url']);

/**
 * A released version as PEP 440 normalizes it, which is what both tools write.
 * Anything else is left unread rather than reported as installed.
 */
const PEP_440 = /^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)?$/;

interface PackageRecord {
  name?: string;
  version?: string;
  /** The first key of the source, lowercased; undefined when the block names none. */
  source?: string;
}

interface ScannedLockfile {
  records: PackageRecord[];
  /** `version = 1` before the first table: uv writes it, Poetry does not. */
  hasFormatVersion: boolean;
  hasPackageBlock: boolean;
  hasMetadataTable: boolean;
}

/** A quoted TOML string's content, or undefined for any other value. */
function stringValue(raw: string): string | undefined {
  const text = raw.trim();
  const quote = text[0];
  if ((quote !== '"' && quote !== "'") || text.length < 2 || text.at(-1) !== quote) return undefined;
  const content = text.slice(1, -1);
  return content.includes(quote) ? undefined : content;
}

/** The first key of an inline table (`{ registry = "…" }` → `registry`). */
function firstInlineKey(raw: string): string | undefined {
  return /^\{\s*([A-Za-z0-9_-]+)\s*=/.exec(raw.trim())?.[1]?.toLowerCase();
}

/** A table header's name, and whether it is an array of tables (`[[package]]`). */
function tableHeader(trimmed: string): { name: string; isArray: boolean } | undefined {
  const array = /^\[\[([^[\]]+)\]\]$/.exec(trimmed);
  if (array?.[1]) return { name: array[1].trim(), isArray: true };
  const table = /^\[([^[\]]+)\]$/.exec(trimmed);
  return table?.[1] ? { name: table[1].trim(), isArray: false } : undefined;
}

function scan(text: string): ScannedLockfile {
  const out: ScannedLockfile = { records: [], hasFormatVersion: false, hasPackageBlock: false, hasMetadataTable: false };
  let current: PackageRecord | undefined;
  /** The part after `package.` while inside one of the block's own tables. */
  let subTable: string | undefined;
  let seenTable = false;
  let depth = 0;

  for (const line of lineRecords(text)) {
    const content = line.text.slice(0, commentStart(line.text));
    const trimmed = content.trim();
    if (!trimmed) continue;

    if (depth === 0 && trimmed.startsWith('[')) {
      const header = tableHeader(trimmed);
      seenTable = true;
      if (header?.isArray && header.name === 'package') {
        current = {};
        out.records.push(current);
        out.hasPackageBlock = true;
        subTable = undefined;
      } else if (header && !header.isArray && current && header.name.startsWith('package.')) {
        subTable = header.name.slice('package.'.length);
      } else {
        if (header?.name === 'metadata') out.hasMetadataTable = true;
        current = undefined;
        subTable = undefined;
      }
      continue;
    }

    if (depth === 0) {
      const equals = unquotedEquals(content);
      if (equals >= 0) {
        const key = (stringValue(content.slice(0, equals)) ?? content.slice(0, equals).trim()).toLowerCase();
        const value = content.slice(equals + 1);
        if (!seenTable && key === 'version') out.hasFormatVersion = true;
        if (current && subTable === undefined) {
          if (key === 'name') current.name = stringValue(value);
          else if (key === 'version') current.version = stringValue(value);
          else if (key === 'source') current.source = firstInlineKey(value);
        } else if (current && subTable === 'source' && key === 'type') {
          current.source = stringValue(value)?.toLowerCase();
        }
      }
    }

    depth = Math.max(0, depth + nestingDelta(content));
  }
  return out;
}

export function isPythonLockfilePath(path: string): boolean {
  return isLockfilePathIn(PYTHON_LOCKFILE_NAMES, path);
}

/** The lockfile that covers a manifest: the closest one at or above its directory. */
export function pythonLockfileFor(manifestPath: string, paths: ReadonlySet<string>): string | undefined {
  return lockfileForIn(PYTHON_LOCKFILE_NAMES, manifestPath, paths);
}

/** Throws when the text is not a lockfile of the kind its name says. */
export function parsePythonLockfile(lockfilePath: string, text: string): Lockfile {
  const isUv = lockfilePath.endsWith('uv.lock');
  const scanned = scan(text);
  if (isUv && !scanned.hasFormatVersion) throw new Error('Not a uv lockfile.');
  if (!isUv && !scanned.hasPackageBlock && !scanned.hasMetadataTable) throw new Error('Not a Poetry lockfile.');

  // `null` is a name the file gives more than one version for: uv lists a package
  // once per resolution fork. Which one is installed depends on the environment,
  // so none is reported.
  const versions = new Map<string, string | null>();
  for (const record of scanned.records) {
    if (!record.name || !record.version || !PEP_440.test(record.version)) continue;
    if (record.source !== undefined && LOCAL_SOURCES.has(record.source)) continue;
    const key = normalizePythonPackageName(record.name);
    if (!versions.has(key)) versions.set(key, record.version);
    else if (versions.get(key) !== record.version) versions.set(key, null);
  }

  return {
    resolve(_manifestPath, name) {
      return versions.get(normalizePythonPackageName(name)) ?? undefined;
    },
  };
}
