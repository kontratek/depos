import { baseName, directoryOf, type Lockfile } from './lockfile';

/**
 * The installed version of a Gradle project's modules, read from the
 * `gradle.lockfile` that dependency locking writes beside the build file
 * (`gradle dependencies --write-locks`).
 *
 * Each line is one module and the configurations that resolve it to that version:
 * `com.google.guava:guava:33.4.0-jre=compileClasspath,runtimeClasspath`. Two
 * configurations can resolve a module to different versions (tests often pull a
 * newer one); then there is no one installed version, and none is given. `empty=`
 * lists configurations with nothing locked.
 *
 * Every project of a multi-project build has its own lock file in its own
 * directory, so it never covers a build file elsewhere. The buildscript's lock file
 * (`buildscript-gradle.lockfile`) locks plugins, which are not read as dependencies.
 * Gradle before 6.8 wrote one file per configuration under
 * `gradle/dependency-locks/`; those are not read.
 */

export const GRADLE_LOCKFILE_NAMES = ['gradle.lockfile'] as const;

const LINE_RE = /^([^:=\s]+:[^:=\s]+):([^:=\s]+)=/;

export function isGradleLockfilePath(path: string): boolean {
  return (GRADLE_LOCKFILE_NAMES as readonly string[]).includes(baseName(path));
}

/** The lock file beside a build file. */
export function gradleLockfileFor(manifestPath: string, paths: ReadonlySet<string>): string | undefined {
  const directory = directoryOf(manifestPath);
  for (const name of GRADLE_LOCKFILE_NAMES) {
    const candidate = directory ? `${directory}/${name}` : name;
    if (paths.has(candidate)) return candidate;
  }
  return undefined;
}

/** Throws when the text is not a Gradle lock file. */
export function parseGradleLockfile(_lockfilePath: string, text: string): Lockfile {
  // A module resolved to two versions maps to null.
  const versions = new Map<string, string | null>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('empty=')) continue;
    const match = LINE_RE.exec(line);
    if (!match) throw new Error('Not a Gradle lock file.');
    const [, module = '', version = ''] = match;
    const seen = versions.get(module);
    versions.set(module, seen === undefined || seen === version ? version : null);
  }
  return {
    resolve(_manifestPath, name) {
      return versions.get(name) ?? undefined;
    },
  };
}
