import { baseName, directoryOf, type Lockfile } from './lockfile';

/**
 * The installed version of a NuGet project's packages, read from the
 * `packages.lock.json` that `dotnet restore` writes beside the project when lock
 * files are turned on (`RestorePackagesWithLockFile`).
 *
 * The file lists each target framework's packages, every one with the version it
 * resolved. A project that targets several frameworks can resolve a package to a
 * different version for each: then there is no one installed version, and none is
 * given. A `Project` entry is another project in the solution, not a package.
 *
 * The lock file belongs to one project and sits in its directory, so it never
 * covers a project elsewhere. `Directory.Packages.props` only names versions for
 * the projects below it and has no lock file of its own.
 */

export const NUGET_LOCKFILE_NAMES = ['packages.lock.json'] as const;

type Raw = Record<string, unknown>;

function record(value: unknown): Raw {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Raw : {};
}

export function isNugetLockfilePath(path: string): boolean {
  return (NUGET_LOCKFILE_NAMES as readonly string[]).includes(baseName(path));
}

/** The lock file beside a project file; none for `Directory.Packages.props`. */
export function nugetLockfileFor(manifestPath: string, paths: ReadonlySet<string>): string | undefined {
  if (baseName(manifestPath) === 'Directory.Packages.props') return undefined;
  const directory = directoryOf(manifestPath);
  for (const name of NUGET_LOCKFILE_NAMES) {
    const candidate = directory ? `${directory}/${name}` : name;
    if (paths.has(candidate)) return candidate;
  }
  return undefined;
}

/** Throws when the text is not a NuGet lock file. */
export function parseNugetLockfile(_lockfilePath: string, text: string): Lockfile {
  let root: Raw;
  try {
    root = record(JSON.parse(text));
  } catch {
    throw new Error('Not a NuGet lock file.');
  }
  if (typeof root.version !== 'number' || !root.dependencies || typeof root.dependencies !== 'object') {
    throw new Error('Not a NuGet lock file.');
  }
  // Package IDs are case-insensitive. A name resolved to two versions maps to null.
  const versions = new Map<string, string | null>();
  for (const framework of Object.values(record(root.dependencies))) {
    for (const [name, value] of Object.entries(record(framework))) {
      const pkg = record(value);
      if (pkg.type === 'Project' || typeof pkg.resolved !== 'string' || !pkg.resolved.trim()) continue;
      const key = name.toLowerCase();
      const resolved = pkg.resolved.trim();
      const seen = versions.get(key);
      versions.set(key, seen === undefined || seen === resolved ? resolved : null);
    }
  }
  return {
    resolve(_manifestPath, name) {
      return versions.get(name.toLowerCase()) ?? undefined;
    },
  };
}
