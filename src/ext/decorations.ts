import * as vscode from 'vscode';
import { affectsSetting } from './settings';
import { analyze } from '../core/analyze';
import { normalizeNameForEcosystem } from '../core/match';
import { notePreview, sectionLayers } from '../core/layers';
import { decorationsEnabled, decorationsSetting, inlineSource, isManifest } from './config';
import { logError } from './log';
import { resolveNotesFileFor } from './resolveNotesFile';
import type { Store } from './state';


/**
 * Subtle end-of-line marker on package.json lines that HAVE a note.
 * Lines without notes are never decorated (quiet by default).
 */
export class DecorationController implements vscode.Disposable {
  private readonly type: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly store: Store) {
    this.type = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('descriptionForeground'),
        fontStyle: 'italic',
        margin: '0 0 0 1.5em',
      },
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshVisible()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshVisible()),
      store.onDidChange(() => this.refreshVisible()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (affectsSetting(e)) this.refreshVisible();
      }),
    );
    this.refreshVisible();
  }

  dispose(): void {
    this.type.dispose();
    for (const d of this.disposables) d.dispose();
  }

  refreshVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      void this.refreshEditor(editor);
    }
  }

  private async refreshEditor(editor: vscode.TextEditor): Promise<void> {
    try {
      await this.doRefreshEditor(editor);
    } catch (e) {
      logError('decorations.refreshEditor', e);
    }
  }

  private async doRefreshEditor(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    if (!isManifest(doc.uri)) return;
    if (!decorationsEnabled()) {
      editor.setDecorations(this.type, []);
      return;
    }
    const deps = this.store.depsForDocument(doc);
    if (deps.length === 0) {
      editor.setDecorations(this.type, []);
      return;
    }
    const notesUri = await resolveNotesFileFor(doc.uri);
    const notes = notesUri ? await this.store.getNotes(notesUri) : undefined;
    if (!notes) {
      editor.setDecorations(this.type, []);
      return;
    }
    const { documented, byDep } = analyze(deps, notes);
    const style = decorationsSetting();
    const source = inlineSource();
    const options: vscode.DecorationOptions[] = [];
    for (const dep of documented) {
      const line = doc.positionAt(dep.primaryRange.offset).line;
      const end = doc.lineAt(line).range.end;
      const section = byDep.get(normalizeNameForEcosystem(dep.noteKey, notes.frontmatter?.ecosystem));
      const text =
        style === 'preview' && section ? ` ▪ ${notePreview(sectionLayers(notes, section), source)}` : ' ▪ note';
      options.push({
        range: new vscode.Range(end, end),
        renderOptions: { after: { contentText: text } },
      });
    }
    editor.setDecorations(this.type, options);
  }
}
