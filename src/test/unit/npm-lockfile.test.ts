import { describe, expect, it } from 'vitest';
import { isNpmLockfilePath, npmLockfileFor, parseNpmLockfile } from '../../core/npm-lockfile';

describe('isNpmLockfilePath', () => {
  it('knows the lockfiles at any depth', () => {
    expect(isNpmLockfilePath('package-lock.json')).toBe(true);
    expect(isNpmLockfilePath('apps/web/yarn.lock')).toBe(true);
    expect(isNpmLockfilePath('package.json')).toBe(false);
    expect(isNpmLockfilePath('my-yarn.lock')).toBe(false);
  });
});

describe('npmLockfileFor', () => {
  it('takes the closest lockfile at or above the manifest', () => {
    const paths = new Set(['pnpm-lock.yaml', 'apps/legacy/package-lock.json']);
    expect(npmLockfileFor('package.json', paths)).toBe('pnpm-lock.yaml');
    expect(npmLockfileFor('apps/web/package.json', paths)).toBe('pnpm-lock.yaml');
    expect(npmLockfileFor('apps/legacy/package.json', paths)).toBe('apps/legacy/package-lock.json');
    expect(npmLockfileFor('apps/legacy/sub/package.json', paths)).toBe('apps/legacy/package-lock.json');
  });

  it('does not take a lockfile from a sibling directory or a similar name', () => {
    expect(npmLockfileFor('apps/web/package.json', new Set(['apps/api/yarn.lock', 'apps/web-old/yarn.lock']))).toBeUndefined();
  });

  it('prefers pnpm, then Yarn, then npm in one directory', () => {
    expect(npmLockfileFor('package.json', new Set(['package-lock.json', 'yarn.lock']))).toBe('yarn.lock');
    expect(npmLockfileFor('package.json', new Set(['package-lock.json', 'pnpm-lock.yaml']))).toBe('pnpm-lock.yaml');
    expect(npmLockfileFor('package.json', new Set(['package-lock.json', 'npm-shrinkwrap.json']))).toBe('npm-shrinkwrap.json');
  });
});

describe('package-lock.json', () => {
  const lock = parseNpmLockfile('package-lock.json', JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { express: '^4.0.0' } },
      'apps/web': { dependencies: { express: '^5.0.0', shared: '*' } },
      'node_modules/express': { version: '4.18.2' },
      'node_modules/lodash': { version: '4.17.21' },
      'node_modules/alias': { name: 'real-package', version: '2.0.0' },
      'node_modules/shared': { resolved: 'packages/shared', link: true },
      'node_modules/from-git': { version: '1.0.0', resolved: 'git+ssh://git@github.com/a/b.git#abc' },
      'apps/web/node_modules/express': { version: '5.0.1' },
    },
  }));

  it('reads the root project', () => {
    expect(lock.resolve('package.json', 'express', '^4.0.0')).toBe('4.18.2');
  });

  it('finds a workspace\'s own copy first, then the hoisted one', () => {
    expect(lock.resolve('apps/web/package.json', 'express', '^5.0.0')).toBe('5.0.1');
    expect(lock.resolve('apps/web/package.json', 'lodash', '^4.0.0')).toBe('4.17.21');
  });

  it('gives an aliased package its version, and a workspace link none', () => {
    expect(lock.resolve('package.json', 'alias', 'npm:real-package@^2')).toBe('2.0.0');
    expect(lock.resolve('apps/web/package.json', 'shared', '*')).toBeUndefined();
  });

  it('gives nothing for a package it does not hold', () => {
    expect(lock.resolve('package.json', 'missing', '^1.0.0')).toBeUndefined();
  });

  it('gives nothing for a manifest outside the lockfile\'s directory', () => {
    const nested = parseNpmLockfile('apps/web/package-lock.json', JSON.stringify({ packages: { 'node_modules/a': { version: '1.0.0' } } }));
    expect(nested.resolve('apps/web/package.json', 'a', '^1.0.0')).toBe('1.0.0');
    expect(nested.resolve('apps/web-old/package.json', 'a', '^1.0.0')).toBeUndefined();
    expect(nested.resolve('package.json', 'a', '^1.0.0')).toBeUndefined();
  });

  it('reads lockfile v1, for the root project only', () => {
    const v1 = parseNpmLockfile('package-lock.json', JSON.stringify({ lockfileVersion: 1, dependencies: { express: { version: '4.17.1' } } }));
    expect(v1.resolve('package.json', 'express', '^4.0.0')).toBe('4.17.1');
    expect(v1.resolve('apps/web/package.json', 'express', '^4.0.0')).toBeUndefined();
  });

  it('does not read inherited object keys as packages', () => {
    const v1 = parseNpmLockfile('package-lock.json', JSON.stringify({ dependencies: {} }));
    expect(v1.resolve('package.json', 'constructor', '^1.0.0')).toBeUndefined();
  });

  it('throws on a file that is not one', () => {
    expect(() => parseNpmLockfile('package-lock.json', '{ nope')).toThrow();
    expect(() => parseNpmLockfile('package-lock.json', '[]')).toThrow();
    expect(() => parseNpmLockfile('package-lock.json', '{"name":"x"}')).toThrow();
  });
});

describe('pnpm-lock.yaml', () => {
  const WORKSPACE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      express:
        specifier: ^4.0.0
        version: 4.18.2
      react-dom:
        specifier: ^18.0.0
        version: 18.2.0(react@18.2.0)
    devDependencies:
      '@types/node':
        specifier: ^20.0.0
        version: 20.1.0

  apps/web:
    dependencies:
      express:
        specifier: ^5.0.0
        version: 5.0.1
      shared:
        specifier: workspace:*
        version: link:../../packages/shared
      alias:
        specifier: npm:real-package@^2
        version: real-package@2.0.0
    optionalDependencies:
      fsevents:
        specifier: ^2.3.0
        version: 2.3.3

packages:

  express@4.18.2:
    resolution: {integrity: sha512-this: [is not read}
`;

  const lock = parseNpmLockfile('pnpm-lock.yaml', WORKSPACE);

  it('reads each importer by the manifest\'s directory', () => {
    expect(lock.resolve('package.json', 'express', '^4.0.0')).toBe('4.18.2');
    expect(lock.resolve('apps/web/package.json', 'express', '^5.0.0')).toBe('5.0.1');
    expect(lock.resolve('package.json', '@types/node', '^20.0.0')).toBe('20.1.0');
    expect(lock.resolve('apps/web/package.json', 'fsevents', '^2.3.0')).toBe('2.3.3');
  });

  it('leaves the peers out of the version', () => {
    expect(lock.resolve('package.json', 'react-dom', '^18.0.0')).toBe('18.2.0');
  });

  it('gives an alias its version, and a workspace link none', () => {
    expect(lock.resolve('apps/web/package.json', 'alias', 'npm:real-package@^2')).toBe('2.0.0');
    expect(lock.resolve('apps/web/package.json', 'shared', 'workspace:*')).toBeUndefined();
  });

  it('gives nothing for an importer it does not hold', () => {
    expect(lock.resolve('examples/demo/package.json', 'express', '^4.0.0')).toBeUndefined();
  });

  it('reads a single project without importers', () => {
    const single = parseNpmLockfile('pnpm-lock.yaml', `lockfileVersion: '6.0'

dependencies:
  express:
    specifier: ^4.0.0
    version: 4.18.2
`);
    expect(single.resolve('package.json', 'express', '^4.0.0')).toBe('4.18.2');
  });

  it('reads the older flat form', () => {
    const old = parseNpmLockfile('pnpm-lock.yaml', `lockfileVersion: 5.4

specifiers:
  react-dom: ^18.0.0

dependencies:
  react-dom: 18.2.0_react@18.2.0
`);
    expect(old.resolve('package.json', 'react-dom', '^18.0.0')).toBe('18.2.0');
  });

  it('throws on a file that is not one', () => {
    expect(() => parseNpmLockfile('pnpm-lock.yaml', 'name: x\n')).toThrow();
    expect(() => parseNpmLockfile('pnpm-lock.yaml', 'a: [unclosed\n')).toThrow();
  });

  it('refuses a head too long to parse, but not a long packages section', () => {
    const filler = `# ${'x'.repeat(4 * 1024 * 1024)}\n`;
    expect(() => parseNpmLockfile('pnpm-lock.yaml', `lockfileVersion: '9.0'\n${filler}`)).toThrow('too many projects');
    expect(parseNpmLockfile('pnpm-lock.yaml', `lockfileVersion: '9.0'\npackages:\n${filler}`).resolve('package.json', 'a', '^1.0.0')).toBeUndefined();
  });

  it('refuses an alias bomb', () => {
    const levels = Array.from({ length: 12 }, (_, i) => `l${i + 1}: &l${i + 1} [*l${i}, *l${i}, *l${i}, *l${i}, *l${i}, *l${i}, *l${i}, *l${i}, *l${i}]`).join('\n');
    expect(() => parseNpmLockfile('pnpm-lock.yaml', `lockfileVersion: '9.0'\nl0: &l0 [x]\n${levels}\n`)).toThrow();
  });
});

describe('yarn.lock', () => {
  it('reads v1 by the declared range', () => {
    const lock = parseNpmLockfile('yarn.lock', `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"@babel/core@^7.0.0", "@babel/core@^7.1.0":
  version "7.1.0"
  resolved "https://registry.yarnpkg.com/@babel/core/-/core-7.1.0.tgz#abc"

express@^4.0.0:
  version "4.18.2"

"range@>=1.0.0 <2":
  version "1.5.0"
`);
    expect(lock.resolve('package.json', '@babel/core', '^7.1.0')).toBe('7.1.0');
    expect(lock.resolve('apps/web/package.json', 'express', '^4.0.0')).toBe('4.18.2');
    expect(lock.resolve('package.json', 'range', '>=1.0.0 <2')).toBe('1.5.0');
    expect(lock.resolve('package.json', 'express', '^5.0.0')).toBeUndefined();
    expect(lock.resolve('package.json', 'express', undefined)).toBeUndefined();
  });

  it('reads Berry, with CRLF line ends too', () => {
    const lock = parseNpmLockfile('yarn.lock', [
      '# This file is generated by running "yarn install"',
      '__metadata:',
      '  version: 8',
      '',
      '"@babel/core@npm:^7.0.0, @babel/core@npm:^7.1.0":',
      '  version: 7.1.0',
      '  resolution: "@babel/core@npm:7.1.0"',
      '',
      '"shared@workspace:packages/shared":',
      '  version: 0.0.0-use.local',
      '',
    ].join('\r\n'));
    expect(lock.resolve('package.json', '@babel/core', '^7.0.0')).toBe('7.1.0');
    expect(lock.resolve('package.json', '@babel/core', 'npm:^7.1.0')).toBe('7.1.0');
    expect(lock.resolve('package.json', 'shared', 'workspace:*')).toBeUndefined();
  });

  it('throws on a file that is not one', () => {
    expect(() => parseNpmLockfile('yarn.lock', 'hello\n')).toThrow();
  });
});
