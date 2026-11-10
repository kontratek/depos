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
 * - An Allowed package whose installed version Depos says is denied, vulnerable, or
 *   past the version rule, the same way, naming the worst. Its version is the one of
 *   Depos's last scan, so an unpushed update does not clear it.
 * - In org mode, an error at the top of a notes file: it is no longer used and should
 *   be deleted.
 *
 * Nothing at all while signed out of Depos.
 */
export class OrgDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('depos-org');
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
    const d = new vscode.Diagnostic(doc.lineAt(0).range, S.orgModeNotesFile(orgNotes.copy.orgName), vscode.DiagnosticSeverity.Error);
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
    const diags: vscode.Diagnostic[] = [];
    for (const dep of this.store.depsForDocument(doc)) {
      const result = layer.result(kind, dep.noteKey);
      if (!result) continue;
      const violation = layer.versionViolation(kind, dep.noteKey);
      const version = violation === 'outdated' ? layer.version(kind, dep.noteKey) : undefined;
      let message: string;
      let code: string;
      if (result.kind === 'denied') {
        message = S.orgDenied(dep.displayName, orgName);
        code = 'org-denied';
      } else if (result.kind === 'unlisted') {
        message = S.orgUnlisted(dep.displayName, orgName);
        code = 'org-not-listed';
      } else if (violation === 'deniedVersion') {
        message = S.orgDeniedVersion(dep.displayName, orgName);
        code = 'org-denied-version';
      } else if (violation === 'vulnerable') {
        message = S.orgVulnerable(dep.displayName, orgName);
        code = 'org-vulnerable';
      } else if (version?.installedVersion && version.latestVersion && version.updateKind) {
        const behind = S.orgBehind[version.updateKind] ?? version.updateKind;
        message = S.orgOutdated(dep.displayName, orgName, version.installedVersion, version.latestVersion, behind);
        code = 'org-outdated';
      } else {
        continue;
      }
      const range = new vscode.Range(
        doc.positionAt(dep.primaryRange.offset),
        doc.positionAt(dep.primaryRange.offset + dep.primaryRange.length),
      );
      const severity = result.mode === 'enforce' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
      const d = new vscode.Diagnostic(range, message, severity);
      d.source = S.orgDiagSource;
      d.code = code;
      diags.push(d);
    }
    this.collection.set(doc.uri, diags);
  }
}
