/**
 * Sign-in to Depos with the OAuth 2.0 device flow (RFC 8628), served by
 * Better Auth's device-authorization plugin: the editor shows a code, the user
 * approves it in the browser, the editor collects a token. No vscode import, so the
 * flow is unit tested with a fake fetch and a fake clock.
 */

/** The client id Depos accepts for this editor. */
export const CLIENT_ID = 'depos-vscode';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type HttpFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type PollResult =
  | { kind: 'token'; token: string }
  | { kind: 'denied' }
  | { kind: 'expired' }
  | { kind: 'cancelled' };

export interface PollClock {
  sleep(ms: number): Promise<void>;
  now(): number;
  isCancelled(): boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

export async function requestDeviceCode(fetchFn: HttpFetch, origin: string): Promise<DeviceCode> {
  const response = await fetchFn(`${origin}/api/auth/device/code`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  const body = asRecord(await response.json());
  if (!response.ok || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
    throw new Error(`Depos refused the sign-in (HTTP ${response.status}).`);
  }
  const verificationUri = typeof body.verification_uri === 'string' ? body.verification_uri : `${origin}/device`;
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri,
    verificationUriComplete:
      typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : verificationUri,
    expiresInSeconds: typeof body.expires_in === 'number' ? body.expires_in : 600,
    intervalSeconds: typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5,
  };
}

/** Polls until the user approves or denies, the code expires, or the caller cancels. */
export async function pollForToken(
  fetchFn: HttpFetch,
  origin: string,
  code: DeviceCode,
  clock: PollClock,
): Promise<PollResult> {
  const deadline = clock.now() + code.expiresInSeconds * 1000;
  let intervalMs = code.intervalSeconds * 1000;
  for (;;) {
    await clock.sleep(intervalMs);
    if (clock.isCancelled()) return { kind: 'cancelled' };
    if (clock.now() >= deadline) return { kind: 'expired' };

    const response = await fetchFn(`${origin}/api/auth/device/token`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ grant_type: GRANT_TYPE, device_code: code.deviceCode, client_id: CLIENT_ID }),
    });
    const body = asRecord(await response.json());
    if (response.ok && typeof body.access_token === 'string') return { kind: 'token', token: body.access_token };

    switch (body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        // RFC 8628 §3.5: add 5 seconds to the interval.
        intervalMs += 5000;
        continue;
      case 'access_denied':
        return { kind: 'denied' };
      case 'expired_token':
      case 'invalid_grant':
        return { kind: 'expired' };
      default:
        throw new Error(`Depos stopped the sign-in (HTTP ${response.status}).`);
    }
  }
}
