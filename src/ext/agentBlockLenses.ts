import * as vscode from 'vscode';
import { isAgentProblem } from '../core/fixes';
import { layerRanges } from '../core/layers';
import { lintNotes } from '../core/lint';
import { parseNotes } from '../core/parseNotes';
import { NOTES_GLOB, isNotesFile } from './config';
import type { Store } from './state';
import { S } from './strings';

/**
 * One code lens above each `### Agent notes` heading that has problems:
 * "⚠ 2 problems in this block — fix all". Nothing is drawn on a clean block,
 * so the notes file stays quiet until something is actually wrong.
 */
export class AgentBlockLenses implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(store: Store) {
    this.disposables.push(
      vscode.languages.registerCodeLensProvider({ pattern: NOTES_GLOB }, this),
      store.onDidChange(() => this.emitter.fire()),
      vscode.languages.onDidChangeDiagnostics(() => this.emitter.fire()),
    );
  }

  dispose(): void {
    this.emitter.dispose();
    for (const d of this.disposables) d.dispose();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!isNotesFile(doc.uri)) return [];
    const model = parseNotes(doc.getText());
    const problems = lintNotes(model, []).filter(isAgentProblem);
    if (problems.length === 0) return [];

    const lenses: vscode.CodeLens[] = [];
    for (const section of model.sections) {
      const r = layerRanges(section);
      if (section.agentHeadingLine === undefined || r.agentStart === undefined || r.agentEnd === undefined) continue;
      const mine = problems.filter((p) => p.line >= r.agentStart! && p.line < r.agentEnd!);
      if (mine.length === 0) continue;
      const fixable = mine.filter((p) => p.kind === 'unknownAgentKey').length;
      const range = new vscode.Range(section.agentHeadingLine, 0, section.agentHeadingLine, 0);
      const command: vscode.Command =
        fixable > 0
          ? { command: 'depos.fixAgentNotes', title: S.lensFixable(mine.length, fixable), arguments: [doc.uri] }
          : { command: 'workbench.action.problems.focus', title: S.lensProblems(mine.length) };
      lenses.push(new vscode.CodeLens(range, command));
    }
    return lenses;
  }
}
