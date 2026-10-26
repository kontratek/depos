import * as vscode from 'vscode';
import { affectsSetting, clearSetting, inspectSetting, updateSetting } from './settings';
import { analyze } from '../core/analyze';
import {
  ALL_NOTE_BUTTONS,
  isManifest,
  type NoteButton,
  decorationsSetting,
  inlineSource,
  noteButtonEnabled,
  noteEntryMode,
  notesFileLabel,
} from './config';
import { logError } from './log';
import { defaultManifest } from './resolveNotesFile';
import { resolveNotesFileFor } from './resolveNotesFile';
import { choiceValues, writeScope } from './settingChoices';
import { renderHtml } from './settingsViewHtml';
import type { Store } from './state';
import { S } from './strings';
import type { WebConnection } from './web/webConnection';

const VIEW_ID = 'depos.settings';

/** The settings this view owns: what it writes, and what "Reset to Defaults" clears. */
const VIEW_KEYS = ['noteButtons', 'noteEntry', 'decorations', 'inlineSource'] as const;

interface Incoming {
  type: 'ready' | 'setButtons' | 'setChoice' | 'command';
  value?: string[] | string;
  key?: string;
  id?: string;
}

/** Commands the view may run — the id off the wire is never trusted. */
const ALLOWED_COMMANDS = new Set([
  'depos.openNotesFile',
  'depos.openManifest',
  'depos.showCoverage',
  'depos.normalizeNotesFile',
  'depos.setupAiInstructions',
  'depos.signIn',
  'depos.showConnection',
  'depos.signOut',
]);

/**
 * The Depos view in the activity bar: turn the in-editor affordances on and
 * off, pick where a note is written, and reach the four commands — without
 * hunting through Settings.
 *
 * A webview rather than a tree, because the point is to SHOW what each option
 * does to a package.json line; a tree gives you a label, a description and an
 * icon and nothing else. It stays offline by construction all the same:
 * `localResourceRoots: []`, CSP `default-src 'none'`, markup bundled with the
 * extension.
 */
export class SettingsView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** Last package.json seen in an editor — so the coverage list does not go
   *  blank the moment you switch to DEPENDENCY-NOTES.md or anything else. */
  private lastPkg: vscode.Uri | undefined;

  constructor(
    private readonly store: Store,
    private readonly web: WebConnection,
  ) {
    this.disposables.push(
      web.onDidChange(() => void this.postState()),
      vscode.window.registerWebviewViewProvider(VIEW_ID, this),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (affectsSetting(e)) void this.postState();
      }),
      store.onDidChange(() => void this.postState()),
      vscode.window.onDidChangeActiveTextEditor(() => void this.postState()),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = renderHtml();
    view.webview.onDidReceiveMessage(
      (m: Incoming) => void this.onMessage(m),
      undefined,
      this.disposables,
    );
    view.onDidDispose(
      () => {
        this.view = undefined;
      },
      undefined,
      this.disposables,
    );
  }

  private async onMessage(m: Incoming): Promise<void> {
    try {
      switch (m.type) {
        case 'ready':
          await this.postState();
          break;
        case 'setButtons': {
          // Only ids we know, in the canonical order, so the written value
          // reads the same however it was toggled.
          const asked = new Set(Array.isArray(m.value) ? m.value : []);
          await this.write('noteButtons', ALL_NOTE_BUTTONS.filter((b) => asked.has(b)));
          await this.revealManifest();
          break;
        }
        case 'setChoice': {
          // Only the groups the view draws, only the values it offers.
          const key = m.key;
          if (typeof key !== 'string') return;
          const allowed = choiceValues(key);
          if (!allowed || typeof m.value !== 'string' || !allowed.includes(m.value)) return;
          await this.write(key, m.value);
          await this.revealManifest();
          break;
        }
        case 'command': {
          if (typeof m.id !== 'string' || !ALLOWED_COMMANDS.has(m.id)) return;
          await vscode.commands.executeCommand(m.id);
          break;
        }
      }
    } catch (e) {
      logError(`settingsView.${m.type}`, e);
    }
  }

  /**
   * Every setting in this view changes how package.json looks. Showing the
   * result is the point, so bring the manifest into view when none is on
   * screen — as a preview tab, and without taking focus, so a run of toggles
   * stays a run of toggles.
   */
  private async revealManifest(): Promise<void> {
    if (vscode.window.visibleTextEditors.some((e) => isManifest(e.document.uri))) return;
    const pkgUri = this.lastPkg ?? (await defaultManifest(this.store));
    if (!pkgUri) return;
    const doc = await vscode.workspace.openTextDocument(pkgUri);
    await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: true });
  }

  /** Where the value already lives, never blindly the user settings — see
   *  `writeScope`. User settings otherwise, so a preference set here follows
   *  you from project to project. */
  private async write(key: string, value: unknown): Promise<void> {
    // Either name counts: a `pacmon.` value in the workspace is outranked only
    // by a `depos.` value in the workspace.
    const target =
      writeScope(inspectSetting(key)) === 'workspace'
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await updateSetting(key, value, target);
  }

  private async postState(): Promise<void> {
    if (!this.view) return;
    const on: NoteButton[] = ALL_NOTE_BUTTONS.filter(noteButtonEnabled);
    void this.view.webview.postMessage({
      type: 'state',
      noteButtons: on,
      noteEntry: noteEntryMode(),
      decorations: decorationsSetting(),
      inlineSource: inlineSource(),
      count: S.viewTargetsCount(on.length, ALL_NOTE_BUTTONS.length),
      markersLede: S.viewMarkersHelp(notesFileLabel()),
      otherEntry: S.viewOtherEntry(noteEntryMode()),
      openNotesLabel: S.viewOpenNotes(notesFileLabel()),
      coverage: await this.coverage(),
      web: await this.webState(),
    });
  }

  /** Sign-in state for the Depos section. Settings and secret storage only: no request. */
  private async webState(): Promise<{ signedIn: boolean; text: string }> {
    const status = await this.web.status();
    if (status.invalid) return { signedIn: false, text: S.viewWebInvalidUrl };
    if (status.signedIn && status.host) return { signedIn: true, text: S.viewWebSignedIn(status.host) };
    return { signedIn: false, text: S.viewWebSignedOut(status.host) };
  }

  /**
   * How much of the package.json in play is documented. Numbers only — which
   * dependencies have notes is already visible on the manifest itself.
   */
  private async coverage(): Promise<{
    ratio: string;
    percent: number;
    pkgLabel: string;
    status: string;
  }> {
    const empty = (status: string): {
      ratio: string;
      percent: number;
      pkgLabel: string;
      status: string;
    } => ({ ratio: '', percent: 0, pkgLabel: '', status });

    const active = vscode.window.activeTextEditor?.document.uri;
    if (active && isManifest(active)) this.lastPkg = active;
    const pkgUri = this.lastPkg ?? (await defaultManifest(this.store));
    if (!pkgUri) return empty(S.viewCoverageEmpty);

    const deps = await this.store.getDeps(pkgUri);
    if (deps.length === 0) return empty(S.viewCoverageNoDeps);

    const notesUri = await resolveNotesFileFor(pkgUri);
    const notes = notesUri ? await this.store.getNotes(notesUri) : undefined;
    const { documented, undocumented } = analyze(deps, notes);
    return {
      ratio: S.viewCoverageRatio(documented.length, deps.length),
      percent: Math.round((documented.length / deps.length) * 100),
      pkgLabel: vscode.workspace.asRelativePath(pkgUri),
      status:
        undocumented.length === 0
          ? S.viewCoverageAllDone
          : S.viewCoverageMissing(undocumented.length),
    };
  }
}

/**
 * View title action: drop every setting this view controls back to defaults —
 * in BOTH targets. Clearing only the user value left whatever "Toggle Note
 * Markers" had written to the workspace standing after a reset, which is the
 * one thing a reset must not do.
 */
export async function resetView(): Promise<void> {
  // Writing workspace settings at all needs a folder open.
  const inWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
  for (const key of VIEW_KEYS) {
    // Under both names, or a `pacmon.` value from before the rename would stand.
    await clearSetting(key, vscode.ConfigurationTarget.Global);
    if (inWorkspace) await clearSetting(key, vscode.ConfigurationTarget.Workspace);
  }
}

/** View title action: the full settings UI, for everything not shown here. The id
 *  comes from the running extension, so a publisher change cannot leave this
 *  filter pointing at a name that no longer exists. */
export async function openSettings(extensionId: string): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`);
}
