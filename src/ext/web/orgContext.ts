import * as vscode from 'vscode';
import { manifestAdapterForPath } from '../../core/manifest';
import type { ManifestKind } from '../../core/model';
import { logError, logInfo } from '../log';
import { S } from '../strings';
import type { OrgMcpFolder } from './orgMcpServers';
import { agentTextToFields, OrgNotesCopy, parseOrgNote, parseOrgNotesSync, parseSnapshot } from './orgNotes';
import { type WebConnection, workspaceRepository } from './webConnection';

/** How often org data is fetched again while the window is open. */
const REFRESH_INTERVAL_MS = 5 * 60_000;
/** Focusing the window refreshes, but not more often than this. */
const FOCUS_MIN_GAP_MS = 30_000;
/** A sync stops after this many pages and goes on at the next refresh. */
const MAX_SYNC_PAGES = 50;
const CACHE_PREFIX = 'pacmon.depos.org:';
const NOTES_DIR = 'org-notes';

/** Notes files of org mode: built from the org notes, read-only, never on disk. */
export const ORG_NOTES_SCHEME = 'pacmon-org';

/** What Depos answered for a folder's repository, kept for a start while offline. */
interface Cached {
  repoUlid: string;
  orgUlid: string;
}

/** A workspace folder whose repository is added to one of the user's organizations in Depos. */
export interface FolderOrg {
  origin: string;
  repoUlid: string;
  orgUlid: string;
}

/** A refused save or delete, with a message for the user. */
export class OrgNoteError extends Error {}

/**
 * Org mode of each workspace folder (docs/format.md, "The organization layer").
 *
 * - The folder's organization: Depos matches the repository of its GitHub remote.
 * - The org notes, per organization: a local copy in the extension's global storage,
 *   kept current by a delta sync. A folder whose copy is loaded is in org mode: its
 *   notes come from the copy, through a read-only notes text per ecosystem.
 *
 * Fetched while signed in to Depos: at start, after sign-in, when the window gets
 * focus, every 5 minutes, and on the refresh command. Signing out, or a repository
 * that is no longer in an organization of the user, removes every copy.
 */
export class OrgContext implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Org data changed: the org notes, or the mode of a folder. */
  readonly onDidChange = this.emitter.event;
  private readonly folders = new Map<string, FolderOrg>();
  private readonly copies = new Map<string, OrgNotesCopy>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private running: Promise<void> | undefined;
  private lastRun = 0;

  constructor(
    private readonly web: WebConnection,
    private readonly memento: vscode.Memento,
    private readonly storage: vscode.Uri,
  ) {
    this.disposables.push(
      web.onDidChange(() => void this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('pacmon.depos.url')) void this.refresh();
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused && Date.now() - this.lastRun > FOCUS_MIN_GAP_MS) void this.refresh();
      }),
    );
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    void this.refresh();
  }

  dispose(): void {
    clearInterval(this.timer);
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }

  /** The organization of the workspace folder that holds `uri`. */
  forUri(uri: vscode.Uri): FolderOrg | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? this.folders.get(folder.uri.toString()) : undefined;
  }

  /** The org notes of the folder that holds `uri`, when that folder is in org mode. */
  notesFor(uri: vscode.Uri): { folder: FolderOrg; copy: OrgNotesCopy } | undefined {
    const folder = this.forUri(uri);
    const copy = folder ? this.copies.get(folder.orgUlid) : undefined;
    return folder && copy?.loaded ? { folder, copy } : undefined;
  }

  /** The workspace folders in org mode, for the MCP servers of their repositories. */
  orgFolders(): OrgMcpFolder[] {
    const result: OrgMcpFolder[] = [];
    for (const workspaceFolder of vscode.workspace.workspaceFolders ?? []) {
      const folder = this.folders.get(workspaceFolder.uri.toString());
      const copy = folder ? this.copies.get(folder.orgUlid) : undefined;
      if (folder && copy?.loaded) {
        result.push({ name: workspaceFolder.name, origin: folder.origin, repoUlid: folder.repoUlid, canEdit: copy.canEdit });
      }
    }
    return result;
  }

  // ── Org mode notes: a read-only notes text per folder and ecosystem ─────────────

  /** The notes "file" of a manifest in org mode; undefined in file mode. */
  notesUriFor(manifestUri: vscode.Uri): vscode.Uri | undefined {
    const kind = manifestAdapterForPath(manifestUri.path)?.kind;
    const folder = vscode.workspace.getWorkspaceFolder(manifestUri);
    if (!kind || !folder || !this.notesFor(manifestUri)) return undefined;
    return vscode.Uri.from({
      scheme: ORG_NOTES_SCHEME,
      path: `/Org notes (${kind}).md`,
      query: new URLSearchParams({ folder: folder.uri.toString(), ecosystem: kind }).toString(),
    });
  }

  /** Text and version of an org mode notes "file"; undefined once the folder left org mode. */
  readNotes(uri: vscode.Uri): { version: string; text: string } | undefined {
    if (uri.scheme !== ORG_NOTES_SCHEME) return undefined;
    const params = new URLSearchParams(uri.query);
    const folderUri = params.get('folder');
    const kind = params.get('ecosystem') as ManifestKind | null;
    if (!folderUri || !kind) return undefined;
    const folder = this.folders.get(folderUri);
    const copy = folder ? this.copies.get(folder.orgUlid) : undefined;
    if (!folder || !copy?.loaded) return undefined;
    return { version: `${folder.orgUlid}:${copy.version}`, text: copy.notesText(kind, folder.repoUlid) };
  }

  /**
   * Save the note of a package in org mode. Empty layers delete the org note. Agent
   * lines that are not fields are left out (an org note holds fields only); the count is
   * returned so the caller can say so. Throws OrgNoteError with a message for the user.
   */
  async saveNote(manifestUri: vscode.Uri, name: string, human: string, agent: string | undefined): Promise<{ dropped: number }> {
    const found = this.notesFor(manifestUri);
    const kind = manifestAdapterForPath(manifestUri.path)?.kind;
    if (!found || !kind) throw new OrgNoteError(S.orgNoteNotConnected);
    const { folder, copy } = found;
    if (!copy.canEdit) throw new OrgNoteError(S.orgNoteReadOnly);

    const current = copy.note(kind, name, folder.repoUlid);
    const parsed = agent === undefined ? { fields: current?.fields ?? [], dropped: 0 } : agentTextToFields(agent);
    const path = `/api/extension/organizations/${encodeURIComponent(folder.orgUlid)}/notes`;

    if (human.trim() === '' && parsed.fields.length === 0) {
      if (!current) return { dropped: parsed.dropped };
      const query = new URLSearchParams({ ecosystem: kind, packageName: current.displayName, baseUpdatedAt: current.updatedAt });
      const result = await this.web.sendJson('DELETE', `${path}?${query.toString()}`);
      await this.afterWrite(result);
      copy.remove(current.ecosystem, current.noteKey);
    } else {
      const result = await this.web.sendJson('PUT', path, {
        ecosystem: kind,
        packageName: current?.displayName ?? name,
        humanText: human.trim(),
        fields: parsed.fields,
        baseUpdatedAt: current?.updatedAt ?? null,
      });
      await this.afterWrite(result);
      const saved = result.kind === 'ok' ? parseOrgNote(result.body) : undefined;
      if (!saved) throw new OrgNoteError(S.orgNoteSaveFailed);
      copy.put(saved);
    }
    await this.persist(folder.origin, copy);
    this.emitter.fire();
    return { dropped: parsed.dropped };
  }

  private async afterWrite(result: Awaited<ReturnType<WebConnection['sendJson']>>): Promise<void> {
    if (result.kind === 'ok') return;
    if (result.kind === 'signedOut') throw new OrgNoteError(S.webSessionExpired);
    // Someone else changed the note: bring the copy up to date before the user retries.
    if (result.status === 409) void this.refresh();
    throw new OrgNoteError(result.message ?? S.orgNoteSaveFailed);
  }

  // ── Fetching ─────────────────────────────────────────────────────────────────

  /** Fetch every folder again. A call while one runs waits for it instead of starting another. */
  refresh(): Promise<void> {
    this.running ??= this.refreshAll().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async refreshAll(): Promise<void> {
    this.lastRun = Date.now();
    try {
      const creds = await this.web.credentials();
      if (!creds) {
        await this.clearAll();
        return;
      }
      let changed = false;
      const seen = new Set<string>();
      const orgs = new Set<string>();
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        seen.add(folder.uri.toString());
        changed = (await this.refreshFolder(folder, creds.origin)) || changed;
        const orgUlid = this.folders.get(folder.uri.toString())?.orgUlid;
        if (orgUlid) orgs.add(orgUlid);
      }
      for (const key of [...this.folders.keys()]) {
        if (!seen.has(key)) changed = this.folders.delete(key) || changed;
      }
      for (const orgUlid of orgs) changed = (await this.syncNotes(creds.origin, orgUlid)) || changed;
      if (changed) this.emitter.fire();
    } catch (e) {
      logError('orgContext.refresh', e);
    }
  }

  /**
   * Which organization the folder's repository is in, asked on every refresh: a
   * repository removed from Depos, or a user removed from the organization, leaves org
   * mode. True when what the folder shows changed.
   */
  private async refreshFolder(folder: vscode.WorkspaceFolder, origin: string): Promise<boolean> {
    const folderKey = folder.uri.toString();
    const repo = await workspaceRepository(folder.uri);
    if (!repo) return this.folders.delete(folderKey);

    const cacheKey = `${CACHE_PREFIX}${origin}|${repo.toLowerCase()}`;
    const cached = this.memento.get<Cached>(cacheKey);
    let changed = false;
    // Offline at start: use the last copies at once; the request below confirms them.
    if (cached?.orgUlid && !this.folders.has(folderKey)) {
      changed = this.show(folderKey, origin, cached);
      changed = (await this.loadCopy(origin, cached.orgUlid)) || changed;
    }

    try {
      const found = await this.web.fetchJson(`/api/extension/workspace?repository=${encodeURIComponent(repo)}`);
      if (found.kind === 'signedOut') return changed;
      if (found.kind === 'status') {
        if (found.status === 404) return this.forget(folderKey, cacheKey) || changed;
        logInfo(`depos: workspace lookup for ${folder.name} answered HTTP ${found.status}`);
        return changed;
      }
      const body = found.body as { repository?: { ulid?: unknown }; organization?: { ulid?: unknown } } | null;
      const repoUlid = body?.repository?.ulid;
      const orgUlid = body?.organization?.ulid;
      if (typeof repoUlid !== 'string' || typeof orgUlid !== 'string') return changed;
      const next: Cached = { repoUlid, orgUlid };
      if (cached?.repoUlid !== repoUlid || cached.orgUlid !== orgUlid) await this.memento.update(cacheKey, next);
      changed = this.show(folderKey, origin, next) || changed;
      return (await this.loadCopy(origin, orgUlid)) || changed;
    } catch (e) {
      // Offline or the server is down: the last copies stay, with their times.
      logError(`orgContext.fetch ${folder.name}`, e);
      return changed;
    }
  }

  /** Bring the org notes copy up to date, page by page. True when anything changed. */
  private async syncNotes(origin: string, orgUlid: string): Promise<boolean> {
    await this.loadCopy(origin, orgUlid);
    const copy = this.copies.get(orgUlid) ?? new OrgNotesCopy(orgUlid);
    this.copies.set(orgUlid, copy);
    let changed = false;
    try {
      for (let page = 0; page < MAX_SYNC_PAGES; page++) {
        const since = copy.loaded ? `?since=${encodeURIComponent(copy.cursor)}` : '';
        const answer = await this.web.fetchJson(`/api/extension/organizations/${encodeURIComponent(orgUlid)}/notes${since}`);
        if (answer.kind === 'signedOut') return changed;
        if (answer.kind === 'status') {
          if (answer.status === 404) return (await this.forgetOrg(origin, orgUlid)) || changed;
          // A cursor the server no longer accepts: start over with a full copy.
          if (answer.status === 400 && copy.loaded) {
            copy.cursor = '';
            continue;
          }
          logInfo(`depos: org notes sync answered HTTP ${answer.status}`);
          return changed;
        }
        if (answer.kind !== 'ok') return changed;
        const sync = parseOrgNotesSync(answer.body);
        if (!sync) {
          logError('orgContext.notes', new Error('unexpected org notes answer'));
          return changed;
        }
        const wasLoaded = copy.loaded;
        changed = copy.apply(sync, Date.now()) || !wasLoaded || changed;
        if (!sync.more) break;
      }
      await this.persist(origin, copy);
    } catch (e) {
      logError('orgContext.syncNotes', e);
    }
    return changed;
  }

  private show(folderKey: string, origin: string, cached: Cached): boolean {
    const before = this.folders.get(folderKey);
    if (before && before.origin === origin && before.orgUlid === cached.orgUlid && before.repoUlid === cached.repoUlid) return false;
    this.folders.set(folderKey, { origin, repoUlid: cached.repoUlid, orgUlid: cached.orgUlid });
    return true;
  }

  private forget(folderKey: string, cacheKey: string): boolean {
    void this.memento.update(cacheKey, undefined);
    return this.folders.delete(folderKey);
  }

  // ── The local copy of org notes ────────────────────────────────────────

  private notesFile(origin: string, orgUlid: string): vscode.Uri {
    const server = origin.replace(/[^A-Za-z0-9.-]+/g, '_');
    return vscode.Uri.joinPath(this.storage, NOTES_DIR, server, `${orgUlid.replace(/[^A-Za-z0-9]/g, '')}.json`);
  }

  /** Read the copy from disk once per session. True when a copy appeared. */
  private async loadCopy(origin: string, orgUlid: string): Promise<boolean> {
    if (this.copies.has(orgUlid)) return false;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.notesFile(origin, orgUlid));
      const snapshot = parseSnapshot(JSON.parse(new TextDecoder().decode(bytes)));
      if (snapshot && snapshot.orgUlid === orgUlid) {
        this.copies.set(orgUlid, new OrgNotesCopy(orgUlid, snapshot));
        return true;
      }
    } catch {
      // No copy yet: the sync makes one.
    }
    return false;
  }

  private async persist(origin: string, copy: OrgNotesCopy): Promise<void> {
    try {
      const uri = this.notesFile(origin, copy.orgUlid);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(copy.snapshot())));
    } catch (e) {
      logError('orgContext.persist', e);
    }
  }

  /** The user left the organization: its notes and every folder of it go. */
  private async forgetOrg(origin: string, orgUlid: string): Promise<boolean> {
    this.copies.delete(orgUlid);
    try {
      await vscode.workspace.fs.delete(this.notesFile(origin, orgUlid));
    } catch {
      // Already gone.
    }
    let changed = false;
    for (const [key, folder] of [...this.folders]) {
      if (folder.orgUlid === orgUlid) changed = this.folders.delete(key) || changed;
    }
    return changed;
  }

  /** Signed out: nothing of any organization stays, in memory or on disk. */
  private async clearAll(): Promise<void> {
    for (const key of this.memento.keys()) {
      if (key.startsWith(CACHE_PREFIX)) await this.memento.update(key, undefined);
    }
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.storage, NOTES_DIR), { recursive: true });
    } catch {
      // Nothing was stored.
    }
    if (this.folders.size > 0 || this.copies.size > 0) {
      this.folders.clear();
      this.copies.clear();
      this.emitter.fire();
    }
  }
}
