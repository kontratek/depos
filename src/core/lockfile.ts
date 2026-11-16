/**
 * What every lockfile reader has in common. A lockfile adds a version to a
 * dependency a manifest declares; it never adds a dependency, so lockfiles are
 * not part of the notes format. Transitive packages are not read.
 *
 * One reader per ecosystem (`npm-lockfile.ts`, `python-lockfile.ts`); finding
 * the file that covers a manifest is the same work for all of them.
 */

export interface Lockfile {
  /** The installed version, or undefined when the lockfile does not give one for this dependency. */
  resolve(manifestPath: string, name: string, versionSpec: string | undefined): string | undefined;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** The manifest's directory, relative to the lockfile's; undefined when the lockfile is not an ancestor. */
export function relativeDirectory(lockfilePath: string, manifestPath: string): string | undefined {
  const lockfileDir = directoryOf(lockfilePath);
  const manifestDir = directoryOf(manifestPath);
  if (lockfileDir === '') return manifestDir;
  if (manifestDir === lockfileDir) return '';
  return manifestDir.startsWith(`${lockfileDir}/`) ? manifestDir.slice(lockfileDir.length + 1) : undefined;
}

export function isLockfilePathIn(names: readonly string[], path: string): boolean {
  return names.includes(baseName(path));
}

/** The lockfile that covers a manifest: the closest one at or above its directory, in `names` order. */
export function lockfileForIn(
  names: readonly string[],
  manifestPath: string,
  paths: ReadonlySet<string>,
): string | undefined {
  let directory = directoryOf(manifestPath);
  for (;;) {
    for (const name of names) {
      const candidate = directory ? `${directory}/${name}` : name;
      if (paths.has(candidate)) return candidate;
    }
    if (directory === '') return undefined;
    directory = directoryOf(directory);
  }
}
