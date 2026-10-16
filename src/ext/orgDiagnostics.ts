import * as vscode from 'vscode';
import { isNotesFile } from './config';
import { S } from './strings';
import type { OrgContext } from './web/orgContext';

/**
 * In org mode (docs/format.md, "The organization layer"), a notice at the top of a
 * notes file in the editor's Problems: the editor does not read it while the folder's
 * notes are the org notes. Nothing at all while signed out of Depos.
 */
export class OrgDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('pacmon-org');
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly org: OrgContext) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.refresh(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.collection.delete(doc.uri)),
      org.onDidChange(() => this.refreshAll()),
    );
    this.refreshAll();
  }

  dispose(): void {
    this.collection.dispose();
    for (const d of this.disposables) d.dispose();
  }

  private refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) this.refresh(doc);
  }

  private refresh(doc: vscode.TextDocument): void {
    if (!isNotesFile(doc.uri)) return;
    const orgNotes = this.org.notesFor(doc.uri);
    if (!orgNotes) {
      this.collection.delete(doc.uri);
      return;
    }
    const d = new vscode.Diagnostic(doc.lineAt(0).range, S.orgModeNotesFile(orgNotes.copy.orgName), vscode.DiagnosticSeverity.Information);
    d.source = S.orgDiagSource;
    d.code = 'org-mode-notes-file';
    this.collection.set(doc.uri, [d]);
  }
}
