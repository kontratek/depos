import { describe, expect, it } from 'vitest';
import { OrgLayer, isViolation, parseOrgContext, type OrgContextData } from '../../ext/web/orgLayer';
import { orgView } from '../../ext/web/orgView';

/** The allowlist layer (docs/format.md, "The organization layer"): the server's answer, checked, and looked up. */

function answer(overrides: Partial<OrgContextData> = {}): OrgContextData {
  return {
    organization: { ulid: 'O'.repeat(26), name: 'Acme' },
    repository: { ulid: 'R'.repeat(26), fullName: 'acme/api' },
    dependencyPagePath: `/dashboard/${'O'.repeat(26)}/dependencies`,
    policies: [
      {
        ecosystem: 'npm',
        mode: 'enforce',
        decisions: [
          { noteKey: 'express', decision: 'allow', reason: 'Baseline: in use', expiresAt: '2099-01-01T00:00:00.000Z' },
          { noteKey: 'left-pad', decision: 'deny', reason: 'Unmaintained', expiresAt: null },
          { noteKey: '@scope/pkg', decision: 'allow', reason: '', expiresAt: null },
        ],
      },
      { ecosystem: 'python', mode: 'audit', decisions: [{ noteKey: 'django-rest', decision: 'allow', reason: '', expiresAt: null }] },
    ],
    ...overrides,
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
      { ...answer(), policies: [{ ecosystem: 'npm', mode: 'audit', decisions: [{ noteKey: 'a', decision: 'maybe', reason: '', expiresAt: null }] }] },
      { ...answer(), policies: [{ ecosystem: 'npm', mode: 'audit', decisions: [{ noteKey: 'a', decision: 'deny', reason: 'x'.repeat(100_001), expiresAt: null }] }] },
    ];
    for (const value of bad) expect(parseOrgContext(value)).toBeUndefined();
  });

  it('ignores extra keys and keeps only what it knows', () => {
    const parsed = parseOrgContext({ ...answer(), id: 42, orgNotes: [], organization: { ...answer().organization, id: 1 } });
    expect(parsed).toEqual(answer());
  });
});

describe('OrgLayer', () => {
  const layer = new OrgLayer(answer());

  it('finds the decided result of a package in a governed ecosystem', () => {
    expect(layer.result('npm', 'express')).toEqual({ kind: 'allowed', mode: 'enforce', reason: 'Baseline: in use', expiresAt: '2099-01-01T00:00:00.000Z' });
    expect(layer.result('npm', 'left-pad')).toEqual({ kind: 'denied', mode: 'enforce', reason: 'Unmaintained', expiresAt: null });
  });

  it('treats any other package of a governed ecosystem as Not listed', () => {
    expect(layer.result('npm', 'lodash')).toEqual({ kind: 'unlisted', mode: 'enforce' });
    expect(isViolation(layer.result('npm', 'lodash'))).toBe(true);
  });

  it('reads a decision that has expired since the copy was received as Not listed', () => {
    const after = Date.parse('2099-01-01T00:00:00.000Z');
    expect(layer.result('npm', 'express', after - 1)?.kind).toBe('allowed');
    expect(layer.result('npm', 'express', after)).toEqual({ kind: 'unlisted', mode: 'enforce' });
    expect(layer.result('npm', 'left-pad', after)?.kind).toBe('denied');
  });

  it('shows nothing for an ecosystem that is not audited', () => {
    expect(layer.result('cargo', 'serde')).toBeUndefined();
    expect(isViolation(layer.result('cargo', 'serde'))).toBe(false);
  });

  it('matches names the way Depos stores them', () => {
    expect(layer.result('npm', 'Express')?.kind).toBe('allowed');
    expect(layer.result('python', 'Django_Rest')?.kind).toBe('allowed');
  });

  it('keeps the slashes of a scoped name in the page path', () => {
    expect(layer.dependencyPath('npm', '@scope/pkg')).toBe(`/dashboard/${'O'.repeat(26)}/dependencies/npm/%40scope/pkg`);
  });
});

describe('orgView', () => {
  const org = { layer: new OrgLayer(answer()), origin: 'https://depos.example.com', receivedAt: 0 };
  const time = () => '10:00';

  it('describes the allowlist result, with a link to the package page', () => {
    expect(orgView(org, 'npm', 'express', time)).toEqual({
      allowlist: { tone: 'allowed', result: 'Allowed', mode: 'Enforce', reason: 'Baseline: in use', expires: '2099-01-01' },
      link: `https://depos.example.com/dashboard/${'O'.repeat(26)}/dependencies/npm/express`,
      received: 'Updated from Depos at 10:00',
    });
  });

  it('shows Not listed without a reason', () => {
    expect(orgView(org, 'npm', 'lodash', time)?.allowlist).toEqual({ tone: 'unlisted', result: 'Not listed', mode: 'Enforce' });
  });

  it('is undefined when the ecosystem is not audited', () => {
    expect(orgView(org, 'cargo', 'serde', time)).toBeUndefined();
  });
});
