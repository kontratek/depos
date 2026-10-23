import { describe, expect, it } from 'vitest';
import { analyze } from '../../core/analyze';
import { manifestAdapterForPath } from '../../core/manifest';
import { parseNotes } from '../../core/parseNotes';
import {
  extractConanDependencies,
  extractConanPythonDependencies,
  extractConanTextDependencies,
} from '../../core/conan-manifest';

describe('Conan manifest matching', () => {
  it('matches Conan recipes but not lockfiles', () => {
    expect(manifestAdapterForPath('/repo/conanfile.py')?.kind).toBe('conan');
    expect(manifestAdapterForPath('/repo/conanfile.txt')?.kind).toBe('conan');
    expect(manifestAdapterForPath('/repo/conan.lock')).toBeUndefined();
  });
});

describe('conanfile.txt dependencies', () => {
  const manifest = `[requires]
zlib/1.3.1
OpenSSL/3.3.0@vendor/stable#revision

[tool_requires]
cmake/3.30.1

[test_requires]
catch2/3.7.0

[build_requires]
ninja/1.12.1

[generators]
CMakeDeps
`;

  it('extracts all supported Conan 1 and Conan 2 sections', () => {
    expect(extractConanTextDependencies(manifest).map((dependency) =>
      `${dependency.scope}:${dependency.noteKey}:${dependency.displayName}`)).toEqual([
      'requires:zlib:zlib',
      'requires:openssl:OpenSSL',
      'tool_requires:cmake:cmake',
      'test_requires:catch2:catch2',
      'build_requires:ninja:ninja',
    ]);
  });

  it('reads version ranges that contain spaces', () => {
    const ranged = '[requires]\nopenssl/[>=3.0 <4]\nzlib/[~1.3]\nboost/[>=1.80 <2]@vendor/stable\nspaced/1.0 trailing\n';
    expect(extractConanTextDependencies(ranged).map((dependency) => dependency.noteKey))
      .toEqual(['openssl', 'zlib', 'boost']);
  });

  it('keeps exact package ranges', () => {
    for (const dependency of extractConanTextDependencies(manifest)) {
      expect(manifest.slice(
        dependency.primaryRange.offset,
        dependency.primaryRange.offset + dependency.primaryRange.length,
      )).toBe(dependency.displayName);
    }
  });

  it('reads version ranges that contain spaces', () => {
    const ranges = `[requires]
openssl/[>=3.0 <4]
boost/[>1.80 <2, include_prerelease]@vendor/stable
unclosed/[>=1.0 <2
trailing/1.0 text

[tool_requires]
cmake/[>=3.25 <4]
`;
    expect(extractConanTextDependencies(ranges).map((dependency) =>
      `${dependency.scope}:${dependency.noteKey}`)).toEqual([
      'requires:openssl',
      'requires:boost',
      'tool_requires:cmake',
    ]);
  });
});

describe('conanfile.py dependencies', () => {
  const recipe = `from conan import ConanFile

class Example(ConanFile):
    requires = "zlib/1.3.1", "fmt/11.0.2"
    tool_requires = ["cmake/3.30.1", "ninja/1.12.1"]
    test_requires = ("catch2/3.7.0",)
    build_requires = "legacy_tool/1.0"
    ignored = "fake/1.0"
    dynamic = get_requirements()

    def requirements(self):
        self.requires("OpenSSL/3.3.0@vendor/stable")
        self.tool_requires("meson/1.5.0", force=True)
        self.test_requires(variable)
        self.requires(f"dynamic/{self.version}")
        text = "self.requires(\\"string_fake/1.0\\")"
        # self.requires("comment_fake/1.0")

def unrelated():
    requires = "outside/1.0"
`;

  it('extracts literal fields and self calls without executing Python', () => {
    expect(extractConanPythonDependencies(recipe).map((dependency) =>
      `${dependency.scope}:${dependency.noteKey}:${dependency.displayName}`)).toEqual([
      'requires:zlib:zlib',
      'requires:fmt:fmt',
      'tool_requires:cmake:cmake',
      'tool_requires:ninja:ninja',
      'test_requires:catch2:catch2',
      'build_requires:legacy_tool:legacy_tool',
      'requires:openssl:OpenSSL',
      'tool_requires:meson:meson',
    ]);
  });

  it('returns exact source ranges and dispatches by filename', () => {
    const dependencies = extractConanDependencies(recipe, '/repo/conanfile.py');
    for (const dependency of dependencies) {
      expect(recipe.slice(
        dependency.primaryRange.offset,
        dependency.primaryRange.offset + dependency.primaryRange.length,
      )).toBe(dependency.displayName);
      expect(['"', "'"]).toContain(recipe[dependency.iconRange.offset]);
    }
    expect(extractConanDependencies('[requires]\nzlib/1.3.1\n', '/repo/conanfile.txt')[0]?.noteKey).toBe('zlib');
  });

  it('reads version ranges that contain spaces', () => {
    const ranges = `class Recipe(ConanFile):
    requires = "openssl/[>=3.0 <4]", "fmt/[>=10 <12]"

    def requirements(self):
        self.tool_requires("cmake/[>=3.25 <4, include_prerelease]")
`;
    expect(extractConanPythonDependencies(ranges).map((dependency) =>
      `${dependency.scope}:${dependency.noteKey}`)).toEqual([
      'requires:openssl',
      'requires:fmt',
      'tool_requires:cmake',
    ]);
  });

  it('keeps declarations before malformed Python', () => {
    const malformed = 'class Recipe:\n    requires = "zlib/1.3.1"\n    broken = "unterminated';
    expect(extractConanPythonDependencies(malformed).map((dependency) => dependency.noteKey)).toEqual(['zlib']);
  });

  it('reads version ranges that contain spaces', () => {
    const ranged = `class Recipe(ConanFile):
    requires = "openssl/[>=3.0 <4]", "zlib/[~1.3]"

    def requirements(self):
        self.requires("boost/[>=1.80 <2]@vendor/stable")
        self.tool_requires("cmake/[>=3.20 <3.29 || >=3.30]")
        self.requires("spaced/1.0 trailing")
`;
    expect(extractConanPythonDependencies(ranged).map((dependency) => dependency.noteKey))
      .toEqual(['openssl', 'zlib', 'boost', 'cmake']);
  });

  it('matches note headings case-insensitively', () => {
    const notes = parseNotes('---\nformat: dependency-notes/2\necosystem: conan\n---\n# Dependency Notes\n\n## ZLIB\n\nCompression.\n');
    const dependency = extractConanTextDependencies('[requires]\nzlib/1.3.1\n')[0]!;
    expect(analyze([dependency], notes).documented).toEqual([dependency]);
  });
});
