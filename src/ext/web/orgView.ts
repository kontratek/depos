import type { ManifestKind } from '../../core/model';
import { S } from '../strings';
import type { OrgLayer } from './orgLayer';

/** What the hover and the note panel show of the allowlist for one package. */
export interface OrgView {
  allowlist: {
    tone: 'allowed' | 'denied' | 'unlisted';
    /** "Allowed", "Denied" or "Not listed". */
    result: string;
    mode: string;
    reason?: string;
    expires?: string;
  };
  /** The package's page in Depos. */
  link: string;
  received: string;
}

const RESULT_TEXT = { allowed: S.orgResultAllowed, denied: S.orgResultDenied, unlisted: S.orgResultUnlisted } as const;

/** Undefined when the package's ecosystem is not audited. */
export function orgView(
  org: { layer: OrgLayer; origin: string; receivedAt: number },
  kind: ManifestKind,
  name: string,
  formatTime: (ms: number) => string,
): OrgView | undefined {
  const result = org.layer.result(kind, name);
  if (!result) return undefined;
  const view: OrgView = {
    allowlist: {
      tone: result.kind,
      result: RESULT_TEXT[result.kind],
      mode: result.mode === 'enforce' ? S.orgModeEnforce : S.orgModeAudit,
    },
    link: `${org.origin}${org.layer.dependencyPath(kind, name)}`,
    received: S.orgReceived(formatTime(org.receivedAt)),
  };
  if (result.kind !== 'unlisted') {
    if (result.reason) view.allowlist.reason = result.reason;
    if (result.expiresAt) view.allowlist.expires = result.expiresAt.slice(0, 10);
  }
  return view;
}
