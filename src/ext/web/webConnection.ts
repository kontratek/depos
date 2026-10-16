import * as vscode from 'vscode';
import { logError, logInfo } from '../log';
import { S } from '../strings';
import { pollForToken, requestDeviceCode, type HttpFetch } from './deviceFlow';
import { githubFullName, remoteUrlFromGitConfig } from './gitRemote';
import { DEFAULT_WEB_URL, parseServerUrl } from './serverUrl';

/**
 * The optional connection to Depos (`pacmon.depos.url`), the web app that holds an
 * organization's org notes. With the setting empty, or while signed out, nothing here
 * makes a network request. Signed in, the commands and org mode (orgContext.ts) make
 * requests. The token lives in SecretStorage, keyed by the server origin, and is never
 * logged.
 */

const REQUEST_TIMEOUT_MS = 10_000;

interface SessionInfo {
  user: { name: string; email: string };
}
interface WorkspaceInfo {
  organization: { ulid: string; name: string };
  repository: { ulid: string; fullName: string };
}

const httpFetch: HttpFetch = async (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

class SessionEndedError extends Error {}

export type FetchResult =
  | { kind: 'signedOut' }
  | { kind: 'status'; origin: string; status: number }
  | { kind: 'unchanged'; origin: string }
  | { kind: 'ok'; origin: string; body: unknown; etag?: string };

export type SendResult =
  | { kind: 'signedOut' }
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'status'; status: number; message?: string };

/** What the Pacmon view shows. Read from settings and secret storage only: no request. */
export interface WebStatus {
  /** Host of the configured server; undefined when the setting is empty or not valid. */
  host?: string;
  /** The setting holds something that is not a usable address. */
  invalid: boolean;
  signedIn: boolean;
}

export class WebConnection implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly listener: vscode.Disposable;
  /** Fires when a token is stored or removed, so the Pacmon view can redraw. */
  readonly onDidChange = this.emitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.listener = secrets.onDidChange((e) => {
      if (e.key.startsWith('pacmon.depos.token:')) this.emitter.fire();
    });
  }

  dispose(): void {
    this.listener.dispose();
    this.emitter.dispose();
  }

  async status(): Promise<WebStatus> {
    const parsed = parseServerUrl(configuredUrl());
    if (!parsed.ok) return { invalid: parsed.reason !== 'empty', signedIn: false };
    const signedIn = (await this.secrets.get(this.tokenKey(parsed.origin))) !== undefined;
    return { host: new URL(parsed.origin).host, invalid: false, signedIn };
  }

  private tokenKey(origin: string): string {
    return `pacmon.depos.token:${origin}`;
  }

  /** The configured origin, after telling the user what is wrong with it. */
  private async origin(promptIfEmpty: boolean): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('pacmon');
    let raw = configuredUrl();
    if (!raw?.trim() && promptIfEmpty) {
      raw = await vscode.window.showInputBox({
        prompt: S.webUrlPrompt,
        placeHolder: S.webUrlPlaceholder,
        ignoreFocusOut: true,
      });
      if (!raw?.trim()) return undefined;
      const parsed = parseServerUrl(raw);
      if (parsed.ok) await config.update('depos.url', parsed.origin, vscode.ConfigurationTarget.Global);
    }
    const parsed = parseServerUrl(raw);
    if (parsed.ok) return parsed.origin;
    if (parsed.reason === 'invalid') void vscode.window.showErrorMessage(S.webUrlInvalid);
    if (parsed.reason === 'insecure') void vscode.window.showErrorMessage(S.webUrlInsecure);
    return undefined;
  }

  private async get<T>(origin: string, token: string, path: string): Promise<{ status: number; body?: T }> {
    const response = await httpFetch(`${origin}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (response.status === 401) throw new SessionEndedError();
    return { status: response.status, body: response.ok ? ((await response.json()) as T) : undefined };
  }

  /** The configured origin and its token, without asking anything. Undefined while signed out. */
  async credentials(): Promise<{ origin: string; token: string } | undefined> {
    const parsed = parseServerUrl(configuredUrl());
    if (!parsed.ok) return undefined;
    const token = await this.secrets.get(this.tokenKey(parsed.origin));
    return token ? { origin: parsed.origin, token } : undefined;
  }

  /**
   * A GET for org mode. With `etag`, an unchanged answer is a 304 and has no body.
   * A 401 removes the token: the sign-in has ended.
   */
  async fetchJson(path: string, etag?: string): Promise<FetchResult> {
    const creds = await this.credentials();
    if (!creds) return { kind: 'signedOut' };
    const headers: Record<string, string> = { Authorization: `Bearer ${creds.token}`, Accept: 'application/json' };
    if (etag) headers['If-None-Match'] = etag;
    const response = await fetch(`${creds.origin}${path}`, { method: 'GET', headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (response.status === 401) {
      await this.secrets.delete(this.tokenKey(creds.origin));
      logInfo(`depos: sign-in at ${creds.origin} ended (401)`);
      return { kind: 'signedOut' };
    }
    if (response.status === 304) return { kind: 'unchanged', origin: creds.origin };
    if (!response.ok) return { kind: 'status', origin: creds.origin, status: response.status };
    return { kind: 'ok', origin: creds.origin, body: await response.json(), etag: response.headers.get('etag') ?? undefined };
  }

  /**
   * A write for org mode (save or delete an org note). A refused write carries the
   * server's message, which is written for users (generic, no internal detail).
   */
  async sendJson(method: 'PUT' | 'DELETE', path: string, body?: unknown): Promise<SendResult> {
    const creds = await this.credentials();
    if (!creds) return { kind: 'signedOut' };
    const headers: Record<string, string> = { Authorization: `Bearer ${creds.token}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${creds.origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401) {
      await this.secrets.delete(this.tokenKey(creds.origin));
      logInfo(`depos: sign-in at ${creds.origin} ended (401)`);
      return { kind: 'signedOut' };
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (response.ok) return { kind: 'ok', status: response.status, body: json };
    const message = (json as { message?: unknown } | undefined)?.message;
    return { kind: 'status', status: response.status, message: typeof message === 'string' ? message.slice(0, 300) : undefined };
  }

  async signIn(): Promise<void> {
    const origin = await this.origin(true);
    if (!origin) return;

    const code = await requestDeviceCode(httpFetch, origin);
    logInfo(`depos: sign-in started at ${origin}`);
    void vscode.env.openExternal(vscode.Uri.parse(code.verificationUriComplete));
    // The browser may not open (remote session, blocked): the button opens it again.
    void vscode.window.showInformationMessage(S.webSignInCode(code.userCode), S.webOpenBrowser).then((choice) => {
      if (choice) void vscode.env.openExternal(vscode.Uri.parse(code.verificationUriComplete));
    });

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: S.webWaiting(code.userCode), cancellable: true },
      (_progress, cancel) =>
        pollForToken(httpFetch, origin, code, {
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          now: () => Date.now(),
          isCancelled: () => cancel.isCancellationRequested,
        }),
    );

    if (result.kind === 'denied') return void vscode.window.showWarningMessage(S.webDenied);
    if (result.kind === 'expired') return void vscode.window.showWarningMessage(S.webExpired);
    if (result.kind === 'cancelled') return;

    await this.secrets.store(this.tokenKey(origin), result.token);
    logInfo(`depos: signed in at ${origin}`);
    await this.showConnection();
  }

  async signOut(): Promise<void> {
    const origin = await this.origin(false);
    if (!origin) return;
    const key = this.tokenKey(origin);
    const token = await this.secrets.get(key);
    if (!token) return void vscode.window.showInformationMessage(S.webNotSignedIn);
    try {
      // Ends the session on the server too, so the token stops working everywhere.
      await httpFetch(`${origin}/api/extension/sign-out`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      // The local token is removed anyway; the server session then ends at its expiry.
      logError('depos.signOut', e);
    }
    await this.secrets.delete(key);
    logInfo(`depos: signed out of ${origin}`);
    void vscode.window.showInformationMessage(S.webSignedOut);
  }

  /** Who is signed in, and which organization each workspace folder belongs to. */
  async showConnection(): Promise<void> {
    const origin = await this.origin(false);
    if (!origin) return void vscode.window.showInformationMessage(S.webNotSignedIn);
    const key = this.tokenKey(origin);
    const token = await this.secrets.get(key);
    if (!token) {
      const choice = await vscode.window.showInformationMessage(S.webNotSignedIn, S.webSignIn);
      if (choice) await this.signIn();
      return;
    }

    try {
      const { status: sessionStatus, body: session } = await this.get<SessionInfo>(
        origin,
        token,
        '/api/extension/session',
      );
      if (!session) throw new Error(`GET /api/extension/session answered HTTP ${sessionStatus}`);
      const lines: string[] = [];
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const repo = await workspaceRepository(folder.uri);
        if (!repo) {
          lines.push(S.webFolderNoRemote(folder.name));
          continue;
        }
        const { status, body } = await this.get<WorkspaceInfo>(
          origin,
          token,
          `/api/extension/workspace?repository=${encodeURIComponent(repo)}`,
        );
        lines.push(
          body && status === 200
            ? S.webFolderOrg(folder.name, body.organization.name, body.repository.fullName)
            : S.webFolderNoOrg(folder.name, repo),
        );
      }
      for (const line of lines) logInfo(`depos: ${line}`);
      void vscode.window.showInformationMessage(S.webSignedIn(session.user.name, session.user.email), {
        modal: true,
        detail: lines.join('\n'),
      });
    } catch (e) {
      if (e instanceof SessionEndedError) {
        await this.secrets.delete(key);
        const choice = await vscode.window.showWarningMessage(S.webSessionExpired, S.webSignIn);
        if (choice) await this.signIn();
        return;
      }
      logError('depos.showConnection', e);
      void vscode.window.showErrorMessage(S.webUnreachable(origin));
    }
  }
}

/** The setting; the local default when it is unset. An explicit empty value asks at sign-in. */
function configuredUrl(): string | undefined {
  return vscode.workspace.getConfiguration('pacmon').get<string>('depos.url', DEFAULT_WEB_URL);
}

/** `owner/name` of the folder's GitHub remote. Follows a `.git` file (worktree, submodule). */
export async function workspaceRepository(folder: vscode.Uri): Promise<string | undefined> {
  const configText = await readGitConfig(folder);
  const remote = configText ? remoteUrlFromGitConfig(configText) : undefined;
  return remote ? githubFullName(remote) : undefined;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function readGitConfig(folder: vscode.Uri): Promise<string | undefined> {
  const dotGit = vscode.Uri.joinPath(folder, '.git');
  let gitDir = dotGit;
  try {
    const stat = await vscode.workspace.fs.stat(dotGit);
    if (stat.type & vscode.FileType.File) {
      // "gitdir: <path>": a worktree or a submodule. Its config is in the common dir.
      const pointer = /^gitdir:\s*(.+)$/m.exec((await readText(dotGit)) ?? '')?.[1]?.trim();
      if (!pointer) return undefined;
      gitDir = /^([a-zA-Z]:)?[\\/]/.test(pointer) ? vscode.Uri.file(pointer) : vscode.Uri.joinPath(folder, pointer);
      const common = (await readText(vscode.Uri.joinPath(gitDir, 'commondir')))?.trim();
      if (common) gitDir = vscode.Uri.joinPath(gitDir, common);
    }
  } catch {
    return undefined;
  }
  return readText(vscode.Uri.joinPath(gitDir, 'config'));
}
