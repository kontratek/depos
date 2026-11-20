import { describe, expect, it } from 'vitest';
import { isNugetLockfilePath, nugetLockfileFor, parseNugetLockfile } from '../../core/nuget-lockfile';

const lockfile = JSON.stringify({
  version: 2,
  dependencies: {
    'net8.0': {
      'Newtonsoft.Json': { type: 'Direct', requested: '[13.0.3, )', resolved: '13.0.3' },
      'Serilog': { type: 'Direct', requested: '[3.1.1, )', resolved: '3.1.1' },
      'Shared': { type: 'Project' },
      'System.Memory': { type: 'Transitive', resolved: '4.5.5' },
    },
    'net48': {
      'Newtonsoft.Json': { type: 'Direct', requested: '[13.0.3, )', resolved: '13.0.3' },
      'Serilog': { type: 'Direct', requested: '[2.12.0, )', resolved: '2.12.0' },
    },
  },
});

describe('NuGet lock files', () => {
  it('owns packages.lock.json only', () => {
    expect(isNugetLockfilePath('src/App/packages.lock.json')).toBe(true);
    expect(isNugetLockfilePath('src/App/package-lock.json')).toBe(false);
  });

  it('finds the lock file beside the project only', () => {
    const paths = new Set(['packages.lock.json', 'src/App/packages.lock.json']);
    expect(nugetLockfileFor('src/App/App.csproj', paths)).toBe('src/App/packages.lock.json');
    expect(nugetLockfileFor('src/Lib/Lib.csproj', paths)).toBeUndefined();
    expect(nugetLockfileFor('Directory.Packages.props', paths)).toBeUndefined();
  });

  it('resolves a package by its ID, whatever the case', () => {
    const parsed = parseNugetLockfile('packages.lock.json', lockfile);
    expect(parsed.resolve('App.csproj', 'newtonsoft.json', undefined)).toBe('13.0.3');
    expect(parsed.resolve('App.csproj', 'Newtonsoft.Json', '13.0.3')).toBe('13.0.3');
    expect(parsed.resolve('App.csproj', 'Shared', undefined)).toBeUndefined();
    expect(parsed.resolve('App.csproj', 'Missing', undefined)).toBeUndefined();
  });

  it('gives no version when target frameworks resolve different ones', () => {
    expect(parseNugetLockfile('packages.lock.json', lockfile).resolve('App.csproj', 'Serilog', undefined)).toBeUndefined();
  });

  it('throws on a file that is not a NuGet lock file', () => {
    expect(() => parseNugetLockfile('packages.lock.json', 'not json')).toThrow();
    expect(() => parseNugetLockfile('packages.lock.json', '{"lockfileVersion":3,"packages":{}}')).toThrow();
  });
});
