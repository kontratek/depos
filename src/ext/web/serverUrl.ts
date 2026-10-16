/**
 * The Depos address from `pacmon.depos.url`. The sign-in token travels to it,
 * so plain http is accepted only for this machine.
 */
export type ServerUrlResult = { ok: true; origin: string } | { ok: false; reason: 'empty' | 'invalid' | 'insecure' };

/** Until there is a public Depos, the default is a local one (`pnpm dev` in depos-web). */
export const DEFAULT_WEB_URL = 'http://localhost:3000';

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
