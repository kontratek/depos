import { describe, expect, it } from 'vitest';
import { depAtOffset, extractDeps } from '../../core/packageJson';

const pkg = JSON.stringify(
  {
    name: 'fixture',
    dependencies: { express: '^4.18.0', '@scope/util': 'workspace:*' },
    devDependencies: { vitest: 'npm:vitest@^4' },
    peerDependencies: { react: '>=18' },
    optionalDependencies: { fsevents: '^2' },
    scripts: { express: 'echo not-a-dep' },
  },
  null,
  2,
);

describe('extractDeps', () => {
  it('keeps the version as written, and none when it is not a string', () => {
    const deps = extractDeps('{"dependencies":{"express":"^4.18.0","odd":1,"alias":"npm:real@^2"}}');
    expect(deps.map((d) => [d.name, d.versionSpec])).toEqual([
      ['express', '^4.18.0'],
      ['odd', undefined],
      ['alias', 'npm:real@^2'],
    ]);
  });

  it('collects all four dependency sections, not scripts', () => {
    const deps = extractDeps(pkg);
    expect(deps.map((d) => `${d.section}:${d.name}`).sort()).toEqual(
      [
        'dependencies:@scope/util',
        'dependencies:express',
        'devDependencies:vitest',
        'optionalDependencies:fsevents',
        'peerDependencies:react',
      ].sort(),
    );
  });

  it('key offsets point at the quoted key', () => {
    const deps = extractDeps(pkg);
    const express = deps.find((d) => d.name === 'express')!;
    expect(pkg.slice(express.keyOffset, express.keyOffset + express.keyLength)).toBe('"express"');
    expect(express.iconRange).toEqual(express.primaryRange);
  });

  it('depAtOffset hits within the key range only', () => {
    const deps = extractDeps(pkg);
    const express = deps.find((d) => d.name === 'express')!;
    expect(depAtOffset(deps, express.keyOffset + 1)?.name).toBe('express');
    expect(depAtOffset(deps, express.keyOffset + express.keyLength + 5)).toBeUndefined();
  });

  it('tolerates jsonc comments and trailing commas', () => {
    const jsonc = '{\n  // comment\n  "dependencies": {\n    "a": "1",\n  },\n}';
    expect(extractDeps(jsonc).map((d) => d.name)).toEqual(['a']);
  });

  it('returns empty for invalid or non-object json', () => {
    expect(extractDeps('')).toEqual([]);
    expect(extractDeps('[]')).toEqual([]);
  });
});
