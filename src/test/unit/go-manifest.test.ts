import { describe, expect, it } from 'vitest';
import { dependencyAtOffset, manifestAdapterForPath } from '../../core/manifest';
import { extractGoDependencies, goPinnedVersion } from '../../core/go-manifest';

describe('Go manifest matching', () => {
  it('matches go.mod only', () => {
    expect(manifestAdapterForPath('/repo/go.mod')?.kind).toBe('go');
    expect(manifestAdapterForPath('/repo/go.sum')).toBeUndefined();
    expect(manifestAdapterForPath('/repo/go.work')).toBeUndefined();
  });
});

describe('go.mod dependencies', () => {
  const goMod = `module example.com/app // the app

go 1.24

toolchain go1.24.2

require github.com/spf13/cobra v1.8.1

require (
\tgithub.com/jackc/pgx/v5 v5.7.1
\tgolang.org/x/tools v0.28.0 // indirect
\t"github.com/Quoted/Mod" v1.0.0 // indirect; kept for tests
\tgithub.com/not/indirect v1.0.0 // indirectly used
\tgithub.com/spf13/cobra v1.9.0
)

require ()

tool golang.org/x/tools/cmd/stringer

tool (
\tgithub.com/golangci/golangci-lint/cmd/golangci-lint
\tgolang.org/x/tools/cmd/goimports
)

replace github.com/replaced/mod => ../local
exclude github.com/excluded/mod v1.0.0
retract v1.0.0
godebug default=go1.21
// require github.com/commented/out v1.0.0
`;
  const deps = extractGoDependencies(goMod);

  it('reads single-line and block requires, first wins on duplicates', () => {
    expect(deps.map((dep) => [dep.noteKey, dep.scope])).toEqual([
      ['github.com/spf13/cobra', 'require'],
      ['github.com/jackc/pgx/v5', 'require'],
      ['golang.org/x/tools', 'indirect'],
      ['github.com/Quoted/Mod', 'indirect'],
      ['github.com/not/indirect', 'require'],
      ['github.com/golangci/golangci-lint/cmd/golangci-lint', 'tool'],
    ]);
  });

  it('points ranges at the module path, without quotes', () => {
    for (const dep of deps) {
      const { offset, length } = dep.primaryRange;
      expect(goMod.slice(offset, offset + length)).toBe(dep.noteKey);
    }
  });

  it('attaches tools to the module that contains them', () => {
    const tools = deps.find((dep) => dep.noteKey === 'golang.org/x/tools')!;
    expect(tools.sourceRanges).toHaveLength(3);
    const stringer = goMod.indexOf('golang.org/x/tools/cmd/stringer');
    expect(dependencyAtOffset(deps, stringer + 3)?.noteKey).toBe('golang.org/x/tools');
  });

  it('reads CRLF files', () => {
    const crlf = extractGoDependencies('module m\r\n\r\nrequire (\r\n\tgithub.com/a/b v1.0.0 // indirect\r\n)\r\n');
    expect(crlf.map((dep) => [dep.noteKey, dep.scope])).toEqual([['github.com/a/b', 'indirect']]);
  });

  it('returns nothing for a go.mod without requirements', () => {
    expect(extractGoDependencies('module m\n\ngo 1.22\n')).toEqual([]);
  });
});

describe('go.mod versions', () => {
  const goMod = `module example.com/app

go 1.23

require (
	github.com/gin-gonic/gin v1.9.1
	golang.org/x/text v0.14.0 // indirect
	example.com/local v1.0.0
	example.com/forked v1.2.0
	example.com/bumped v1.0.0
	example.com/only-old v1.0.0
	example.com/pseudo v0.0.0-20240101000000-abcdef123456
	example.com/legacy v2.0.0+incompatible
)

require github.com/spf13/cobra v1.8.0

replace example.com/local => ../local

replace (
	example.com/forked => github.com/me/forked v1.2.1
	example.com/bumped => example.com/bumped v1.0.1
	example.com/only-old v0.9.0 => ../never
)
`;

  it('gives each requirement its version, after replace', () => {
    expect(Object.fromEntries(extractGoDependencies(goMod).map((d) => [d.noteKey, d.versionSpec]))).toEqual({
      'github.com/gin-gonic/gin': 'v1.9.1',
      'golang.org/x/text': 'v0.14.0',
      'example.com/local': 'file:../local',
      'example.com/forked': 'package:github.com/me/forked@v1.2.1',
      'example.com/bumped': 'v1.0.1',
      'example.com/only-old': 'v1.0.0',
      'example.com/pseudo': 'v0.0.0-20240101000000-abcdef123456',
      'example.com/legacy': 'v2.0.0+incompatible',
      'github.com/spf13/cobra': 'v1.8.0',
    });
  });

  it('gives a standalone tool no version', () => {
    const [tool] = extractGoDependencies('module m\n\ntool golang.org/x/tools/cmd/stringer\n');
    expect(tool?.versionSpec).toBeUndefined();
  });

  it('a replacement for one version wins over one for every version', () => {
    const text = 'module m\nrequire a.com/x v1.0.0\nreplace a.com/x => ../all\nreplace a.com/x v1.0.0 => a.com/x v1.0.5\n';
    expect(extractGoDependencies(text)[0]?.versionSpec).toBe('v1.0.5');
  });
});

describe('goPinnedVersion', () => {
  it('installs a release or pseudo-version as written', () => {
    expect(goPinnedVersion('v1.9.1')).toBe('v1.9.1');
    expect(goPinnedVersion('v2.0.0+incompatible')).toBe('v2.0.0+incompatible');
    expect(goPinnedVersion('v0.0.0-20240101000000-abcdef123456')).toBe('v0.0.0-20240101000000-abcdef123456');
    expect(goPinnedVersion('v1.0.0-rc.1')).toBe('v1.0.0-rc.1');
  });

  it('reads nothing else as a release', () => {
    for (const spec of [undefined, '', '1.9.1', 'v1.9', 'file:../local', 'package:github.com/me/forked@v1.2.1', 'latest']) {
      expect(goPinnedVersion(spec), String(spec)).toBeUndefined();
    }
  });
});
