import { describe, expect, it } from 'vitest';
import {
  CLIENT_ID,
  pollForToken,
  requestDeviceCode,
  type DeviceCode,
  type HttpFetch,
  type PollClock,
} from '../../ext/web/deviceFlow';
import { githubFullName, remoteUrlFromGitConfig } from '../../ext/web/gitRemote';
import { parseServerUrl } from '../../ext/web/serverUrl';

/** The optional Depos connection: server address, git remote, device flow. */

describe('parseServerUrl', () => {
  it('keeps the origin of an https address', () => {
    expect(parseServerUrl(' https://pacmon.example.com/some/path ')).toEqual({
      ok: true,
      origin: 'https://pacmon.example.com',
    });
  });

  it('allows plain http only for this machine', () => {
    expect(parseServerUrl('http://localhost:3000')).toEqual({ ok: true, origin: 'http://localhost:3000' });
    expect(parseServerUrl('http://127.0.0.1:3000').ok).toBe(true);
    expect(parseServerUrl('http://pacmon.example.com')).toEqual({ ok: false, reason: 'insecure' });
  });

  it('rejects empty, malformed, credentialed and non-http addresses', () => {
    expect(parseServerUrl(undefined)).toEqual({ ok: false, reason: 'empty' });
    expect(parseServerUrl('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseServerUrl('pacmon.example.com')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseServerUrl('https://user:pw@pacmon.example.com')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseServerUrl('ftp://pacmon.example.com')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('remoteUrlFromGitConfig', () => {
  const config = [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "upstream"]',
    '\turl = https://github.com/kontratek/upstream.git',
    '[remote "origin"]',
    '\turl = git@github.com:kontratek/pacmon.git',
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    '[branch "main"]',
    '\tremote = origin',
  ].join('\r\n');

  it('prefers origin', () => {
    expect(remoteUrlFromGitConfig(config)).toBe('git@github.com:kontratek/pacmon.git');
  });

  it('falls back to the first remote, and to nothing', () => {
    expect(remoteUrlFromGitConfig('[remote "fork"]\n  url = https://github.com/a/b\n')).toBe('https://github.com/a/b');
    expect(remoteUrlFromGitConfig('[core]\n  bare = false\n')).toBeUndefined();
  });
});

describe('githubFullName', () => {
  it.each([
    ['https://github.com/kontratek/pacmon.git', 'kontratek/pacmon'],
    ['https://github.com/kontratek/pacmon', 'kontratek/pacmon'],
    ['https://token@github.com/kontratek/pacmon.git', 'kontratek/pacmon'],
    ['git@github.com:kontratek/pacmon.git', 'kontratek/pacmon'],
    ['ssh://git@github.com/kontratek/pacmon.git', 'kontratek/pacmon'],
    ['ssh://git@github.com:22/kontratek/pacmon', 'kontratek/pacmon'],
    ['https://github.com/kontratek/pacmon.web.git', 'kontratek/pacmon.web'],
    // ssh host aliases, one per GitHub account in ~/.ssh/config
    ['git@github-work:umutazazi-kontra/repo-a.git', 'umutazazi-kontra/repo-a'],
    ['git@github.com-personal:kontratek/pacmon.git', 'kontratek/pacmon'],
  ])('%s → %s', (url, expected) => {
    expect(githubFullName(url)).toBe(expected);
  });

  it.each(['https://gitlab.com/a/b.git', 'git@bitbucket.org:a/b.git', 'https://github.com/a', '/local/path'])(
    'ignores %s',
    (url) => {
      expect(githubFullName(url)).toBeUndefined();
    },
  );
});

type Reply = { status: number; body: unknown };

function fakeFetch(replies: Reply[]) {
  const calls: Array<{ url: string; body?: string }> = [];
  const fetchFn: HttpFetch = async (url, init) => {
    calls.push({ url, body: init.body });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected request');
    return { ok: reply.status < 400, status: reply.status, json: async () => reply.body };
  };
  return { fetchFn, calls };
}

function fakeClock(cancelAfterSleeps = Infinity) {
  let time = 0;
  const sleeps: number[] = [];
  const clock: PollClock = {
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    now: () => time,
    isCancelled: () => sleeps.length > cancelAfterSleeps,
  };
  return { clock, sleeps };
}

const CODE: DeviceCode = {
  deviceCode: 'dc',
  userCode: 'ABCD1234',
  verificationUri: 'http://localhost:3000/device',
  verificationUriComplete: 'http://localhost:3000/device?user_code=ABCD1234',
  expiresInSeconds: 600,
  intervalSeconds: 5,
};

describe('requestDeviceCode', () => {
  it('sends the editor client id and reads the answer', async () => {
    const { fetchFn, calls } = fakeFetch([
      {
        status: 200,
        body: {
          device_code: 'dc',
          user_code: 'ABCD1234',
          verification_uri: 'http://localhost:3000/device',
          verification_uri_complete: 'http://localhost:3000/device?user_code=ABCD1234',
          expires_in: 600,
          interval: 5,
        },
      },
    ]);
    expect(await requestDeviceCode(fetchFn, 'http://localhost:3000')).toEqual(CODE);
    expect(calls[0]?.url).toBe('http://localhost:3000/api/auth/device/code');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ client_id: CLIENT_ID });
  });

  it('throws when the server refuses', async () => {
    const { fetchFn } = fakeFetch([{ status: 400, body: { error: 'invalid_client' } }]);
    await expect(requestDeviceCode(fetchFn, 'http://localhost:3000')).rejects.toThrow('HTTP 400');
  });
});

describe('pollForToken', () => {
  it('waits while pending, backs off on slow_down, then returns the token', async () => {
    const { fetchFn, calls } = fakeFetch([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'slow_down' } },
      { status: 200, body: { access_token: 'tok', token_type: 'Bearer' } },
    ]);
    const { clock, sleeps } = fakeClock();
    expect(await pollForToken(fetchFn, 'http://localhost:3000', CODE, clock)).toEqual({ kind: 'token', token: 'tok' });
    expect(sleeps).toEqual([5000, 5000, 10000]);
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dc',
      client_id: CLIENT_ID,
    });
  });

  it('reports a denial and an expired code', async () => {
    const denied = fakeFetch([{ status: 400, body: { error: 'access_denied' } }]);
    expect(await pollForToken(denied.fetchFn, 'o', CODE, fakeClock().clock)).toEqual({ kind: 'denied' });
    const expired = fakeFetch([{ status: 400, body: { error: 'expired_token' } }]);
    expect(await pollForToken(expired.fetchFn, 'o', CODE, fakeClock().clock)).toEqual({ kind: 'expired' });
  });

  it('stops at the deadline without another request', async () => {
    const pending = Array.from({ length: 200 }, () => ({ status: 400, body: { error: 'authorization_pending' } }));
    const { fetchFn, calls } = fakeFetch(pending);
    const result = await pollForToken(fetchFn, 'o', { ...CODE, expiresInSeconds: 12 }, fakeClock().clock);
    expect(result).toEqual({ kind: 'expired' });
    expect(calls).toHaveLength(2);
  });

  it('stops when the user cancels', async () => {
    const { fetchFn, calls } = fakeFetch([{ status: 400, body: { error: 'authorization_pending' } }]);
    expect(await pollForToken(fetchFn, 'o', CODE, fakeClock(1).clock)).toEqual({ kind: 'cancelled' });
    expect(calls).toHaveLength(1);
  });

  it('throws on an unexpected error', async () => {
    const { fetchFn } = fakeFetch([{ status: 500, body: {} }]);
    await expect(pollForToken(fetchFn, 'o', CODE, fakeClock().clock)).rejects.toThrow('HTTP 500');
  });
});
