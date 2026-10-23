import * as vscode from 'vscode';
import { manifestAdapterForPath } from '../core/manifest';
import { isManifest, isNotesFile } from './config';
import type { Store } from './state';
import { S } from './strings';
import type { OrgContext } from './web/orgContext';

/**
 * What org data says in the editor's Problems (docs/format.md, "The organization layer"):
 *
 * - Allowlist results at the manifest line: Denied and Not listed only, a warning in
 *   Audit and an error in Enforce. Allowed and not-audited packages stay quiet. The
 *   result is looked up locally, so an edit that is not pushed yet is judged at once.
 * - In org mode, a notice at the top of a notes file: the editor does not read it.
 *
 * Nothing at all while signed out of Depos.
 */
export class OrgDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('pacmon-org');
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly store: Store,
    private readonly org: OrgContext,
  ) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.refresh(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.collection.delete(doc.uri)),
      store.onDidChange(() => this.refreshAll()),
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
    if (isNotesFile(doc.uri)) this.refreshNotesFile(doc);
    else if (isManifest(doc.uri)) this.refreshManifest(doc);
  }

  private refreshNotesFile(doc: vscode.TextDocument): void {
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

  private refreshManifest(doc: vscode.TextDocument): void {
    const kind = manifestAdapterForPath(doc.uri.path)?.kind;
    const layer = this.org.forUri(doc.uri)?.layer;
    if (!kind || !layer) {
      this.collection.delete(doc.uri);
      return;
    }
    const orgName = layer.data.organization.name;
    const now = Date.now();
    const diags: vscode.Diagnostic[] = [];
    for (const dep of this.store.depsForDocument(doc)) {
      const result = layer.result(kind, dep.noteKey, now);
      if (result?.kind !== 'denied' && result?.kind !== 'unlisted') continue;
      const range = new vscode.Range(
        doc.positionAt(dep.primaryRange.offset),
        doc.positionAt(dep.primaryRange.offset + dep.primaryRange.length),
      );
      const message = result.kind === 'denied'
        ? S.orgDenied(dep.displayName, orgName, result.reason)
        : S.orgUnlisted(dep.displayName, orgName);
      const severity = result.mode === 'enforce' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
      const d = new vscode.Diagnostic(range, message, severity);
      d.source = S.orgDiagSource;
      d.code = result.kind === 'denied' ? 'org-denied' : 'org-not-listed';
      diags.push(d);
    }
    this.collection.set(doc.uri, diags);
  }
}
