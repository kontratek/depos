import { describe, expect, it } from 'vitest';
import { extractMavenDependencies, readMavenBuild } from '../../core/mavenManifest';

const pom = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<project>\n<modelVersion>4.0.0</modelVersion>\n${body}\n</project>\n`;
const dep = (group: string, artifact: string, extra = '') => `<dependency><groupId>${group}</groupId><artifactId>${artifact}</artifactId>${extra}</dependency>`;
const versionsOf = (entries: ReturnType<typeof extractMavenDependencies>) => entries.map((entry) => [entry.noteKey, entry.scope, entry.versionSpec]);

const ROOT = pom(`
<groupId>com.acme</groupId><artifactId>acme-parent</artifactId><version>1.4.0-SNAPSHOT</version><packaging>pom</packaging>
<properties><jackson.version>2.17.0</jackson.version><slf4j.version>2.0.13</slf4j.version></properties>
<dependencyManagement><dependencies>
  ${dep('com.fasterxml.jackson.core', 'jackson-databind', '<version>${jackson.version}</version>')}
  ${dep('org.slf4j', 'slf4j-api', '<version>${slf4j.version}</version>')}
  ${dep('${project.groupId}', 'acme-core', '<version>${project.version}</version>')}
  ${dep('com.acme', 'acme-bom', '<version>${project.version}</version><type>pom</type><scope>import</scope>')}
</dependencies></dependencyManagement>`);

const BOM = pom(`
<parent><groupId>com.acme</groupId><artifactId>acme-parent</artifactId><version>1.4.0-SNAPSHOT</version></parent>
<artifactId>acme-bom</artifactId><packaging>pom</packaging>
<properties><guava.version>33.4.0-jre</guava.version><jackson.version>2.15.0</jackson.version></properties>
<dependencyManagement><dependencies>
  ${dep('com.google.guava', 'guava', '<version>${guava.version}</version>')}
  ${dep('com.fasterxml.jackson.core', 'jackson-databind', '<version>${jackson.version}</version>')}
</dependencies></dependencyManagement>`);

const APP = pom(`
<parent><groupId>com.acme</groupId><artifactId>acme-parent</artifactId><version>1.4.0-SNAPSHOT</version></parent>
<artifactId>acme-app</artifactId>
<properties><slf4j.version>2.0.17</slf4j.version></properties>
<dependencies>
  ${dep('com.fasterxml.jackson.core', 'jackson-databind')}
  ${dep('org.slf4j', 'slf4j-api')}
  ${dep('com.google.guava', 'guava')}
  ${dep('com.acme', 'acme-core')}
  ${dep('junit', 'junit', '<scope>test</scope>')}
</dependencies>`);

describe('readMavenBuild', () => {
  const build = readMavenBuild([
    { path: 'pom.xml', text: ROOT },
    { path: 'bom/pom.xml', text: BOM },
    { path: 'app/pom.xml', text: APP },
  ]);

  it('gives a module the versions its parent manages, filled in with the module\'s own properties', () => {
    expect(versionsOf(build.dependencies('app/pom.xml', { parent: true }))).toEqual([
      ['com.fasterxml.jackson.core:jackson-databind', 'compile', '2.17.0'],
      // The module sets slf4j.version, and the parent's management uses it.
      ['org.slf4j:slf4j-api', 'compile', '2.0.17'],
      // From the BOM the parent imports, filled in with the BOM's own properties.
      ['com.google.guava:guava', 'compile', '33.4.0-jre'],
      // A sibling module is not a release.
      ['com.acme:acme-core', 'compile', '${project.version}'],
      ['junit:junit', 'test', undefined],
    ]);
  });

  it('lets an entry the pom or its parents manage win over an imported BOM\'s', () => {
    const jackson = build.dependencies('app/pom.xml').find((entry) => entry.noteKey === 'com.fasterxml.jackson.core:jackson-databind');
    expect(jackson?.versionSpec).toBe('2.17.0');
  });

  it('lists a parent the repository does not hold as a dependency, only when asked', () => {
    const boot = pom(`
<parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.3.5</version><relativePath/></parent>
<artifactId>service</artifactId>
<dependencies>${dep('org.springframework.boot', 'spring-boot-starter-web')}</dependencies>`);
    const service = readMavenBuild([{ path: 'service/pom.xml', text: boot }]);
    const entries = service.dependencies('service/pom.xml', { parent: true });
    expect(versionsOf(entries)).toEqual([
      ['org.springframework.boot:spring-boot-starter-parent', 'parent', '3.3.5'],
      ['org.springframework.boot:spring-boot-starter-web', 'compile', undefined],
    ]);
    expect(boot.slice(entries[0]!.primaryRange.offset, entries[0]!.primaryRange.offset + entries[0]!.primaryRange.length)).toBe('spring-boot-starter-parent');
    expect(versionsOf(service.dependencies('service/pom.xml'))).toEqual([['org.springframework.boot:spring-boot-starter-web', 'compile', undefined]]);
    // A parent in the repository is a module of the build, not a dependency.
    expect(build.dependencies('app/pom.xml', { parent: true }).some((entry) => entry.scope === 'parent')).toBe(false);
  });

  it('finds the parent at <relativePath>, else the one module that is the parent', () => {
    const parent = pom(`<groupId>com.acme</groupId><artifactId>build-parent</artifactId><version>1</version>
<dependencyManagement><dependencies>${dep('org.slf4j', 'slf4j-api', '<version>2.0.16</version>')}</dependencies></dependencyManagement>`);
    const child = (relative: string) => pom(`<parent><groupId>com.acme</groupId><artifactId>build-parent</artifactId><version>1</version>${relative}</parent>
<artifactId>lib</artifactId><dependencies>${dep('org.slf4j', 'slf4j-api')}</dependencies>`);
    const versionAt = (relative: string, parentPath: string) => readMavenBuild([
      { path: parentPath, text: parent },
      { path: 'modules/lib/pom.xml', text: child(relative) },
    ]).dependencies('modules/lib/pom.xml')[0]?.versionSpec;
    expect(versionAt('<relativePath>../../build</relativePath>', 'build/pom.xml')).toBe('2.0.16');
    expect(versionAt('<relativePath>../../build/pom.xml</relativePath>', 'build/pom.xml')).toBe('2.0.16');
    // Not at ../pom.xml: found by its coordinate.
    expect(versionAt('', 'build/pom.xml')).toBe('2.0.16');
    expect(versionAt('<relativePath/>', 'build/pom.xml')).toBe('2.0.16');
    // Out of the repository.
    expect(versionAt('<relativePath>../../../../x</relativePath>', 'other/pom.xml')).toBe('2.0.16');
  });

  it('does not take a pom at <relativePath> that is another module', () => {
    const other = pom(`<groupId>com.acme</groupId><artifactId>other</artifactId><version>1</version>
<dependencyManagement><dependencies>${dep('org.slf4j', 'slf4j-api', '<version>1.7.36</version>')}</dependencies></dependencyManagement>`);
    const child = pom(`<parent><groupId>com.acme</groupId><artifactId>missing-parent</artifactId><version>1</version></parent>
<artifactId>lib</artifactId><dependencies>${dep('org.slf4j', 'slf4j-api')}</dependencies>`);
    const entries = readMavenBuild([{ path: 'pom.xml', text: other }, { path: 'lib/pom.xml', text: child }]).dependencies('lib/pom.xml', { parent: true });
    expect(versionsOf(entries)).toEqual([
      ['com.acme:missing-parent', 'parent', '1'],
      ['org.slf4j:slf4j-api', 'compile', undefined],
    ]);
  });

  it('ends a parent loop and an import loop', () => {
    const a = pom(`<parent><groupId>g</groupId><artifactId>b</artifactId><version>1</version><relativePath>../b</relativePath></parent><artifactId>a</artifactId>
<dependencyManagement><dependencies>${dep('g', 'b', '<version>1</version><type>pom</type><scope>import</scope>')}</dependencies></dependencyManagement>
<dependencies>${dep('x', 'y')}</dependencies>`);
    const b = pom(`<parent><groupId>g</groupId><artifactId>a</artifactId><version>1</version><relativePath>../a</relativePath></parent><artifactId>b</artifactId>
<dependencyManagement><dependencies>${dep('g', 'a', '<version>1</version><type>pom</type><scope>import</scope>')}${dep('x', 'y', '<version>3</version>')}</dependencies></dependencyManagement>`);
    const loop = readMavenBuild([{ path: 'a/pom.xml', text: a }, { path: 'b/pom.xml', text: b }]);
    expect(versionsOf(loop.dependencies('a/pom.xml', { parent: true }))).toEqual([['x:y', 'compile', '3']]);
    const self = pom(`<parent><groupId>g</groupId><artifactId>s</artifactId><version>1</version><relativePath>pom.xml</relativePath></parent><artifactId>s</artifactId><dependencies>${dep('x', 'y')}</dependencies>`);
    expect(versionsOf(readMavenBuild([{ path: 'pom.xml', text: self }]).dependencies('pom.xml', { parent: true }))).toEqual([
      ['g:s', 'parent', '1'],
      ['x:y', 'compile', undefined],
    ]);
  });

  it('reads a pom alone as before, and gives nothing for a path it does not hold', () => {
    expect(versionsOf(extractMavenDependencies(APP))).toEqual([
      ['com.fasterxml.jackson.core:jackson-databind', 'compile', undefined],
      ['org.slf4j:slf4j-api', 'compile', undefined],
      ['com.google.guava:guava', 'compile', undefined],
      ['com.acme:acme-core', 'compile', undefined],
      ['junit:junit', 'test', undefined],
    ]);
    expect(build.dependencies('missing/pom.xml')).toEqual([]);
  });
});
