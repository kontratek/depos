import { normalizeNameForEcosystem } from '../../core/match';
import type { ManifestKind } from '../../core/model';
import { isObject, list, lookupKey, str } from './json';

/**
 * The allowlist layer of one repository, as Depos sends it (docs/format.md, "The
 * organization layer"). No vscode import, so it is unit tested. Org notes have their
 * own module (orgNotes.ts).
 *
 * Depos decides every allowlist result. This module only looks a package up: a
 * governed ecosystem lists its decided packages, every other package of it is Not
 * listed, and an ecosystem that is not listed is not audited. The same goes for the
 * rules on the installed version (the version rule, denied versions, vulnerabilities):
 * Depos says which packages break them, on the versions of its last scan.
 */

export type PolicyMode = 'audit' | 'enforce';
export type VersionRule = 'off' | 'major' | 'any';
export type UpdateKind = 'current' | 'patch' | 'minor' | 'major' | 'ahead';
export type RiskLevel = 'high' | 'medium' | 'low' | 'unknown';
/** What an Allowed package's installed version breaks, the worst first. */
export type VersionViolation = 'deniedVersion' | 'vulnerable' | 'outdated';

export interface OrgDecision {
  noteKey: string;
  decision: 'allow' | 'deny';
}

/** How a package of the repository stands against its newest version, at Depos's last scan. */
export interface OrgPackageVersion {
  ecosystem: string;
  noteKey: string;
  installedVersion: string | null;
  latestVersion: string | null;
  /** null when the two cannot be compared. */
  updateKind: UpdateKind | null;
  /** Behind further than the version rule allows: a violation. */
  outdated: boolean;
  /** The version installed is one its Allow entry denies. False from a Depos before 0.13. */
  deniedVersion: boolean;
  /** The version installed has a known critical or high vulnerability, under the vulnerability rule. False from a Depos before 0.13. */
  vulnerable: boolean;
  risk: { level: RiskLevel; version: string } | null;
}

export interface OrgContextData {
  organization: { ulid: string; name: string };
  repository: { ulid: string; fullName: string };
  dependencyPagePath: string;
  /** `versionRule` and `packages` are missing from a copy saved before 0.12, and from an older Depos. */
  policies: Array<{ ecosystem: string; mode: PolicyMode; versionRule?: VersionRule; decisions: OrgDecision[] }>;
  packages?: OrgPackageVersion[];
}

export interface OrgResult {
  kind: 'allowed' | 'denied' | 'unlisted';
  mode: PolicyMode;
}

const VERSION_RULES: readonly string[] = ['off', 'major', 'any'];
const UPDATE_KINDS: readonly string[] = ['current', 'patch', 'minor', 'major', 'ahead'];
const RISK_LEVELS: readonly string[] = ['high', 'medium', 'low', 'unknown'];

/**
 * Decisions have no reason or expiry any more. Depos still sends empty ones for
 * older releases; they are not read, and an answer without them is accepted.
 */
function decisionOf(v: unknown): OrgDecision | undefined {
  if (!isObject(v) || !str(v.noteKey)) return undefined;
  if (v.decision !== 'allow' && v.decision !== 'deny') return undefined;
  return { noteKey: v.noteKey, decision: v.decision };
}

const optionalText = (v: unknown): string | null | undefined => (v === null || v === undefined ? null : str(v) ? v : undefined);

/** One package's versions; undefined when it has another shape. A value it does not know reads as unknown. */
function packageVersionOf(v: unknown): OrgPackageVersion | undefined {
  if (!isObject(v) || !str(v.ecosystem) || !str(v.noteKey)) return undefined;
  const installedVersion = optionalText(v.installedVersion);
  const latestVersion = optionalText(v.latestVersion);
  if (installedVersion === undefined || latestVersion === undefined) return undefined;
  const updateKind = typeof v.updateKind === 'string' && UPDATE_KINDS.includes(v.updateKind) ? (v.updateKind as UpdateKind) : null;
  const risk = isObject(v.risk) && str(v.risk.version) && typeof v.risk.level === 'string' && RISK_LEVELS.includes(v.risk.level)
    ? { level: v.risk.level as RiskLevel, version: v.risk.version }
    : null;
  return {
    ecosystem: v.ecosystem,
    noteKey: v.noteKey,
    installedVersion,
    latestVersion,
    updateKind,
    outdated: v.outdated === true,
    deniedVersion: v.deniedVersion === true,
    vulnerable: v.vulnerable === true,
    risk,
  };
}

/**
 * The answer of `GET /api/extension/repositories/<ulid>/context`, checked; undefined when it has another shape.
 * The version rule and the versions came later: without them, or with a value this version does not know, the
 * allowlist still shows. A package entry of another shape is left out on its own.
 */
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
    const versionRule = typeof p.versionRule === 'string' && VERSION_RULES.includes(p.versionRule) ? (p.versionRule as VersionRule) : 'off';
    policies.push({ ecosystem: p.ecosystem, mode: p.mode, versionRule, decisions });
  }
  const packages: OrgPackageVersion[] = [];
  for (const raw of list(json.packages) ? json.packages : []) {
    const pkg = packageVersionOf(raw);
    if (pkg) packages.push(pkg);
  }
  return {
    organization: { ulid: organization.ulid, name: organization.name },
    repository: { ulid: repository.ulid, fullName: repository.fullName },
    dependencyPagePath: json.dependencyPagePath,
    policies,
    packages,
  };
}

/**
 * Lookups by ecosystem and key. Keys are normalized the same way Depos stores them
 * (normalizeNameForEcosystem), so a manifest name finds its entry.
 */
export class OrgLayer {
  private readonly modes = new Map<string, PolicyMode>();
  private readonly decisions = new Map<string, OrgDecision>();
  private readonly versions = new Map<string, OrgPackageVersion>();

  constructor(readonly data: OrgContextData) {
    for (const p of data.policies) {
      this.modes.set(p.ecosystem, p.mode);
      for (const d of p.decisions) this.decisions.set(lookupKey(p.ecosystem, d.noteKey), d);
    }
    for (const v of data.packages ?? []) this.versions.set(lookupKey(v.ecosystem, v.noteKey), v);
  }

  /** undefined: the ecosystem is not audited, nothing is shown. */
  result(ecosystem: ManifestKind, name: string): OrgResult | undefined {
    const mode = this.modes.get(ecosystem);
    if (!mode) return undefined;
    const d = this.decisions.get(lookupKey(ecosystem, normalizeNameForEcosystem(name, ecosystem)));
    if (!d) return { kind: 'unlisted', mode };
    return { kind: d.decision === 'deny' ? 'denied' : 'allowed', mode };
  }

  /** The package's versions and risk at Depos's last scan; undefined when Depos knows none. */
  version(ecosystem: ManifestKind, name: string): OrgPackageVersion | undefined {
    return this.versions.get(lookupKey(ecosystem, normalizeNameForEcosystem(name, ecosystem)));
  }

  /**
   * What an Allowed package's installed version breaks, marked at its line: a denied
   * version first, then a vulnerable one, then the version rule. A Denied or Not
   * listed package is marked for that, once, as Depos counts it.
   */
  versionViolation(ecosystem: ManifestKind, name: string): VersionViolation | undefined {
    if (this.result(ecosystem, name)?.kind !== 'allowed') return undefined;
    const version = this.version(ecosystem, name);
    if (version?.deniedVersion) return 'deniedVersion';
    if (version?.vulnerable) return 'vulnerable';
    return version?.outdated ? 'outdated' : undefined;
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
