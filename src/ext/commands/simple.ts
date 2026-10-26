import * as vscode from 'vscode';
import { normalizeText } from '../../core/serialize';
import { notesDirOf } from '../../core/template';
import { isManifest, isNotesFile, notesFileLabel, toggleDecorationsState } from '../config';
import { defaultManifest, manifestsForNotes, notesUriIn, resolveNotesFileFor } from '../resolveNotesFile';
import type { Store } from '../state';
import { S } from '../strings';

async function findNotesUri(store: Store): Promise<vscode.Uri | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (editor && isNotesFile(editor.document.uri)) return editor.document.uri;
  if (editor && isManifest(editor.document.uri)) {
    const resolved = await resolveNotesFileFor(editor.document.uri);
    if (resolved) return resolved;
  }
  const pkg = await defaultManifest(store);
  if (pkg) {
    const resolved = await resolveNotesFileFor(pkg);
    if (resolved) return resolved;
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const candidate = notesUriIn(folder.uri);
    if ((await store.getText(candidate)) !== undefined) return candidate;
  }
  return undefined;
}

export async function openNotesFile(store: Store): Promise<void> {
  const uri = await findNotesUri(store);
  if (!uri) {
    void vscode.window.showInformationMessage(S.noNotesFile(notesFileLabel()));
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
}

/** Open the package.json the notes belong to — the mirror of openNotesFile. */
export async function openManifest(store: Store): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor && isManifest(editor.document.uri)) {
    await vscode.window.showTextDocument(editor.document);
    return;
  }
  let fromNotes: vscode.Uri | undefined;
  if (editor && isNotesFile(editor.document.uri)) {
    for (const candidate of await manifestsForNotes(editor.document.uri)) {
      if ((await store.getText(candidate)) !== undefined) {
        fromNotes = candidate;
        break;
      }
    }
  }
  const pkg = fromNotes ?? await defaultManifest(store);
  if (!pkg) {
    void vscode.window.showInformationMessage(
      vscode.workspace.workspaceFolders?.length ? S.noManifest : S.noWorkspace,
    );
    return;
  }
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(pkg));
}

/** Backward-compatible export for callers of the old npm-specific command. */
export const openPackageJson = openManifest;

export async function normalizeNotesFile(store: Store): Promise<void> {
  const uri = await findNotesUri(store);
  if (!uri) {
    void vscode.window.showInformationMessage(S.noNotesFile(notesFileLabel()));
    return;
  }
  const doc = await vscode.workspace.openTextDocument(uri);
  const original = doc.getText();
  const canonical = normalizeText(original, notesDirOf(uri.path));
  if (canonical === original) {
    vscode.window.setStatusBarMessage(S.alreadyCanonical(notesFileLabel()), 3000);
    return;
  }
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
  edit.replace(uri, fullRange, canonical);
  await vscode.workspace.applyEdit(edit);
  await vscode.window.showTextDocument(doc, { preserveFocus: true, preview: false });
  vscode.window.setStatusBarMessage(S.formatted(notesFileLabel()), 3000);
}

export async function toggleDecorations(context: vscode.ExtensionContext, refresh: () => void): Promise<void> {
  const on = await toggleDecorationsState(context);
  refresh();
  vscode.window.setStatusBarMessage(on ? S.decorationsOn : S.decorationsOff, 3000);
}
