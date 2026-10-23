import { normalizeNameForEcosystem } from '../../core/match';
import type { ManifestKind } from '../../core/model';
import { isObject, LIMITS, list, lookupKey, str } from './json';

/**
 * The allowlist layer of one repository, as Depos sends it (docs/format.md, "The
 * organization layer"). No vscode import, so it is unit tested. Org notes have their
 * own module (orgNotes.ts).
 *
 * Depos decides every allowlist result. This module only looks a package up: a
 * governed ecosystem lists its decided packages, every other package of it is Not
 * listed, and an ecosystem that is not listed is not audited.
 */

export type PolicyMode = 'audit' | 'enforce';

export interface OrgDecision {
  noteKey: string;
  decision: 'allow' | 'deny';
  reason: string;
  expiresAt: string | null;
}

export interface OrgContextData {
  organization: { ulid: string; name: string };
  repository: { ulid: string; fullName: string };
  dependencyPagePath: string;
  policies: Array<{ ecosystem: string; mode: PolicyMode; decisions: OrgDecision[] }>;
}

export type OrgResult =
  | { kind: 'allowed' | 'denied'; mode: PolicyMode; reason: string; expiresAt: string | null }
  | { kind: 'unlisted'; mode: PolicyMode };

function decisionOf(v: unknown): OrgDecision | undefined {
  if (!isObject(v) || !str(v.noteKey) || !str(v.reason, LIMITS.text)) return undefined;
  if (v.decision !== 'allow' && v.decision !== 'deny') return undefined;
  if (v.expiresAt !== null && !str(v.expiresAt)) return undefined;
  return { noteKey: v.noteKey, decision: v.decision, reason: v.reason, expiresAt: v.expiresAt };
}

/** The answer of `GET /api/extension/repositories/<ulid>/context`, checked; undefined when it has another shape. */
export function parseOrgContext(json: unknown): OrgContextData | undefined {
  if (!isObject(json) || !isObject(json.organization) || !isObject(json.repository)) return undefined;
  const { organization, repository } = json;
  if (!str(organization.ulid) || !str(organization.name) || !str(repository.ulid) || !str(repository.fullName)) return undefined;
  if (!str(json.dependencyPagePath) || !json.dependencyPagePath.startsWith('/') || json.dependencyPagePath.startsWith('//')) return undefined;
  if (!list(json.policies)) return undefined;

  const policies: OrgContextData['policies'] = [];
  for (const p of json.policies) {
    if (!isObject(p) || !str(p.ecosystem) || (p.mode !== 'audit' && p.mode !== 'enforce') || !list(p.decisions)) return undefined;
    const decisions: OrgDecision[] = [];
    for (const d of p.decisions) {
      const decision = decisionOf(d);
      if (!decision) return undefined;
      decisions.push(decision);
    }
    policies.push({ ecosystem: p.ecosystem, mode: p.mode, decisions });
  }
  return {
    organization: { ulid: organization.ulid, name: organization.name },
    repository: { ulid: repository.ulid, fullName: repository.fullName },
    dependencyPagePath: json.dependencyPagePath,
    policies,
  };
}

/**
 * Lookups by ecosystem and key. Keys are normalized the same way Depos stores them
 * (normalizeNameForEcosystem), so a manifest name finds its entry.
 */
export class OrgLayer {
  private readonly modes = new Map<string, PolicyMode>();
  private readonly decisions = new Map<string, OrgDecision>();

  constructor(readonly data: OrgContextData) {
    for (const p of data.policies) {
      this.modes.set(p.ecosystem, p.mode);
      for (const d of p.decisions) this.decisions.set(lookupKey(p.ecosystem, d.noteKey), d);
    }
  }

  /**
   * undefined: the ecosystem is not audited, nothing is shown. A decision that has
   * expired since the copy was received reads as Not listed: Depos no longer counts it.
   */
  result(ecosystem: ManifestKind, name: string, now: number = Date.now()): OrgResult | undefined {
    const mode = this.modes.get(ecosystem);
    if (!mode) return undefined;
    const d = this.decisions.get(lookupKey(ecosystem, normalizeNameForEcosystem(name, ecosystem)));
    if (!d || (d.expiresAt !== null && Date.parse(d.expiresAt) <= now)) return { kind: 'unlisted', mode };
    return { kind: d.decision === 'deny' ? 'denied' : 'allowed', mode, reason: d.reason, expiresAt: d.expiresAt };
  }

  /** Path of the package's page in Depos, below the server origin. */
  dependencyPath(ecosystem: ManifestKind, name: string): string {
    return dependencyPagePath(this.data.dependencyPagePath, ecosystem, name);
  }
}

/** `<base>/<ecosystem>/<key>`; `@scope/pkg` and Go module paths keep their slashes (a catch-all route). */
export function dependencyPagePath(base: string, ecosystem: ManifestKind, name: string): string {
  const key = normalizeNameForEcosystem(name, ecosystem);
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `${base}/${encodeURIComponent(ecosystem)}/${encoded}`;
}

/** A violation is shown at the manifest line: Denied or Not listed. */
export function isViolation(result: OrgResult | undefined): boolean {
  return result?.kind === 'denied' || result?.kind === 'unlisted';
}
