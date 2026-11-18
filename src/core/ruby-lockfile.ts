import { isLockfilePathIn, type Lockfile, lockfileForIn } from './lockfile';

/**
 * The installed version of a Bundler project's direct gems, read from `Gemfile.lock`
 * (or `gems.locked`, beside `gems.rb`).
 *
 * The lockfile has one section per source. Only a `GEM` section whose remote is
 * rubygems.org counts: `GIT` and `PATH` sections are checkouts, and a `GEM` section
 * with another remote is a private server. Under `specs:`, each gem is a line indented
 * four spaces, `name (version)` or `name (version-platform)`: RubyGems writes a
 * prerelease with dots (`1.0.0.rc1`), so a dash starts the platform, which is dropped.
 */

export const RUBY_LOCKFILE_NAMES = ['Gemfile.lock', 'gems.locked'] as const;

const SECTION_RE = /^([A-Z][A-Z ]*)$/;
const REMOTE_RE = /^ {2}remote: (.+)$/;
const SPEC_RE = /^ {4}([A-Za-z0-9._-]+) \(([^)]+)\)$/;
const RUBYGEMS_REMOTE = /^https?:\/\/rubygems\.org\/?$/i;

export function isRubyLockfilePath(path: string): boolean {
  return isLockfilePathIn(RUBY_LOCKFILE_NAMES, path);
}

/** The lockfile that covers a manifest: the closest one at or above its directory. */
export function rubyLockfileFor(manifestPath: string, paths: ReadonlySet<string>): string | undefined {
  return lockfileForIn(RUBY_LOCKFILE_NAMES, manifestPath, paths);
}

/** Throws when the text is not a Bundler lockfile. */
export function parseRubyLockfile(_lockfilePath: string, text: string): Lockfile {
  if (!/^(?:GEM|GIT|PATH|DEPENDENCIES)\s*$/m.test(text)) throw new Error('Not a Bundler lockfile.');
  const versions = new Map<string, string>();
  let section = '';
  let remote = '';
  for (const raw of text.split(/\r?\n/)) {
    const header = SECTION_RE.exec(raw);
    if (header) {
      section = header[1]!.trim();
      remote = '';
      continue;
    }
    const source = REMOTE_RE.exec(raw);
    if (source) {
      remote = source[1]!.trim();
      continue;
    }
    if (section !== 'GEM' || !RUBYGEMS_REMOTE.test(remote)) continue;
    const spec = SPEC_RE.exec(raw);
    if (!spec) continue;
    const [, name, versionAndPlatform] = spec;
    versions.set(name!, versionAndPlatform!.split('-')[0]!);
  }
  return {
    resolve(_manifestPath, name, versionSpec) {
      // A git, path or private-server gem (ruby-manifest.ts) has no rubygems.org release under this name.
      if (versionSpec !== undefined && /^(?:git\+|file:|registry:)/.test(versionSpec)) return undefined;
      return versions.get(name);
    },
  };
}
