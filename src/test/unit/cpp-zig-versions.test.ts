import { describe, expect, it } from 'vitest';
import { conanLockfileFor, isConanLockfilePath, parseConanLockfile } from '../../core/conan-lockfile';
import { conanPinnedVersion, extractConanDependencies } from '../../core/conan-manifest';
import { extractVcpkgDependencies, readVcpkgManifest, vcpkgBaselineKey, vcpkgBaselineVersion, vcpkgPinnedVersion } from '../../core/vcpkg-manifest';
import { extractZigDependencies, zigTagOf } from '../../core/zig-manifest';

const BASELINE_COMMIT = 'a42af01b72c28a8e1d7b48107b33e4f286a55ef6';

const VCPKG = JSON.stringify({
  name: 'app',
  'builtin-baseline': BASELINE_COMMIT,
  dependencies: [
    'fmt',
    { name: 'zlib', 'version>=': '1.3.1#1' },
    { name: 'openssl', 'version>=': '3.0.0' },
    { name: 'boost-asio', features: ['ssl'] },
    { name: 'vcpkg-cmake', host: true },
    'not-in-baseline',
  ],
  overrides: [{ name: 'boost-asio', version: '1.84.0', 'port-version': 2 }],
}, null, 2);

const BASELINE = JSON.stringify({
  default: {
    'fmt': { 'baseline': '12.2.1', 'port-version': 0 },
    'zlib': { 'baseline': '1.3.1', 'port-version': 0 },
    'openssl': { 'baseline': '3.4.0', 'port-version': 1 },
    'boost-asio': { 'baseline': '1.92.0', 'port-version': 0 },
    'vcpkg-cmake': { 'baseline': '2024-04-23', 'port-version': 0 },
  },
});

describe('vcpkg versions', () => {
  it('writes an override as the version and a minimum as >=', () => {
    expect(extractVcpkgDependencies(VCPKG).map((dep) => [dep.noteKey, dep.versionSpec])).toEqual([
      ['fmt', undefined],
      ['zlib', '>=1.3.1#1'],
      ['openssl', '>=3.0.0'],
      ['boost-asio', '1.84.0#2'],
      ['vcpkg-cmake', undefined],
      ['not-in-baseline', undefined],
    ]);
  });

  it('names the baseline commit, from builtin-baseline or an embedded configuration of vcpkg\'s own registry', () => {
    expect(vcpkgBaselineKey(VCPKG)).toBe(`vcpkg-baseline:${BASELINE_COMMIT}`);
    const embedded = (registry: object) => JSON.stringify({ dependencies: ['fmt'], 'vcpkg-configuration': { 'default-registry': registry } });
    expect(vcpkgBaselineKey(embedded({ kind: 'builtin', baseline: BASELINE_COMMIT }))).toBe(`vcpkg-baseline:${BASELINE_COMMIT}`);
    expect(vcpkgBaselineKey(embedded({ kind: 'git', repository: 'https://github.com/microsoft/vcpkg', baseline: BASELINE_COMMIT }))).toBe(`vcpkg-baseline:${BASELINE_COMMIT}`);
    expect(vcpkgBaselineKey(embedded({ kind: 'git', repository: 'https://github.com/acme/ports', baseline: BASELINE_COMMIT }))).toBeUndefined();
    expect(vcpkgBaselineKey(JSON.stringify({ 'builtin-baseline': 'main' }))).toBeUndefined();
    expect(vcpkgBaselineKey('{"dependencies": ["fmt"]}')).toBeUndefined();
  });

  it('installs the override, else the baseline\'s version raised to a higher minimum', () => {
    expect(vcpkgBaselineVersion(BASELINE, 'OpenSSL')).toBe('3.4.0#1');
    expect(readVcpkgManifest(VCPKG, BASELINE).map((dep) => [dep.noteKey, dep.installedVersion])).toEqual([
      ['fmt', '12.2.1'],
      // The minimum is above the baseline.
      ['zlib', '1.3.1#1'],
      ['openssl', '3.4.0#1'],
      ['boost-asio', '1.84.0#2'],
      ['vcpkg-cmake', '2024-04-23'],
      ['not-in-baseline', undefined],
    ]);
    // Without the baseline only an override is known.
    expect(readVcpkgManifest(VCPKG, null).map((dep) => dep.installedVersion)).toEqual([undefined, undefined, undefined, '1.84.0#2', undefined, undefined]);
  });

  it('pins an override, not a minimum', () => {
    expect(vcpkgPinnedVersion('1.84.0#2')).toBe('1.84.0#2');
    expect(vcpkgPinnedVersion('>=3.0.0')).toBeUndefined();
    expect(vcpkgPinnedVersion(undefined)).toBeUndefined();
  });
});

describe('Conan versions', () => {
  it('reads the version of a reference, in conanfile.txt and conanfile.py', () => {
    const txt = '[requires]\nzlib/1.3.1\nopenssl/[>=3.0 <4]\nboost/1.84.0#a1b2c3\nacme/2.0@acme/stable\n[tool_requires]\ncmake/3.28.1\n';
    expect(extractConanDependencies(txt, 'conanfile.txt').map((dep) => [dep.noteKey, dep.scope, dep.versionSpec])).toEqual([
      ['zlib', 'requires', '1.3.1'],
      ['openssl', 'requires', '[>=3.0 <4]'],
      ['boost', 'requires', '1.84.0'],
      ['acme', 'requires', '2.0@acme/stable'],
      ['cmake', 'tool_requires', '3.28.1'],
    ]);
    const py = 'from conan import ConanFile\n\nclass App(ConanFile):\n    requires = "fmt/10.2.1", "spdlog/[~1.13]"\n\n    def requirements(self):\n        self.requires("zlib/1.3.1")\n';
    expect(extractConanDependencies(py, 'conanfile.py').map((dep) => [dep.noteKey, dep.versionSpec])).toEqual([
      ['fmt', '10.2.1'],
      ['spdlog', '[~1.13]'],
      ['zlib', '1.3.1'],
    ]);
  });

  it('pins a plain version, not a range or a user and channel', () => {
    expect(conanPinnedVersion('1.3.1')).toBe('1.3.1');
    expect(conanPinnedVersion('[>=3.0 <4]')).toBeUndefined();
    expect(conanPinnedVersion('2.0@acme/stable')).toBeUndefined();
  });

  it('reads conan.lock at or above the conanfile, in Conan 2\'s form and Conan 1\'s', () => {
    expect(isConanLockfilePath('app/conan.lock')).toBe(true);
    expect(conanLockfileFor('app/conanfile.txt', new Set(['conan.lock']))).toBe('conan.lock');
    const conan2 = parseConanLockfile('conan.lock', JSON.stringify({
      version: '0.5',
      requires: ['zlib/1.3.1#f52e03ae3d251dec704634230cd806a2%1708593606.497', 'openssl/3.2.1#abc%1', 'acme/2.0@acme/stable#x%1'],
      build_requires: ['cmake/3.28.1#def%2', 'openssl/3.0.13#ghi%3'],
      python_requires: [],
    }));
    expect(conan2.resolve('conanfile.txt', 'zlib', '1.3.1')).toBe('1.3.1');
    expect(conan2.resolve('conanfile.txt', 'cmake', undefined)).toBe('3.28.1');
    // Locked at two versions: a host and a build context.
    expect(conan2.resolve('conanfile.txt', 'openssl', undefined)).toBeUndefined();
    expect(conan2.resolve('conanfile.txt', 'acme', undefined)).toBeUndefined();
    const conan1 = parseConanLockfile('conan.lock', JSON.stringify({
      version: '0.4',
      graph_lock: { nodes: { 0: { ref: 'conanfile.txt' }, 1: { ref: 'zlib/1.2.11#rev' } } },
    }));
    expect(conan1.resolve('conanfile.txt', 'zlib', undefined)).toBe('1.2.11');
    expect(() => parseConanLockfile('conan.lock', '{"version": 1}')).toThrow();
    expect(() => parseConanLockfile('conan.lock', 'not json')).toThrow();
  });
});

describe('Zig versions', () => {
  it('reads the release a URL names, and no commit', () => {
    expect(zigTagOf('https://github.com/zigzap/zap/archive/refs/tags/v0.9.1.tar.gz')).toBe('v0.9.1');
    expect(zigTagOf('https://github.com/a/b/archive/0.3.0.tar.gz')).toBe('0.3.0');
    expect(zigTagOf('https://github.com/a/b/releases/download/v1.2.0/b-1.2.0.tar.xz')).toBe('v1.2.0');
    expect(zigTagOf('https://gitlab.com/a/b/-/archive/v2.0.0/b-v2.0.0.tar.gz')).toBe('v2.0.0');
    expect(zigTagOf('git+https://github.com/a/b#v0.14.0')).toBe('v0.14.0');
    expect(zigTagOf('git+https://github.com/a/b#4a2eaa993a4f1f26f204d3b47ff3b2f2c5d29df4')).toBeUndefined();
    expect(zigTagOf('https://github.com/a/b/archive/4a2eaa993a4f1f26f204d3b47ff3b2f2c5d29df4.tar.gz')).toBeUndefined();
    expect(zigTagOf('https://github.com/a/b/archive/refs/heads/main.tar.gz')).toBeUndefined();
  });

  it('gives a dependency its URL, a local one file:, and the release its hash pins', () => {
    const zon = `.{
    .name = .app,
    .version = "0.1.0",
    .dependencies = .{
        .zap = .{
            .url = "https://github.com/zigzap/zap/archive/refs/tags/v0.9.1.tar.gz",
            .hash = "1220abcdef",
        },
        .local = .{ .path = "../local" },
        .@"odd-name" = .{ .url = "git+https://github.com/a/b#4a2eaa993a4f1f26f204d3b47ff3b2f2c5d29df4", .hash = "x" },
    },
}`;
    expect(extractZigDependencies(zon).map((dep) => [dep.noteKey, dep.versionSpec, dep.installedVersion])).toEqual([
      ['zap', 'https://github.com/zigzap/zap/archive/refs/tags/v0.9.1.tar.gz', 'v0.9.1'],
      ['local', 'file:../local', undefined],
      ['odd-name', 'git+https://github.com/a/b#4a2eaa993a4f1f26f204d3b47ff3b2f2c5d29df4', undefined],
    ]);
  });
});
