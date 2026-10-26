/**
 * The Depos address from `depos.url`. The sign-in token travels to it,
 * so plain http is accepted only for this machine.
 */
export type ServerUrlResult = { ok: true; origin: string } | { ok: false; reason: 'empty' | 'invalid' | 'insecure' };

/** The public Depos. A local one (`pnpm dev` in depos-web) is `http://localhost:3000`. */
export const DEFAULT_WEB_URL = 'https://depos.dev';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function parseServerUrl(raw: string | undefined): ServerUrlResult {
  const text = raw?.trim() ?? '';
  if (!text) return { ok: false, reason: 'empty' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.username || url.password || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) return { ok: false, reason: 'insecure' };
  return { ok: true, origin: url.origin };
}

/** depos.dev was pacmon.dev before Pacmon became Depos: an address saved then still works. */
export function renamedServerUrl(url: string | undefined): string | undefined {
  return url?.replace(/^https:\/\/(?:www\.)?pacmon\.dev(?=\/|$)/i, 'https://depos.dev');
}
