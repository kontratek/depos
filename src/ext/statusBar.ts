import * as vscode from 'vscode';
import { analyze } from '../core/analyze';
import { decorationsEnabled, isManifest, isNotesFile } from './config';
import { DIAG_SOURCE } from './diagnostics';
import { logError } from './log';
import { resolveNotesFileFor } from './resolveNotesFile';
import type { Store } from './state';
import { S } from './strings';

/**
 * Small status bar item:
 * - while a package.json is active: "$(book) 2/4" = documented/total
 *   dependencies, click → coverage quick pick;
 * - while the notes file is active and its agent notes have problems:
 *   "$(warning) 2", click → Problems panel.
 * Makes the extension's liveness visible at a glance (never a notification).
 */
export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: Store) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'depos.showCoverage';
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => void this.refresh()),
      vscode.languages.onDidChangeDiagnostics(() => void this.refresh()),
      store.onDidChange(() => void this.refresh()),
    );
    void this.refresh();
  }

  dispose(): void {
    this.item.dispose();
    for (const d of this.disposables) d.dispose();
  }

  /** Also called right after the toggle command flips marker state. */
  refreshNow(): void {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    try {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        this.item.hide();
        return;
      }
      if (isNotesFile(editor.document.uri)) {
        this.showProblems(editor.document.uri);
        return;
      }
      if (!isManifest(editor.document.uri)) {
        this.item.hide();
        return;
      }
      const deps = this.store.depsForDocument(editor.document);
      if (deps.length === 0) {
        this.item.hide();
        return;
      }
      const notesUri = await resolveNotesFileFor(editor.document.uri);
      const notes = notesUri ? await this.store.getNotes(notesUri) : undefined;
      const { documented } = analyze(deps, notes);
      const markersOff = !decorationsEnabled();
      // The toggle state must never be invisible, and escaping it must be one
      // click: a user who turned markers off (and forgot) would otherwise
      // think the extension is broken.
      this.item.text = `$(book) ${documented.length}/${deps.length}${markersOff ? ' $(eye-closed)' : ''}`;
      this.item.command = markersOff ? 'depos.toggleDecorations' : 'depos.showCoverage';
      this.item.backgroundColor = undefined;
      const base = notesUri
        ? `Depos: ${documented.length} of ${deps.length} dependencies documented in ${vscode.workspace.asRelativePath(notesUri)}.`
        : `Depos: no notes file yet — right-click a dependency to add the first note.`;
      this.item.tooltip = markersOff
        ? `${base}\n\nNote markers are OFF — CLICK to turn them back on.`
        : `${base} Click for coverage.`;
      this.item.show();
    } catch (e) {
      logError('statusBar.refresh', e);
    }
  }

  /** Warnings and errors Depos raised on the active notes file; quiet when there are none. */
  private showProblems(uri: vscode.Uri): void {
    const n = vscode.languages
      .getDiagnostics(uri)
      .filter((d) => d.source === DIAG_SOURCE && d.severity <= vscode.DiagnosticSeverity.Warning).length;
    if (n === 0) {
      this.item.hide();
      return;
    }
    this.item.text = `$(warning) ${n}`;
    this.item.tooltip = S.statusProblems(n);
    this.item.command = 'workbench.action.problems.focus';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.item.show();
  }
}
