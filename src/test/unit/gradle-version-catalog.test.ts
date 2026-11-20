import { describe, expect, it } from 'vitest';
import { extractGradleDependencies, extractGradleDependenciesWithBundles } from '../../core/gradleManifest';
import {
  gradleCatalogAccessor,
  gradleCatalogFor,
  isGradleCatalogPath,
  parseGradleVersionCatalog,
  resolveGradleCatalogAliases,
} from '../../core/gradle-version-catalog';

const catalog = [
  '# The project\'s catalog',
  '[versions]',
  'jackson = "2.17.0"   # pinned for the CVE fix',
  "kotlin = { strictly = '2.0.21' }",
  'slf4j = { require = "2.0.13" }',
  'range = { strictly = "[1.0,2.0)", prefer = "1.5" }',
  '',
  '[libraries]',
  'jackson-databind = { module = "com.fasterxml.jackson.core:jackson-databind", version.ref = "jackson" }',
  'guava = "com.google.guava:guava:33.4.0-jre"',
  'groovy_core = { group = "org.apache.groovy", name = "groovy", version = "4.0.24" }',
  '"kotlin.stdlib" = { module = "org.jetbrains.kotlin:kotlin-stdlib", version = { ref = "kotlin" } }',
  'slf4j-api = { module = "org.slf4j:slf4j-api", version.ref = "slf4j" }',
  'ranged = { module = "com.contoso:ranged", version.ref = "range" }',
  'junit-bom = { module = "org.junit:junit-bom", version = "5.11.3" }',
  'junit-jupiter = { module = "org.junit.jupiter:junit-jupiter" }',
  'missing-ref = { module = "com.contoso:missing", version.ref = "nope" }',
  'not-a-module = { module = "no-colon" }',
  '',
  '[libraries.okhttp]',
  'module = "com.squareup.okhttp3:okhttp"',
  'version = "4.12.0"',
  '',
  '[bundles]',
  'jackson = [',
  '  "jackson-databind",',
  '  "guava",',
  ']',
  '',
  '[plugins]',
  'kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }',
  '',
].join('\r\n');

describe('Gradle version catalogs', () => {
  it('owns gradle/libs.versions.toml, and finds the closest one at or above a build file', () => {
    expect(isGradleCatalogPath('gradle/libs.versions.toml')).toBe(true);
    expect(isGradleCatalogPath('android/gradle/libs.versions.toml')).toBe(true);
    expect(isGradleCatalogPath('gradle/test-libs.versions.toml')).toBe(false);
    const paths = new Set(['gradle/libs.versions.toml', 'tools/gradle/libs.versions.toml']);
    expect(gradleCatalogFor('app/build.gradle.kts', paths)).toBe('gradle/libs.versions.toml');
    expect(gradleCatalogFor('build.gradle', paths)).toBe('gradle/libs.versions.toml');
    expect(gradleCatalogFor('tools/cli/build.gradle', paths)).toBe('tools/gradle/libs.versions.toml');
    expect(gradleCatalogFor('build.gradle', new Set())).toBeUndefined();
  });

  it('names the accessor Gradle generates: dashes, underscores and dots are separators', () => {
    expect(gradleCatalogAccessor('groovy-core')).toBe('libs.groovy.core');
    expect(gradleCatalogAccessor('groovy_core')).toBe('libs.groovy.core');
    expect(gradleCatalogAccessor('androidx.coreKtx')).toBe('libs.androidx.coreKtx');
  });

  it('reads each library\'s module and version, in every form', () => {
    const parsed = parseGradleVersionCatalog(catalog);
    expect(parsed.library('libs.jackson.databind')).toEqual({ module: 'com.fasterxml.jackson.core:jackson-databind', versionSpec: '2.17.0' });
    expect(parsed.library('libs.guava')).toEqual({ module: 'com.google.guava:guava', versionSpec: '33.4.0-jre' });
    expect(parsed.library('libs.groovy.core')).toEqual({ module: 'org.apache.groovy:groovy', versionSpec: '4.0.24' });
    expect(parsed.library('libs.okhttp')).toEqual({ module: 'com.squareup.okhttp3:okhttp', versionSpec: '4.12.0' });
    expect(parsed.library('libs.junit.bom')).toEqual({ module: 'org.junit:junit-bom', versionSpec: '5.11.3' });
  });

  it('gives a rich version in Gradle\'s short notation', () => {
    const parsed = parseGradleVersionCatalog(catalog);
    expect(parsed.library('libs.kotlin.stdlib')?.versionSpec).toBe('2.0.21!!');
    expect(parsed.library('libs.slf4j.api')?.versionSpec).toBe('2.0.13');
    expect(parsed.library('libs.ranged')?.versionSpec).toBe('[1.0,2.0)!!1.5');
  });

  it('gives no version for a platform-managed library or a missing reference, and skips what is not a module', () => {
    const parsed = parseGradleVersionCatalog(catalog);
    expect(parsed.library('libs.junit.jupiter')).toEqual({ module: 'org.junit.jupiter:junit-jupiter' });
    expect(parsed.library('libs.missing.ref')).toEqual({ module: 'com.contoso:missing' });
    expect(parsed.library('libs.not.a.module')).toBeUndefined();
    // Bundles and plugins are not libraries.
    expect(parsed.library('libs.jackson')).toBeUndefined();
    expect(parsed.library('libs.kotlin.jvm')).toBeUndefined();
  });

  it('never throws on text that is not a catalog', () => {
    for (const text of ['', '{"a": 1}', '[libraries]\nbroken = [', '[libraries]\n__proto__ = "a:b:1"\nx = { module = 5 }']) {
      expect(() => parseGradleVersionCatalog(text), text).not.toThrow();
    }
    const odd = parseGradleVersionCatalog('[libraries]\n__proto__ = "a:b:1"\ntoString = "c:d:2"');
    expect(odd.library('libs.toString')).toEqual({ module: 'c:d', versionSpec: '2' });
    expect(odd.library('libs.constructor')).toBeUndefined();
    expect(({} as Record<string, unknown>).a).toBeUndefined();
  });

  it('turns a build file\'s aliases into modules, keeping the alias\'s place and what the catalog does not name', () => {
    const script = [
      'dependencies {',
      '  implementation(libs.jackson.databind)',
      '  implementation(platform(libs.junit.bom))',
      '  testImplementation(libs.junit.jupiter)',
      '  implementation(libs.unknown.thing)',
      '  implementation("org.slf4j:slf4j-api:2.0.17")',
      '}',
    ].join('\n');
    const entries = extractGradleDependencies(script);
    const resolved = resolveGradleCatalogAliases(entries, parseGradleVersionCatalog(catalog));
    expect(resolved.map((dep) => [dep.noteKey, dep.displayName, dep.versionSpec, dep.scope])).toEqual([
      ['com.fasterxml.jackson.core:jackson-databind', 'com.fasterxml.jackson.core:jackson-databind', '2.17.0', 'implementation'],
      ['org.junit:junit-bom', 'org.junit:junit-bom', '5.11.3', 'implementation'],
      ['org.junit.jupiter:junit-jupiter', 'org.junit.jupiter:junit-jupiter', undefined, 'testImplementation'],
      ['libs.unknown.thing', 'libs.unknown.thing', undefined, 'implementation'],
      ['org.slf4j:slf4j-api', 'org.slf4j:slf4j-api', '2.0.17', 'implementation'],
    ]);
    expect(resolved[0]!.name).toBe('com.fasterxml.jackson.core:jackson-databind');
    expect(resolved[0]!.primaryRange).toEqual(entries[0]!.primaryRange);
    expect(script.slice(resolved[0]!.primaryRange.offset, resolved[0]!.primaryRange.offset + resolved[0]!.primaryRange.length)).toBe('libs.jackson.databind');
  });

  it('reads a bundle as the libraries it lists, once each, and leaves out what is no library', () => {
    const withBundles = `${catalog}\n[bundles]\nweb = ["guava", 'groovy-core', "missing-alias", "guava"]\nhttp-stack = [ "okhttp" ]\n`;
    const parsed = parseGradleVersionCatalog(withBundles);
    expect(parsed.bundle('libs.bundles.web')?.map((library) => library.module)).toEqual(['com.google.guava:guava', 'org.apache.groovy:groovy']);
    expect(parsed.bundle('libs.bundles.http.stack')).toEqual([{ module: 'com.squareup.okhttp3:okhttp', versionSpec: '4.12.0' }]);
    // The bundle across lines in the catalog above.
    expect(parsed.bundle('libs.bundles.jackson')?.map((library) => library.module)).toEqual(['com.fasterxml.jackson.core:jackson-databind', 'com.google.guava:guava']);
    expect(parsed.bundle('libs.bundles.none')).toBeUndefined();
  });

  it('turns a bundle in a build file into its libraries, and drops a bundle the catalog does not name', () => {
    const script = 'dependencies {\n  implementation(libs.bundles.jackson)\n  testImplementation(libs.bundles.unknown)\n  implementation(libs.guava)\n}\n';
    // Read alone, a build file names no bundle: it is no package.
    expect(extractGradleDependencies(script).map((dep) => dep.noteKey)).toEqual(['libs.guava']);
    const entries = extractGradleDependenciesWithBundles(script);
    expect(entries.map((dep) => dep.noteKey)).toEqual(['libs.bundles.jackson', 'libs.bundles.unknown', 'libs.guava']);
    const resolved = resolveGradleCatalogAliases(entries, parseGradleVersionCatalog(catalog));
    expect(resolved.map((dep) => [dep.noteKey, dep.versionSpec, dep.scope])).toEqual([
      ['com.fasterxml.jackson.core:jackson-databind', '2.17.0', 'implementation'],
      ['com.google.guava:guava', '33.4.0-jre', 'implementation'],
      ['com.google.guava:guava', '33.4.0-jre', 'implementation'],
    ]);
    expect(script.slice(resolved[0]!.primaryRange.offset, resolved[0]!.primaryRange.offset + resolved[0]!.primaryRange.length)).toBe('libs.bundles.jackson');
  });
});
