import { describe, expect, it } from 'vitest';
import { OrgLayer, isViolation, parseOrgContext, type OrgContextData, type OrgPackageVersion } from '../../ext/web/orgLayer';
import { orgLines, orgPayloadOf, orgView } from '../../ext/web/orgView';

/** The allowlist layer (docs/format.md, "The organization layer"): the server's answer, checked, and looked up. */

function version(noteKey: string, over: Partial<OrgPackageVersion> = {}): OrgPackageVersion {
  return { ecosystem: 'npm', noteKey, installedVersion: '1.0.0', latestVersion: '1.0.0', updateKind: 'current', outdated: false, deniedVersion: false, vulnerable: false, risk: null, ...over };
}

function answer(overrides: Partial<OrgContextData> = {}): OrgContextData {
  return {
    organization: { ulid: 'O'.repeat(26), name: 'Acme' },
    repository: { ulid: 'R'.repeat(26), fullName: 'acme/api' },
    dependencyPagePath: `/dashboard/${'O'.repeat(26)}/dependencies`,
    policies: [
      {
        ecosystem: 'npm',
        mode: 'enforce',
        versionRule: 'major',
        decisions: [
          { noteKey: 'express', decision: 'allow' },
          { noteKey: 'left-pad', decision: 'deny' },
          { noteKey: '@scope/pkg', decision: 'allow' },
        ],
      },
      { ecosystem: 'python', mode: 'audit', versionRule: 'off', decisions: [{ noteKey: 'django-rest', decision: 'allow' }] },
    ],
    packages: [
      version('express', { installedVersion: '4.18.2', latestVersion: '5.1.0', updateKind: 'major', outdated: true, risk: { level: 'medium', version: '4.18.2' } }),
      version('left-pad', { installedVersion: '1.0.0', latestVersion: '2.0.0', updateKind: 'major', outdated: true }),
      version('@scope/pkg', { installedVersion: '2.1.0', latestVersion: '2.3.0', updateKind: 'minor' }),
    ],
    ...overrides,
  };
}

/** What a Depos before the version rule answers, with the empty reason and expiry it sent then. */
function oldAnswer(): unknown {
  const old = answer();
  delete old.packages;
  return {
    ...old,
    policies: old.policies.map((p) => {
      const policy = { ...p, decisions: p.decisions.map((d) => ({ ...d, reason: '', expiresAt: null })) };
      delete policy.versionRule;
      return policy;
    }),
  };
}

describe('parseOrgContext', () => {
  it('accepts the answer of Depos', () => {
    const data = answer();
    expect(parseOrgContext(JSON.parse(JSON.stringify(data)))).toEqual(data);
  });

  it('rejects any other shape', () => {
    const bad: unknown[] = [
      null,
      [],
      'text',
      { ...answer(), organization: null },
      { ...answer(), dependencyPagePath: 'https://evil.example/x' },
      { ...answer(), dependencyPagePath: '//evil.example/x' },
      { ...answer(), policies: [{ ecosystem: 'npm', mode: 'block', decisions: [] }] },
      { ...answer(), policies: [{ ecosystem: 'npm', mode: 'audit', decisions: [{ noteKey: 'a', decision: 'maybe' }] }] },
      { ...answer(), policies: [{ ecosystem: 'npm', mode: 'audit', decisions: [{ noteKey: 'x'.repeat(1_001), decision: 'deny' }] }] },
    ];
    for (const value of bad) expect(parseOrgContext(value)).toBeUndefined();
  });

  it('ignores extra keys and keeps only what it knows', () => {
    const parsed = parseOrgContext({ ...answer(), id: 42, orgNotes: [], organization: { ...answer().organization, id: 1 } });
    expect(parsed).toEqual(answer());
  });

  it('reads an older Depos: no version rule, no versions, an empty reason and expiry', () => {
    const parsed = parseOrgContext(oldAnswer());
    expect(parsed?.policies.map((p) => [p.ecosystem, p.versionRule, p.decisions.length])).toEqual([['npm', 'off', 3], ['python', 'off', 1]]);
    expect(parsed?.packages).toEqual([]);
  });

  it('keeps the allowlist when a version entry or value is not understood', () => {
    const parsed = parseOrgContext({
      ...answer(),
      policies: [{ ...answer().policies[0]!, versionRule: 'minor-only' }],
      packages: [
        { ...version('express'), installedVersion: 42 },
        { ...version('zod'), updateKind: 'sideways', deniedVersion: 'yes', vulnerable: 1, risk: { level: 'severe', version: '1.0.0' } },
        null,
      ],
    });
    expect(parsed?.policies[0]?.versionRule).toBe('off');
    expect(parsed?.packages).toEqual([version('zod', { updateKind: null })]);
  });

  it('reads a Depos before denied versions and vulnerabilities as neither', () => {
    const before: Partial<OrgPackageVersion> = version('zod');
    delete before.deniedVersion;
    delete before.vulnerable;
    expect(parseOrgContext({ ...answer(), packages: [before] })?.packages).toEqual([version('zod')]);
  });
});

describe('OrgLayer', () => {
  const layer = new OrgLayer(answer());

  it('finds the decided result of a package in a governed ecosystem', () => {
    expect(layer.result('npm', 'express')).toEqual({ kind: 'allowed', mode: 'enforce' });
    expect(layer.result('npm', 'left-pad')).toEqual({ kind: 'denied', mode: 'enforce' });
  });

  it('treats any other package of a governed ecosystem as Not listed', () => {
    expect(layer.result('npm', 'lodash')).toEqual({ kind: 'unlisted', mode: 'enforce' });
    expect(isViolation(layer.result('npm', 'lodash'))).toBe(true);
  });

  it('shows nothing for an ecosystem that is not audited', () => {
    expect(layer.result('cargo', 'serde')).toBeUndefined();
    expect(isViolation(layer.result('cargo', 'serde'))).toBe(false);
  });

  it('matches names the way Depos stores them', () => {
    expect(layer.result('npm', 'Express')?.kind).toBe('allowed');
    expect(layer.result('python', 'Django_Rest')?.kind).toBe('allowed');
    expect(layer.version('npm', 'Express')?.installedVersion).toBe('4.18.2');
  });

  it('keeps the slashes of a scoped name in the page path', () => {
    expect(layer.dependencyPath('npm', '@scope/pkg')).toBe(`/dashboard/${'O'.repeat(26)}/dependencies/npm/%40scope/pkg`);
  });

  it('marks an Allowed package that breaks the version rule, and a Denied one only for being denied', () => {
    expect(layer.versionViolation('npm', 'express')).toBe('outdated');
    expect(layer.versionViolation('npm', 'left-pad')).toBeUndefined();
    expect(layer.versionViolation('npm', '@scope/pkg')).toBeUndefined();
    expect(layer.versionViolation('npm', 'lodash')).toBeUndefined();
  });

  it('names a denied version first, then a vulnerable one, then the version rule', () => {
    const marked = new OrgLayer(answer({
      packages: [
        version('express', { outdated: true, vulnerable: true, deniedVersion: true }),
        version('@scope/pkg', { outdated: true, vulnerable: true }),
        version('left-pad', { deniedVersion: true }),
      ],
    }));
    expect(marked.versionViolation('npm', 'express')).toBe('deniedVersion');
    expect(marked.versionViolation('npm', '@scope/pkg')).toBe('vulnerable');
    // Denied: marked for that, once.
    expect(marked.versionViolation('npm', 'left-pad')).toBeUndefined();
  });

  it('reads a copy saved before the version rule', () => {
    const saved = answer();
    delete saved.packages;
    const old = new OrgLayer(saved);
    expect(old.version('npm', 'express')).toBeUndefined();
    expect(old.versionViolation('npm', 'express')).toBeUndefined();
    expect(old.result('npm', 'express')?.kind).toBe('allowed');
  });
});

describe('orgView', () => {
  const org = { layer: new OrgLayer(answer()), origin: 'https://depos.example.com', receivedAt: 0 };
  const time = () => '10:00';

  it('describes the allowlist result, with a link to the package page', () => {
    expect(orgView(org, 'npm', '@scope/pkg', time)).toEqual({
      allowlist: { tone: 'allowed', result: 'Allowed', mode: 'Enforce' },
      version: 'Installed at last scan: 2.1.0 · Latest: 2.3.0 (a minor version behind)',
      link: `https://depos.example.com/dashboard/${'O'.repeat(26)}/dependencies/npm/%40scope/pkg`,
      received: 'Updated from Depos at 10:00',
    });
  });

  it('shows Not listed', () => {
    expect(orgView(org, 'npm', 'lodash', time)?.allowlist).toEqual({ tone: 'unlisted', result: 'Not listed', mode: 'Enforce' });
  });

  it('says when the version rule is not met, with the versions and the risk', () => {
    const view = orgView(org, 'npm', 'express', time)!;
    expect(orgLines(view)).toEqual([
      'Allowlist: Allowed (Enforce)',
      'Version rule: not met (Enforce)',
      'Installed at last scan: 4.18.2 · Latest: 5.1.0 (a major version behind)',
      'Risk: Medium (4.18.2)',
      'Updated from Depos at 10:00',
    ]);
    expect(orgPayloadOf(view)).toEqual({
      tone: 'outdated',
      text: 'Outdated',
      detail: 'Allowlist: Allowed (Enforce)\nVersion rule: not met (Enforce)\nInstalled at last scan: 4.18.2 · Latest: 5.1.0 (a major version behind)\nRisk: Medium (4.18.2)',
      openWeb: 'Open in Depos',
    });
  });

  it('says when the installed version is denied or vulnerable, in red', () => {
    const layer = new OrgLayer(answer({ packages: [version('express', { vulnerable: true }), version('@scope/pkg', { deniedVersion: true })] }));
    const vulnerable = orgView({ ...org, layer }, 'npm', 'express', time)!;
    expect(orgLines(vulnerable, false)).toEqual([
      'Allowlist: Allowed (Enforce)',
      'Installed version: known critical or high vulnerability (Enforce)',
      'Installed at last scan: 1.0.0 · Latest: 1.0.0',
    ]);
    expect(orgPayloadOf(vulnerable)).toMatchObject({ tone: 'denied', text: 'Vulnerable' });
    expect(orgPayloadOf(orgView({ ...org, layer }, 'npm', '@scope/pkg', time)!)).toMatchObject({ tone: 'denied', text: 'Denied version' });
  });

  it('shows versions and risk in an ecosystem that is not audited', () => {
    const layer = new OrgLayer(answer({ policies: [], packages: [version('express', { risk: { level: 'high', version: '1.0.0' } })] }));
    const view = orgView({ ...org, layer }, 'npm', 'express', time)!;
    expect(view.allowlist).toBeUndefined();
    expect(orgPayloadOf(view)).toMatchObject({ tone: 'neutral', text: 'High risk' });
    expect(orgLines(view, false)).toEqual(['Installed at last scan: 1.0.0 · Latest: 1.0.0', 'Risk: High (1.0.0)']);
  });

  it('is undefined when the ecosystem is not audited and Depos knows no version', () => {
    expect(orgView(org, 'cargo', 'serde', time)).toBeUndefined();
  });
});
