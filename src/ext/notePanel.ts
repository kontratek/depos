import * as vscode from 'vscode';
import { type AgentProblem, fixAgentText, lintAgentText } from '../core/fixes';
import { sectionLayers } from '../core/layers';
import { manifestAdapterForPath } from '../core/manifest';
import { miniMarkdown } from '../core/miniMarkdown';
import { normalizeName } from '../core/match';
import { findSection } from '../core/parseNotes';
import { notesFileLabelForManifest } from './config';
import { logError } from './log';
import { renderHtml } from './notePanelHtml';
import { resolveNotesFileFor } from './resolveNotesFile';
import type { Store } from './state';
import { S } from './strings';
import { upsertNoteLayers } from './commands/writeNote';
import type { OrgContext } from './web/orgContext';
import { orgView } from './web/orgView';

const VIEW_TYPE = 'pacmon.noteEditor';

interface Target {
  key: string;
  pkgUri: vscode.Uri;
  name: string;
  depSection?: string;
}

/** The two editable layers of a section. `### Generated` never shows here. */
interface Layers {
  human: string;
  agent: string;
}

const EMPTY: Layers = { human: '', agent: '' };

/** Messages from the webview. `key` names the dependency the text belongs to,
 *  so a save that arrives after a retarget still lands in the right section. */
interface Incoming {
  type: 'ready' | 'input' | 'save' | 'fixAgent' | 'openFile' | 'openWeb';
  key?: string;
  human?: string;
  agent?: string;
}

/** What the panel shows under the agent box. */
interface Problems {
  header: string;
  items: string[];
  fixable: number;
}

function targetKey(pkgUri: vscode.Uri, name: string): string {
  return `${pkgUri.toString()}::${name}`;
}

function sameLayers(a: Layers, b: Layers): boolean {
  return a.human.trim() === b.human.trim() && a.agent.trim() === b.agent.trim();
}

function fromMessage(msg: Incoming): Layers {
  return { human: msg.human ?? '', agent: msg.agent ?? '' };
}

/**
 * Read-mode HTML for one layer. VS Code's built-in Markdown extension renders
 * it (the preview's own engine, offline, no dependency of ours); the small
 * fallback only matters when that extension is disabled.
 */
async function renderMarkdown(md: string): Promise<string> {
  if (md.trim() === '') return '';
  try {
    const html = await vscode.commands.executeCommand<unknown>('markdown.api.render', md);
    if (typeof html === 'string') return html;
  } catch {
    // built-in markdown extension unavailable — fall through
  }
  return miniMarkdown(md);
}

function problemText(p: AgentProblem): string {
  const line = p.line + 1;
  switch (p.kind) {
    case 'unknownAgentKey':
      return p.suggestion === undefined ? S.panelProblemUnknown(line, p.key) : S.panelProblemSuggest(line, p.key, p.suggestion);
    case 'emptyAgentValue':
      return S.panelProblemEmpty(line, p.key);
    case 'badAgentValue':
      return S.panelProblemBad(line, p.key, p.expected);
  }
}

function problemsOf(agent: string): Problems {
  const found = lintAgentText(agent);
  return {
    header: S.panelProblemsHeader(found.length),
    items: found.map(problemText),
    fixable: found.filter((p) => p.kind === 'unknownAgentKey').length,
  };
}

function clock(): string {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * PRIMARY note-entry surface (pacmon.noteEntry = "panel"): a webview opens
 * BESIDE package.json for one dependency's note. Each layer is shown rendered
 * and edited in place: click to write, Esc when done, saved as you type. The
 * human text is the main box; the agent block sits below it, folded — unless
 * it has problems, which are listed under it with a Fix button.
 *
 * Offline by construction: the webview loads no external resources
 * (`localResourceRoots: []`, CSP `default-src 'none'`) and the HTML is
 * bundled with the extension.
 *
 * Nothing is lost on the way out: retargeting the panel, hiding it or closing
 * it writes whatever is still pending first.
 */
export class NotePanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private current: Target | undefined;
  /** Every dependency this panel has shown, so late saves can still be routed. */
  private readonly targets = new Map<string, Target>();
  /** Layers as they stand in the notes file for the current target. */
  private loaded: Layers = EMPTY;
  /** Latest layers reported by the webview for the current target. */
  private live: Layers = EMPTY;
  /** Guards against out-of-order reloads when targets change rapidly. */
  private loadToken = 0;
  /** Messages are handled one after another: a save and a fix must not race. */
  private queue: Promise<void> = Promise.resolve();
  /** Listeners of the CURRENT panel — cleared each time one is closed. */
  private listeners: vscode.Disposable[] = [];
  private readonly orgListener: vscode.Disposable;

  constructor(
    private readonly store: Store,
    private readonly org: OrgContext,
  ) {
    // A fresh copy of the org notes from Depos redraws the open panel.
    this.orgListener = org.onDidChange(() => void this.onOrgChange());
  }

  dispose(): void {
    this.orgListener.dispose();
    this.panel?.dispose();
    for (const d of this.listeners) d.dispose();
    this.listeners = [];
  }

  /** Open (or retarget) the panel for one dependency of one package.json. */
  async show(pkgUri: vscode.Uri, name: string): Promise<void> {
    await this.flushCurrent();

    const deps = await this.store.getDeps(pkgUri);
    const dep = deps.find((d) => d.noteKey === name || normalizeName(d.noteKey) === normalizeName(name));
    const target: Target = { key: targetKey(pkgUri, name), pkgUri, name, depSection: dep?.scope };
    this.targets.set(target.key, target);
    this.current = target;

    const existed = this.panel !== undefined;
    const panel = this.ensurePanel();
    panel.title = S.panelTitle(name);
    // A fresh panel is already revealed Beside; only an existing one needs
    // bringing forward — in the column it currently occupies.
    if (existed) panel.reveal(undefined, false);
    await this.reload();
  }

  private ensurePanel(): vscode.WebviewPanel {
    if (this.panel) return this.panel;

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      S.panelTitle(''),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        // Nothing is ever loaded from disk or the network.
        localResourceRoots: [],
        enableFindWidget: false,
      },
    );
    panel.webview.html = renderHtml();

    this.listeners = [
      panel.webview.onDidReceiveMessage((msg: Incoming) => {
        this.queue = this.queue.then(() => this.onMessage(msg));
      }),
      panel.onDidDispose(() => {
        void this.flushCurrent();
        for (const d of this.listeners) d.dispose();
        this.listeners = [];
        this.panel = undefined;
        this.current = undefined;
      }),
    ];

    this.panel = panel;
    return panel;
  }

  private async onMessage(msg: Incoming): Promise<void> {
    try {
      switch (msg.type) {
        case 'ready':
          // The webview was recreated (it was hidden): restore what we hold,
          // never a stale read from disk.
          await this.postState();
          break;
        case 'input':
          if (msg.key === this.current?.key) {
            this.live = fromMessage(msg);
            // Problems follow the keystrokes, so a typo shows before it is saved.
            void this.panel?.webview.postMessage({ type: 'problems', key: msg.key, problems: problemsOf(this.live.agent) });
          }
          break;
        case 'save': {
          const target = this.targetFor(msg);
          if (target) await this.save(target, fromMessage(msg));
          break;
        }
        case 'fixAgent': {
          const target = this.targetFor(msg);
          if (!target) break;
          const layers = fromMessage(msg);
          await this.save(target, { human: layers.human, agent: fixAgentText(layers.agent) });
          break;
        }
        case 'openFile':
          await vscode.commands.executeCommand('pacmon.openNotesFile');
          break;
        case 'openWeb': {
          // The link is built here, never taken from the webview.
          const link = this.current ? this.orgFor(this.current)?.link : undefined;
          if (link) await vscode.env.openExternal(vscode.Uri.parse(link));
          break;
        }
      }
    } catch (e) {
      logError(`notePanel.${msg.type}`, e);
    }
  }

  private targetFor(msg: Incoming): Target | undefined {
    return (msg.key !== undefined ? this.targets.get(msg.key) : undefined) ?? this.current;
  }

  private async write(target: Target, input: Layers): Promise<Layers> {
    const text: Layers = { human: input.human.trim(), agent: input.agent.trim() };
    await upsertNoteLayers(this.store, target.pkgUri, target.name, text.human, text.agent);
    return text;
  }

  private async save(target: Target, input: Layers): Promise<void> {
    const text = await this.write(target, input);
    if (this.current?.key === target.key) {
      this.loaded = text;
      this.live = text;
    }
    if (!this.panel) return;
    const [humanHtml, agentHtml] = await Promise.all([renderMarkdown(text.human), renderMarkdown(text.agent)]);
    void this.panel.webview.postMessage({
      type: 'saved',
      key: target.key,
      human: text.human,
      agent: text.agent,
      humanHtml,
      agentHtml,
      problems: problemsOf(text.agent),
      status: S.panelSavedAt(clock()),
    });
  }

  /** Whatever the current dependency still has unsaved goes to disk now. */
  private async flushCurrent(): Promise<void> {
    const target = this.current;
    if (!target || sameLayers(this.live, this.loaded)) return;
    const pending = this.live;
    try {
      this.loaded = await this.write(target, pending);
      this.live = this.loaded;
    } catch (e) {
      logError('notePanel.flush', e);
    }
  }

  /** Read the note from the notes file and push it in. */
  private async reload(): Promise<void> {
    const target = this.current;
    if (!target) return;
    // Clicking down a dependency list fires these faster than the reads
    // finish; only the newest one is allowed to publish its state.
    const token = ++this.loadToken;
    const notesUri = await resolveNotesFileFor(target.pkgUri);
    const notes = notesUri ? await this.store.getNotes(notesUri) : undefined;
    if (token !== this.loadToken || this.current !== target) return;
    const section = notes ? findSection(notes, target.name) : undefined;

    const layers = notes && section ? sectionLayers(notes, section) : undefined;
    this.loaded = layers ? { human: layers.human, agent: layers.agent } : EMPTY;
    this.live = this.loaded;
    await this.postState();
  }

  private async postState(): Promise<void> {
    const target = this.current;
    if (!target || !this.panel) return;
    const token = this.loadToken;
    const [humanHtml, agentHtml] = await Promise.all([renderMarkdown(this.live.human), renderMarkdown(this.live.agent)]);
    if (token !== this.loadToken || this.current !== target || !this.panel) return;
    const orgNotes = this.org.notesFor(target.pkgUri);
    void this.panel.webview.postMessage({
      type: 'load',
      key: target.key,
      name: target.name,
      depSection: target.depSection ?? '',
      hint: orgNotes
        ? S.panelTargetSuffix(S.orgNotesLabel(orgNotes.copy.orgName))
        : S.panelTargetSuffix(notesFileLabelForManifest(target.pkgUri)),
      // Org mode: only org admins change org notes; the server checks it too.
      readOnly: orgNotes !== undefined && !orgNotes.copy.canEdit,
      readOnlyHint: S.orgNoteReadOnly,
      human: this.live.human,
      agent: this.live.agent,
      humanHtml,
      agentHtml,
      problems: problemsOf(this.live.agent),
      org: this.orgPayload(target),
    });
  }

  private orgFor(target: Target) {
    const kind = manifestAdapterForPath(target.pkgUri.path)?.kind;
    const folder = kind ? this.org.forUri(target.pkgUri) : undefined;
    return kind && folder?.layer ? orgView({ ...folder, layer: folder.layer }, kind, target.name, clockAt) : undefined;
  }

  /** The allowlist result as the webview shows it: plain strings, set as text. */
  private orgPayload(target: Target): OrgPayload | null {
    const view = this.orgFor(target);
    if (!view) return null;
    return {
      tone: view.allowlist.tone,
      text: view.allowlist.result,
      detail: [
        S.orgAllowlistLine(view.allowlist.result, view.allowlist.mode),
        view.allowlist.reason && S.orgReason(view.allowlist.reason),
        view.allowlist.expires && S.orgExpires(view.allowlist.expires),
      ]
        .filter(Boolean)
        .join(' · '),
      openWeb: S.orgOpenWeb,
    };
  }

  /**
   * New org data from Depos. In org mode the note itself may have changed: it is
   * read again, unless the user has unsaved text in the panel. The allowlist result
   * is redrawn either way.
   */
  private async onOrgChange(): Promise<void> {
    const target = this.current;
    if (!target || !this.panel) return;
    if (this.org.notesFor(target.pkgUri) && sameLayers(this.live, this.loaded)) {
      await this.reload();
      return;
    }
    void this.panel.webview.postMessage({ type: 'org', key: target.key, org: this.orgPayload(target) });
  }
}

interface OrgPayload {
  tone: string;
  text: string;
  /** The badge's tooltip: the result with its mode, the reason and the expiry. */
  detail: string;
  openWeb: string;
}

function clockAt(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
