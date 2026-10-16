/** Checks for JSON from Depos: it is untrusted input. No vscode import, so it is unit tested. */

/** Size limits for anything read from the server. */
export const LIMITS = { text: 100_000, short: 1_000, items: 50_000 } as const;

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown, max: number = LIMITS.short): v is string => typeof v === 'string' && v.length <= max;
export const list = (v: unknown): v is unknown[] => Array.isArray(v) && v.length <= LIMITS.items;

/** One map key per package: ecosystem and normalized name. */
export function lookupKey(ecosystem: string, noteKey: string): string {
  return `${ecosystem}\u0000${noteKey}`;
}
