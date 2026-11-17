import { describe, expect, it } from 'vitest';
import { analyze } from '../../core/analyze';
import { composerLockfileFor, isComposerLockfilePath, parseComposerLockfile } from '../../core/composer-lockfile';
import { composerPinnedVersion, extractComposerDependencies } from '../../core/composer-manifest';
import { dependencyAtOffset, manifestAdapterForPath } from '../../core/manifest';
import { parseNotes } from '../../core/parseNotes';

describe('Composer manifest matching', () => {
  it('matches composer.json only', () => {
    expect(manifestAdapterForPath('/repo/composer.json')?.kind).toBe('composer');
    expect(manifestAdapterForPath('/repo/composer.lock')).toBeUndefined();
  });
});

describe('Composer dependencies', () => {
  const manifest = `{
  // JSONC is accepted for editor tolerance.
  "require": {
    "php": "^8.3",
    "ext-mbstring": "*",
    "lib-curl": ">=7.0",
    "composer-runtime-api": "^2.2",
    "Monolog/Monolog": "^3.0",
  },
  "require-dev": {
    "phpunit/phpunit": "^11.0"
  },
  "provide": { "psr/log-implementation": "3.0" },
  "replace": { "legacy/package": "self.version" },
  "conflict": { "bad/package": "<2" },
  "suggest": { "optional/package": "Optional integration" }
}`;

  it('extracts runtime, development and platform requirements', () => {
    expect(extractComposerDependencies(manifest).map((dependency) =>
      `${dependency.scope}:${dependency.noteKey}:${dependency.displayName}`)).toEqual([
      'require:php:php',
      'require:ext-mbstring:ext-mbstring',
      'require:lib-curl:lib-curl',
      'require:composer-runtime-api:composer-runtime-api',
      'require:monolog/monolog:Monolog/Monolog',
      'require-dev:phpunit/phpunit:phpunit/phpunit',
    ]);
  });

  it('ignores package links that do not install direct dependencies', () => {
    const names = extractComposerDependencies(manifest).map((dependency) => dependency.noteKey);
    expect(names).not.toContain('psr/log-implementation');
    expect(names).not.toContain('legacy/package');
    expect(names).not.toContain('bad/package');
    expect(names).not.toContain('optional/package');
  });

  it('supports every Composer platform package family from the plan', () => {
    const text = JSON.stringify({
      require: {
        php: '^8.3',
        'php-64bit': '*',
        'php-ipv6': '*',
        'php-zts': '*',
        'php-debug': '*',
        'php-future-capability': '*',
        hhvm: '*',
        'ext-json': '*',
        'lib-iconv': '*',
        composer: '^2.7',
        'composer-plugin-api': '^2.6',
        'composer-runtime-api': '^2.2',
      },
    });
    expect(extractComposerDependencies(text).map((dependency) => dependency.noteKey)).toEqual([
      'php',
      'php-64bit',
      'php-ipv6',
      'php-zts',
      'php-debug',
      'php-future-capability',
      'hhvm',
      'ext-json',
      'lib-iconv',
      'composer',
      'composer-plugin-api',
      'composer-runtime-api',
    ]);
  });

  it('returns exact clickable package and icon ranges', () => {
    const dependencies = extractComposerDependencies(manifest);
    for (const dependency of dependencies) {
      expect(manifest.slice(
        dependency.primaryRange.offset,
        dependency.primaryRange.offset + dependency.primaryRange.length,
      )).toBe(dependency.displayName);
      expect(manifest[dependency.iconRange.offset]).toBe('"');
      expect(dependencyAtOffset(dependencies, dependency.primaryRange.offset + 1))
        .toBe(dependency);
    }
  });

  it('keeps valid declarations from malformed JSON and ignores invalid entries', () => {
    const malformed = '{ "require": { "vendor/one": "^1", "bad name": "*", "vendor/two": "^2" ';
    expect(extractComposerDependencies(malformed).map((dependency) => dependency.noteKey))
      .toEqual(['vendor/one', 'vendor/two']);
    expect(extractComposerDependencies('{ "require": [], "require-dev": { "vendor/object": {} } }'))
      .toEqual([]);
  });

  it('matches Composer note headings case-insensitively', () => {
    const notes = parseNotes('---\nformat: dependency-notes/2\necosystem: composer\n---\n# Dependency Notes\n\n## MONOLOG/MONOLOG\n\nLogging.\n');
    const dependency = extractComposerDependencies('{"require":{"monolog/monolog":"^3"}}')[0]!;
    expect(analyze([dependency], notes).documented).toEqual([dependency]);
  });

  it('keeps each constraint as written', () => {
    expect(Object.fromEntries(extractComposerDependencies(manifest).map((dependency) => [dependency.noteKey, dependency.versionSpec]))).toEqual({
      'php': '^8.3',
      'ext-mbstring': '*',
      'lib-curl': '>=7.0',
      'composer-runtime-api': '^2.2',
      'monolog/monolog': '^3.0',
      'phpunit/phpunit': '^11.0',
    });
  });
});

describe('composerPinnedVersion', () => {
  it('names the release of an exact constraint, bare or with =', () => {
    expect(composerPinnedVersion('3.5.0')).toBe('3.5.0');
    expect(composerPinnedVersion('v6.4.0')).toBe('v6.4.0');
    expect(composerPinnedVersion('==1.2.3')).toBe('1.2.3');
    expect(composerPinnedVersion('1.0.0-beta2')).toBe('1.0.0-beta2');
    for (const spec of ['^3.0', '~2.1', '>=1.0 <2.0', '1.*', 'dev-main', '2.x-dev', '1.0.0@dev', '*', undefined]) {
      expect(composerPinnedVersion(spec), String(spec)).toBeUndefined();
    }
  });
});

describe('composer.lock', () => {
  const lock = JSON.stringify({
    'content-hash': 'abc',
    'packages': [
      { name: 'monolog/monolog', version: '3.5.0', dist: { type: 'zip' } },
      { name: 'symfony/console', version: 'v6.4.0', dist: { type: 'zip' } },
      { name: 'acme/branch', version: 'dev-main', source: { type: 'git' } },
      { name: 'acme/local', version: '1.0.0', dist: { type: 'path', url: '../local' } },
    ],
    'packages-dev': [{ name: 'phpunit/phpunit', version: '11.0.1', dist: { type: 'zip' } }],
  });
  const parsed = parseComposerLockfile('composer.lock', lock);

  it('gives each installed release its version, as Packagist writes it', () => {
    expect(parsed.resolve('composer.json', 'monolog/monolog', '^3.0')).toBe('3.5.0');
    expect(parsed.resolve('composer.json', 'symfony/console', '^6.4')).toBe('v6.4.0');
    expect(parsed.resolve('composer.json', 'phpunit/phpunit', '^11.0')).toBe('11.0.1');
  });

  it('gives none for a branch, a path package, a platform requirement or what it does not hold', () => {
    expect(parsed.resolve('composer.json', 'acme/branch', 'dev-main')).toBeUndefined();
    expect(parsed.resolve('composer.json', 'acme/local', '*')).toBeUndefined();
    expect(parsed.resolve('composer.json', 'php', '^8.3')).toBeUndefined();
    expect(parsed.resolve('composer.json', 'missing/package', '^1.0')).toBeUndefined();
  });

  it('finds the lockfile beside composer.json, and refuses what is not one', () => {
    expect(isComposerLockfilePath('app/composer.lock')).toBe(true);
    expect(composerLockfileFor('app/composer.json', new Set(['app/composer.lock']))).toBe('app/composer.lock');
    expect(() => parseComposerLockfile('composer.lock', '{"lockfileVersion": 3}')).toThrow();
    expect(() => parseComposerLockfile('composer.lock', 'not json')).toThrow();
  });
});
