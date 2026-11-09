import type { ManifestKind } from '../../core/model';
import { S } from '../strings';
import type { OrgLayer } from './orgLayer';

/** What the hover and the note panel show from Depos for one package. */
export interface OrgView {
  /** Undefined when the package's ecosystem is not audited. */
  allowlist?: {
    tone: 'allowed' | 'denied' | 'unlisted';
    /** "Allowed", "Denied" or "Not listed". */
    result: string;
    mode: string;
  };
  /** The installed and newest version at Depos's last scan, when Depos knows one. */
  version?: string;
  /** Allowed, but further behind than the version rule allows. */
  outdated?: boolean;
  risk?: string;
  /** "High", "Medium", "Low" or "Unknown", for the note panel's badge. */
  riskLevel?: string;
  /** The package's page in Depos. */
  link: string;
  received: string;
}

const RESULT_TEXT = { allowed: S.orgResultAllowed, denied: S.orgResultDenied, unlisted: S.orgResultUnlisted } as const;

/** Undefined when Depos has nothing for the package: its ecosystem is not audited and it has no version or risk. */
export function orgView(
  org: { layer: OrgLayer; origin: string; receivedAt: number },
  kind: ManifestKind,
  name: string,
  formatTime: (ms: number) => string,
): OrgView | undefined {
  const result = org.layer.result(kind, name);
  const version = org.layer.version(kind, name);
  if (!result && !version) return undefined;
  const view: OrgView = {
    link: `${org.origin}${org.layer.dependencyPath(kind, name)}`,
    received: S.orgReceived(formatTime(org.receivedAt)),
  };
  if (result) {
    view.allowlist = {
      tone: result.kind,
      result: RESULT_TEXT[result.kind],
      mode: result.mode === 'enforce' ? S.orgModeEnforce : S.orgModeAudit,
    };
  }
  if (version) {
    const line = S.orgVersionLine(version.installedVersion, version.latestVersion, version.updateKind ? S.orgBehind[version.updateKind] : undefined);
    if (line) view.version = line;
    if (org.layer.isOutdated(kind, name)) view.outdated = true;
    if (version.risk) {
      view.riskLevel = S.orgRiskLevel[version.risk.level] ?? version.risk.level;
      view.risk = S.orgRiskLine(view.riskLevel, version.risk.version);
    }
  }
  return view;
}

/** The badge beside the package name in the note panel; set as text, never as HTML. */
export interface OrgPayload {
  /** allowed is green, denied red, unlisted and outdated yellow, neutral the plain badge. */
  tone: 'allowed' | 'denied' | 'unlisted' | 'outdated' | 'neutral';
  text: string;
  /** The badge's tooltip: the hover's lines without the time. */
  detail: string;
  openWeb: string;
}

/**
 * The allowlist result, or Outdated when an Allowed package breaks the version rule.
 * In an ecosystem that is not audited, the risk level, or just "Depos".
 */
export function orgPayloadOf(view: OrgView): OrgPayload {
  const level = view.riskLevel;
  const [tone, text]: [OrgPayload['tone'], string] = view.outdated
    ? ['outdated', S.orgResultOutdated]
    : view.allowlist
      ? [view.allowlist.tone, view.allowlist.result]
      : ['neutral', level ? S.orgRiskBadge(level) : S.orgBadgeDepos];
  return { tone, text, detail: orgLines(view, false).join('\n'), openWeb: S.orgOpenWeb };
}

/** The lines the hover shows, in order. The note panel's badge tooltip is the same, without the time. */
export function orgLines(view: OrgView, withTime = true): string[] {
  return [
    view.allowlist && S.orgAllowlistLine(view.allowlist.result, view.allowlist.mode),
    view.outdated && view.allowlist && S.orgOutdatedLine(view.allowlist.mode),
    view.version,
    view.risk,
    withTime && view.received,
  ].filter((line): line is string => typeof line === 'string' && line !== '');
}
