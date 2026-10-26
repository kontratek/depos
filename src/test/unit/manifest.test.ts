import { describe, expect, it } from 'vitest';
import { extractCargoDependencies } from '../../core/cargoManifest';
import {
  dependencyAtOffset,
  manifestAdapterForFileName,
  manifestAdapterForKind,
  MANIFEST_ADAPTERS,
  notesKindOfPath,
  notesRelativePathIn,
} from '../../core/manifest';
import { extractMavenDependencies } from '../../core/mavenManifest';
import { extractGradleDependencies } from '../../core/gradleManifest';
import { extractMixDependencies } from '../../core/mixManifest';
import { extractZigDependencies } from '../../core/zig-manifest';

describe('manifest adapters', () => {
  it('matches all supported manifest names', () => {
    expect(manifestAdapterForFileName('package.json')?.kind).toBe('npm');
    expect(manifestAdapterForFileName('Cargo.toml')?.kind).toBe('cargo');
    expect(manifestAdapterForFileName('pom.xml')?.kind).toBe('maven');
    expect(manifestAdapterForFileName('build.gradle')?.kind).toBe('gradle');
    expect(manifestAdapterForFileName('build.gradle.kts')?.kind).toBe('gradle');
    expect(manifestAdapterForFileName('mix.exs')?.kind).toBe('mix');
    expect(manifestAdapterForFileName('gleam.toml')?.kind).toBe('gleam');
    expect(manifestAdapterForFileName('build.zig.zon')?.kind).toBe('zig');
    expect(manifestAdapterForFileName('pyproject.toml')?.kind).toBe('python');
    expect(manifestAdapterForFileName('requirements-dev.txt')?.kind).toBe('python');
    expect(manifestAdapterForFileName('Gemfile')?.kind).toBe('ruby');
    expect(manifestAdapterForFileName('gems.rb')?.kind).toBe('ruby');
    expect(manifestAdapterForFileName('example.gemspec')?.kind).toBe('ruby');
    expect(manifestAdapterForFileName('go.mod')?.kind).toBe('go');
    expect(manifestAdapterForFileName('vcpkg.json')?.kind).toBe('vcpkg');
    expect(manifestAdapterForFileName('conanfile.py')?.kind).toBe('conan');
    expect(manifestAdapterForFileName('conanfile.txt')?.kind).toBe('conan');
    expect(manifestAdapterForFileName('composer.json')?.kind).toBe('composer');
    expect(manifestAdapterForFileName('settings.gradle')).toBeUndefined();
    expect(manifestAdapterForFileName('Gemfile.lock')).toBeUndefined();
  });
});

describe('notes paths under .depos/ and .pacmon/', () => {
  it('names the current directory, and the legacy one on request', () => {
    for (const adapter of MANIFEST_ADAPTERS) expect(adapter.notesRelativePath.startsWith('.depos/'), adapter.kind).toBe(true);
    const cargo = manifestAdapterForKind('cargo');
    expect(notesRelativePathIn(cargo, '.depos')).toBe('.depos/cargo/DEPENDENCY-NOTES.md');
    expect(notesRelativePathIn(cargo, '.pacmon')).toBe('.pacmon/cargo/DEPENDENCY-NOTES.md');
    expect(notesRelativePathIn(manifestAdapterForKind('npm'), '.pacmon')).toBe('.pacmon/DEPENDENCY-NOTES.md');
  });

  it('knows a notes file under either directory, and nothing else', () => {
    expect(notesKindOfPath('/repo/.depos/DEPENDENCY-NOTES.md')).toBe('npm');
    expect(notesKindOfPath('/repo/.pacmon/DEPENDENCY-NOTES.md')).toBe('npm');
    expect(notesKindOfPath('/repo/apps/api/.pacmon/cargo/DEPENDENCY-NOTES.md')).toBe('cargo');
    expect(notesKindOfPath('C:\\repo\\.depos\\nuget\\DEPENDENCY-NOTES.md')).toBe('nuget');
    expect(notesKindOfPath('/repo/DEPENDENCY-NOTES.md')).toBeUndefined();
    expect(notesKindOfPath('/repo/.depos/AGENT-RULES.md')).toBeUndefined();
    expect(notesKindOfPath('/repo/.other/cargo/DEPENDENCY-NOTES.md')).toBeUndefined();
  });
});

describe('Zig dependencies', () => {
  const zon = String.raw`.{
  .name = .example,
  .version = "0.1.0",
  .dependencies = .{
    .known_folders = .{
      .url = "https://example.test/known-folders.tar.gz",
      .hash = "known-folders-hash",
    },
    .local_utils = .{ .path = "../local-utils" },
    .lazy_dep = .{
      .url = "https://example.test/lazy.tar.gz",
      .hash = "lazy-hash",
      .lazy = true,
    },
    .@"quoted-dep" = .{ .path = "../quoted" },
  },
  .paths = .{ "build.zig", "src" },
}`;

  it('extracts URL, path, lazy and escaped direct dependencies', () => {
    expect(extractZigDependencies(zon).map((dep) => `${dep.scope}:${dep.noteKey}`)).toEqual([
      'dependencies:known_folders',
      'dependencies:local_utils',
      'dependencies:lazy_dep',
      'dependencies:quoted-dep',
    ]);
  });

  it('keeps dependency names clickable and anchors icons at the field dot', () => {
    const deps = extractZigDependencies(zon);
    const known = deps[0]!;
    expect(zon.slice(known.primaryRange.offset, known.primaryRange.offset + known.primaryRange.length))
      .toBe('known_folders');
    expect(zon.slice(known.sourceRanges[0]!.offset, known.sourceRanges[0]!.offset + known.sourceRanges[0]!.length))
      .toBe('known_folders');
    expect(zon.slice(known.iconRange.offset, known.iconRange.offset + known.iconRange.length)).toBe('.');
    expect(dependencyAtOffset(deps, known.primaryRange.offset + 2)?.noteKey).toBe('known_folders');

    const quoted = deps[3]!;
    expect(zon.slice(quoted.primaryRange.offset, quoted.primaryRange.offset + quoted.primaryRange.length))
      .toBe('quoted-dep');
    expect(zon.slice(quoted.sourceRanges[0]!.offset, quoted.sourceRanges[0]!.offset + quoted.sourceRanges[0]!.length))
      .toBe('@"quoted-dep"');
  });

  it('ignores nested fields and fake declarations in comments and strings', () => {
    const text = String.raw`.{
      // .dependencies = .{ .commented = .{ .path = "x" } },
      .description = ".dependencies = .{ .string = .{} }",
      .dependencies = .{
        .real = .{
          .url = "https://example.test/.fake = .{}",
          .hash = "hash",
        },
      },
      .other = .{ .nested = .{ .path = "not-a-dependency" } },
    }`;
    expect(extractZigDependencies(text).map((dep) => dep.noteKey)).toEqual(['real']);
  });

  it('supports Zig string escapes in escaped identifiers and first duplicate wins', () => {
    const text = String.raw`.{ .dependencies = .{
      .@"quoted\x2ddep" = .{ .path = "a" },
      .@"quoted-dep" = .{ .path = "b" },
      .@"snowman\u{2603}" = .{ .path = "c" },
    } }`;
    expect(extractZigDependencies(text).map((dep) => dep.noteKey)).toEqual(['quoted-dep', 'snowman☃']);
  });

  it('keeps fields found before a malformed tail and handles empty or missing tables', () => {
    expect(extractZigDependencies('.{ .dependencies = .{ .first = .{}, .broken = .{'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ noteKey: 'first' }),
        expect.objectContaining({ noteKey: 'broken' }),
      ]));
    expect(extractZigDependencies('.{ .dependencies = .{} }')).toEqual([]);
    expect(extractZigDependencies('.{ .name = .none }')).toEqual([]);
  });

  it('accepts the legacy string package name used by older Zig manifests', () => {
    const legacy = `.{
      .name = "legacy-app",
      .version = "0.1.0",
      .dependencies = .{ .legacy_dep = .{ .path = "../legacy" } },
    }`;
    expect(extractZigDependencies(legacy).map((dep) => dep.noteKey)).toEqual(['legacy_dep']);
  });

  it('skips braces and dependency-like text in multiline string lines', () => {
    const text = '.{\n  .description = \\\\ .dependencies = .{ .fake = .{} },\n'
      + '  .dependencies = .{ .real = .{ .path = "../real" } },\n}';
    expect(extractZigDependencies(text).map((dep) => dep.noteKey)).toEqual(['real']);
  });
});

describe('Mix dependencies', () => {
  const mix = String.raw`defmodule Example.MixProject do
  use Mix.Project

  def project do
    [app: :example, deps: deps()]
  end

  defp deps do
    [
      {:phoenix, "~> 1.8"},
      {:ecto_sql, "~> 3.13", only: [:dev, :test]},
      {:wallaby, "~> 0.30", only: :test},
      {:nerves_system, github: "nerves-project/system", targets: [:rpi3, :rpi4]},
      {:local_app, path: "../local_app"},
      {:accounts, in_umbrella: true},
      {:"quoted-dep", "~> 1.0"},
      {:wallaby, "~> 0.30", only: :test}
    ]
  end
end`;

  it('extracts literal Hex, Git, path and umbrella tuples with environment and target scopes', () => {
    expect(extractMixDependencies(mix).map((dep) => `${dep.scope}:${dep.noteKey}`)).toEqual([
      'deps:phoenix',
      'deps:dev,test:ecto_sql',
      'deps:test:wallaby',
      'deps@rpi3,rpi4:nerves_system',
      'deps:local_app',
      'deps:accounts',
      'deps:quoted-dep',
    ]);
  });

  it('supports inline project lists and expression-bodied deps functions', () => {
    const text = `def project, do: [app: :demo, deps: [{:jason, "~> 1.4"}]]\n`
      + `defp deps(), do: [{:plug, git: "https://example.test/plug.git"}]`;
    expect(extractMixDependencies(text).map((dep) => dep.noteKey)).toEqual(['jason', 'plug']);
  });

  it('keeps atom ranges clickable and anchors the icon at the tuple', () => {
    const dependencies = extractMixDependencies(mix);
    const phoenix = dependencies[0]!;
    expect(mix.slice(phoenix.primaryRange.offset, phoenix.primaryRange.offset + phoenix.primaryRange.length)).toBe('phoenix');
    expect(mix.slice(phoenix.sourceRanges[0]!.offset, phoenix.sourceRanges[0]!.offset + phoenix.sourceRanges[0]!.length)).toBe(':phoenix');
    expect(mix.slice(phoenix.iconRange.offset, phoenix.iconRange.offset + phoenix.iconRange.length)).toBe('{');
    expect(dependencyAtOffset(dependencies, mix.indexOf(':phoenix') + 2)?.noteKey).toBe('phoenix');

    const quoted = dependencies.find((dep) => dep.noteKey === 'quoted-dep')!;
    expect(mix.slice(quoted.primaryRange.offset, quoted.primaryRange.offset + quoted.primaryRange.length)).toBe('quoted-dep');
    expect(mix.slice(quoted.sourceRanges[0]!.offset, quoted.sourceRanges[0]!.offset + quoted.sourceRanges[0]!.length)).toBe(':"quoted-dep"');
  });

  it('ignores dynamic dependencies and fake tuples in comments, strings, heredocs and sigils', () => {
    const text = String.raw`
      # deps: [{:commented, "1"}]
      @deps [{:attribute, "1"}]
      @doc "deps: [{:string, \"1\"}]"
      @moduledoc """
      deps: [{:heredoc, "1"}]
      """
      @pattern ~r/deps: \[\{:sigil, "1"\}\]/
      defp deps do
        @deps ++ [{:concatenated, "1"}]
      end
      defp other, do: [{:other_helper, "1"}]
      defp nested, do: [{:outer, custom: [only: :test], deps: [{:nested, "1"}]}]
    `;
    expect(extractMixDependencies(text)).toEqual([]);
  });

  it('fails safely on malformed dependency lists', () => {
    expect(extractMixDependencies('defp deps do [{:phoenix, "~> 1.8"}')).toEqual([]);
  });
});

describe('Gradle dependencies', () => {
  const gradle = String.raw`plugins { id("java") }

dependencies {
  val example = "ignored:string:1"
  // implementation("ignored:comment:1")
  implementation("com.google.guava:guava:33.4.0-jre")
  testImplementation 'org.junit.jupiter:junit-jupiter:5.12.0'
  api(group = "org.slf4j", name = "slf4j-api", version = version)
  runtimeOnly group: 'org.postgresql', name: 'postgresql', version: pgVersion
  implementation(platform("org.springframework.boot:spring-boot-dependencies:3.5.0"))
  implementation(libs.jackson.databind)
  add("integrationTestImplementation", "org.assertj:assertj-core:3.27.3")
  "customRuntime"("com.acme:tool:1")

  constraints { implementation("ignored:constraint:1") }
  implementation(project(":local"))
  runtimeOnly(files("libs/local.jar"))
  runtimeOnly(files("C:/libs/local.jar"))
  implementation(libs.bundles.testing)
}

buildscript { dependencies { classpath("ignored:plugin:1") } }
`;

  it('extracts Groovy and Kotlin module notations, wrappers, aliases, and add calls', () => {
    const deps = extractGradleDependencies(gradle);
    expect(deps.map((dep) => `${dep.scope}:${dep.noteKey}`)).toEqual([
      'implementation:com.google.guava:guava',
      'testImplementation:org.junit.jupiter:junit-jupiter',
      'api:org.slf4j:slf4j-api',
      'runtimeOnly:org.postgresql:postgresql',
      'implementation:org.springframework.boot:spring-boot-dependencies',
      'implementation:libs.jackson.databind',
      'integrationTestImplementation:org.assertj:assertj-core',
      'customRuntime:com.acme:tool',
    ]);
  });

  it('keeps coordinate and icon ranges separate and makes aliases clickable', () => {
    const deps = extractGradleDependencies(gradle);
    const guava = deps[0]!;
    expect(gradle.slice(guava.primaryRange.offset, guava.primaryRange.offset + guava.primaryRange.length)).toBe('guava');
    expect(gradle.slice(guava.iconRange.offset, guava.iconRange.offset + guava.iconRange.length)).toBe('implementation');
    expect(guava.sourceRanges.map((range) => gradle.slice(range.offset, range.offset + range.length)))
      .toEqual(['com.google.guava', 'guava']);
    const alias = deps.find((dep) => dep.noteKey === 'libs.jackson.databind')!;
    expect(dependencyAtOffset(deps, alias.primaryRange.offset + 2)?.noteKey).toBe('libs.jackson.databind');
  });

  it('handles multiline and malformed input safely', () => {
    const multiline = `dependencies {\n  implementation(\n    enforcedPlatform(\n      "com.acme:bom:1"\n    )\n  )\n}`;
    expect(extractGradleDependencies(multiline).map((dep) => dep.noteKey)).toEqual(['com.acme:bom']);
    expect(extractGradleDependencies('dependencies { implementation("g:a:1")')).toEqual([]);
  });
});

describe('Cargo.toml dependencies', () => {
  const cargo = String.raw`[dependencies]
serde = "1"
"quoted.dep" = "1"
local = { package = "upstream", version = "2" } # alias
multi = {
  package = "multiline-upstream",
  version = "3"
}
workspace-crate.workspace = true

[dev-dependencies]
pretty_assertions = "1"

[build-dependencies.cc]
version = "1"

[target.'cfg(unix)'.dependencies]
nix = "0.29"

[target."cfg(windows)".build-dependencies.winres]
version = "0.1"

[workspace.dependencies]
not-direct = "1"
`;

  it('extracts direct, table, target and workspace-reference declarations', () => {
    const deps = extractCargoDependencies(cargo);
    expect(deps.map((dep) => `${dep.scope}:${dep.noteKey}`)).toEqual([
      'dependencies:serde',
      'dependencies:quoted.dep',
      'dependencies:local',
      'dependencies:multi',
      'dependencies:workspace-crate',
      'dev-dependencies:pretty_assertions',
      'build-dependencies:cc',
      'target:cfg(unix)/dependencies:nix',
      'target:cfg(windows)/build-dependencies:winres',
    ]);
  });

  it('keeps aliases as note keys and source ranges point to their manifest keys', () => {
    const deps = extractCargoDependencies(cargo);
    const alias = deps.find((dep) => dep.noteKey === 'local')!;
    expect(cargo.slice(alias.primaryRange.offset, alias.primaryRange.offset + alias.primaryRange.length)).toBe('local');
    expect(alias.iconRange).toEqual(alias.primaryRange);
    expect(dependencyAtOffset(deps, alias.primaryRange.offset + 1)?.noteKey).toBe('local');
  });

  it('fails safely on malformed input', () => {
    expect(extractCargoDependencies('[dependencies\nserde = "1"')).toEqual([]);
  });

});

describe('pom.xml dependencies', () => {
  const pom = `<?xml version="1.0"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <dependencies>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
    </dependency>
  </dependencies>
  <dependencyManagement><dependencies><dependency>
    <groupId>managed</groupId><artifactId>not-direct</artifactId>
  </dependency></dependencies></dependencyManagement>
  <build><plugins><plugin><dependencies><dependency>
    <groupId>plugin</groupId><artifactId>not-direct</artifactId>
  </dependency></dependencies></plugin></plugins></build>
  <profiles><profile><id>native</id><dependencies><dependency>
    <groupId>\${native.group}</groupId><artifactId>bridge</artifactId><scope>runtime</scope>
  </dependency></dependencies></profile></profiles>
</project>`;

  it('extracts project and profile dependencies but excludes management and plugins', () => {
    expect(extractMavenDependencies(pom).map((dep) => `${dep.scope}:${dep.noteKey}`)).toEqual([
      'compile:org.slf4j:slf4j-api',
      'profile:native/runtime:${native.group}:bridge',
    ]);
  });

  it('makes groupId and artifactId hoverable, decorates artifactId and anchors the icon at dependency', () => {
    const deps = extractMavenDependencies(pom);
    const slf4j = deps[0]!;
    expect(slf4j.sourceRanges).toHaveLength(2);
    expect(pom.slice(slf4j.primaryRange.offset, slf4j.primaryRange.offset + slf4j.primaryRange.length)).toBe('slf4j-api');
    expect(slf4j.iconRange.offset).toBe(pom.indexOf('<dependency>'));
    expect(pom.slice(slf4j.iconRange.offset, slf4j.iconRange.offset + slf4j.iconRange.length)).toBe('<');
    const groupOffset = pom.indexOf('org.slf4j');
    expect(dependencyAtOffset(deps, groupOffset + 1)?.noteKey).toBe('org.slf4j:slf4j-api');
    expect(dependencyAtOffset(deps, slf4j.iconRange.offset)).toBeUndefined();
  });

  it('decodes namespaced XML with dependency attributes while retaining source ranges', () => {
    const xml = `<m:project xmlns:m="urn:test"><m:dependencies><m:dependency optional="true">
      <m:groupId><![CDATA[org.example]]></m:groupId>
      <m:artifactId>client&amp;api</m:artifactId>
    </m:dependency></m:dependencies></m:project>`;
    const dependency = extractMavenDependencies(xml)[0]!;
    expect(dependency.noteKey).toBe('org.example:client&api');
    expect(dependency.iconRange.offset).toBe(xml.indexOf('<m:dependency optional="true">'));
    expect(xml.slice(dependency.primaryRange.offset, dependency.primaryRange.offset + dependency.primaryRange.length))
      .toBe('client&amp;api');
  });

  it('fails safely on malformed input', () => {
    expect(extractMavenDependencies('<not-project><dependency>')).toEqual([]);
  });
});
