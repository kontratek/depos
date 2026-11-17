import { parse as parseYaml } from 'yaml';
import { baseName, directoryOf, isLockfilePathIn, type Lockfile, lockfileForIn, relativeDirectory } from './lockfile';

/**
 * The installed version of a project's direct npm dependencies, read from its
 * lockfile. What every reader shares — the interface and the path helpers — is
 * in `lockfile.ts`.
 */

/** In the order they win when a directory holds more than one. */
export const NPM_LOCKFILE_NAMES = ['pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json', 'package-lock.json'] as const;

export type NpmLockfile = Lockfile;

const SEMVER = /^\d+\.\d+\.\d+[^\s@]*$/;
const ALIASED_SEMVER = /@(\d+\.\d+\.\d+[^\s@]*)$/;

/** A plain version, also from an alias (`npm:other@1.2.3`). `link:`, `file:` and git sources have none. */
function plainVersion(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (SEMVER.test(raw)) return raw;
  return ALIASED_SEMVER.exec(raw)?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNpmLockfilePath(path: string): boolean {
  return isLockfilePathIn(NPM_LOCKFILE_NAMES, path);
}

/** The lockfile that covers a manifest: the closest one at or above its directory. */
export function npmLockfileFor(manifestPath: string, paths: ReadonlySet<string>): string | undefined {
  return lockfileForIn(NPM_LOCKFILE_NAMES, manifestPath, paths);
}

function parsePackageLock(lockfilePath: string, text: string): NpmLockfile {
  const lock: unknown = JSON.parse(text);
  if (!isRecord(lock)) throw new Error('Not an npm lockfile.');
  const { packages, dependencies } = lock;

  // Lockfile v2 and v3: keyed by install path, so a name is looked up as Node finds it,
  // from the project's own node_modules up to the lockfile's.
  if (isRecord(packages)) {
    return {
      resolve(manifestPath, name) {
        let directory = relativeDirectory(lockfilePath, manifestPath);
        if (directory === undefined) return undefined;
        for (;;) {
          const entry = packages[directory ? `${directory}/node_modules/${name}` : `node_modules/${name}`];
          if (isRecord(entry)) return plainVersion(entry.version);
          if (directory === '') return undefined;
          directory = directoryOf(directory);
        }
      },
    };
  }

  // Lockfile v1: one project, keyed by name.
  if (isRecord(dependencies)) {
    return {
      resolve(manifestPath, name) {
        if (relativeDirectory(lockfilePath, manifestPath) !== '') return undefined;
        const entry = dependencies[name];
        return isRecord(entry) ? plainVersion(entry.version) : undefined;
      },
    };
  }
  throw new Error('Not an npm lockfile.');
}

const PNPM_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** YAML parsing holds the thread: about 0.6 seconds per MB, so a server does not parse more than this. */
const MAX_PNPM_HEAD_LENGTH = 4 * 1024 * 1024;

/** `1.2.3(react@18.0.0)` (lockfile 6 and later) or `1.2.3_react@18.0.0` (before): the peers are not the version. */
function pnpmVersion(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  return plainVersion(raw.replace(/[(_].*$/, ''));
}

function parsePnpmLock(lockfilePath: string, text: string): NpmLockfile {
  // The direct dependencies come before the `packages:` section, which is most of the file.
  const end = text.search(/^packages:/m);
  const head = end === -1 ? text : text.slice(0, end);
  if (head.length > MAX_PNPM_HEAD_LENGTH) throw new Error('The pnpm lockfile lists too many projects.');
  const lock: unknown = parseYaml(head);
  if (!isRecord(lock) || lock.lockfileVersion === undefined) throw new Error('Not a pnpm lockfile.');
  // A project without workspaces has no `importers`: the file itself is the one importer.
  const importers = isRecord(lock.importers) ? lock.importers : { '.': lock };

  return {
    resolve(manifestPath, name) {
      const directory = relativeDirectory(lockfilePath, manifestPath);
      if (directory === undefined) return undefined;
      const importer = importers[directory === '' ? '.' : directory];
      if (!isRecord(importer)) return undefined;
      for (const section of PNPM_SECTIONS) {
        const dependencies = importer[section];
        if (!isRecord(dependencies) || !Object.hasOwn(dependencies, name)) continue;
        const entry = dependencies[name];
        return pnpmVersion(isRecord(entry) ? entry.version : entry);
      }
      return undefined;
    },
  };
}

function unquote(value: string): string {
  return value.replace(/^"|"$/g, '');
}

/**
 * Yarn keys a package by every `name@range` that resolved to it, for all workspaces at
 * once, so the declared range is what finds it. Read by line: v1 is not YAML, and
 * Berry's entries share this shape (`name@npm:range`, `version: 1.2.3`).
 */
function parseYarnLock(text: string): NpmLockfile {
  if (!text.includes('# yarn lockfile v1') && !/^__metadata:/m.test(text)) throw new Error('Not a Yarn lockfile.');
  const versions = new Map<string, string>();
  let keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    if (!line.startsWith(' ')) {
      keys = line.endsWith(':') ? line.slice(0, -1).split(/,\s*/).map(unquote) : [];
      continue;
    }
    const match = /^ {2}version:? "?([^"\s]+)"?$/.exec(line);
    if (!match) continue;
    const version = plainVersion(match[1]);
    if (version) for (const key of keys) versions.set(key, version);
    keys = [];
  }
  return {
    resolve(_manifestPath, name, versionSpec) {
      if (!versionSpec) return undefined;
      return versions.get(`${name}@${versionSpec}`) ?? versions.get(`${name}@npm:${versionSpec}`);
    },
  };
}

/** Throws when the text is not a lockfile of the kind its name says. */
export function parseNpmLockfile(lockfilePath: string, text: string): NpmLockfile {
  const name = baseName(lockfilePath);
  if (name === 'pnpm-lock.yaml') return parsePnpmLock(lockfilePath, text);
  if (name === 'yarn.lock') return parseYarnLock(text);
  return parsePackageLock(lockfilePath, text);
}
