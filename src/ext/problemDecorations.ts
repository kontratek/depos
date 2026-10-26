import * as vscode from 'vscode';
import { isNotesFile } from './config';
import { DIAG_SOURCE } from './diagnostics';
import { logError } from './log';
import { S } from './strings';

const MAX_INLINE = 140;

/**
 * The message of each Depos diagnostic, written at the end of its line in the
 * notes file (the way Error Lens does it), with a faint tint on the line.
 * A squiggle alone is easy to miss; the text is not. Only our diagnostics,
 * only in `.pacmon/DEPENDENCY-NOTES.md` — and all of them warnings, so one colour.
 */
export class ProblemDecorations implements vscode.Disposable {
  private readonly type = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: 'rgba(255, 200, 0, 0.07)',
    after: {
      margin: '0 0 0 1.5em',
      color: new vscode.ThemeColor('editorWarning.foreground'),
      fontStyle: 'italic',
    },
  });
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics(() => this.refresh()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
    );
    this.refresh();
  }

  dispose(): void {
    this.type.dispose();
    for (const d of this.disposables) d.dispose();
  }

  private refresh(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      try {
        this.decorate(editor);
      } catch (e) {
        logError('problemDecorations.refresh', e);
      }
    }
  }

  private decorate(editor: vscode.TextEditor): void {
    if (!isNotesFile(editor.document.uri)) return;
    const mine = vscode.languages.getDiagnostics(editor.document.uri).filter((d) => d.source === DIAG_SOURCE);
    // One message per line: the first reported.
    const perLine = new Map<number, vscode.Diagnostic>();
    for (const d of mine) {
      const line = d.range.start.line;
      if (!perLine.has(line)) perLine.set(line, d);
    }
    const options: vscode.DecorationOptions[] = [];
    for (const [line, d] of perLine) {
      if (line >= editor.document.lineCount) continue;
      const end = editor.document.lineAt(line).range.end;
      const text = d.message.length > MAX_INLINE ? `${d.message.slice(0, MAX_INLINE - 1)}…` : d.message;
      options.push({
        range: new vscode.Range(end, end),
        renderOptions: { after: { contentText: `${S.inlineProblemPrefix}${text}` } },
      });
    }
    editor.setDecorations(this.type, options);
  }
}
