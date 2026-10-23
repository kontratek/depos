import * as vscode from 'vscode';
import { sectionLayers } from '../../core/layers';
import type { DepEntry } from '../../core/model';
import { normalizeName } from '../../core/match';
import { dependencyAtOffset } from '../../core/manifest';
import { findSection, parseNotes } from '../../core/parseNotes';
import { isManifest, noteEntryMode, notesFileLabelForManifest } from '../config';
import type { NotePanel } from '../notePanel';
import { defaultManifest, orgModeNotesUri, resolveNotesFileFor } from '../resolveNotesFile';
import type { Store } from '../state';
import { S } from '../strings';
import { ensureSection, upsertNote } from './writeNote';

async function pickDep(deps: readonly DepEntry[]): Promise<string | undefined> {
  const items = deps.map((d) => ({ label: d.displayName, description: d.scope, noteKey: d.noteKey }));
  const picked = await vscode.window.showQuickPick(items, { placeHolder: S.pickDepPlaceholder });
  return picked?.noteKey;
}

/** Reveal a section and put the cursor on its body line. */
function revealSection(editor: vscode.TextEditor, name: string): void {
  const model = parseNotes(editor.document.getText());
  const section = findSection(model, name);
  if (!section) return;
  const line = Math.min(section.bodyStart, editor.document.lineCount - 1);
  const pos = new vscode.Position(line, editor.document.lineAt(line).range.end.character);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

/**
 * Mode "peek": an embedded editor opens right below the dependency line,
 * showing the note's section in .pacmon/DEPENDENCY-NOTES.md — real multi-line
 * Markdown editing without leaving package.json. Esc closes, Ctrl+S saves.
 * Requires the package.json editor to be active.
 */
async function openPeek(
  store: Store,
  pkgEditor: vscode.TextEditor,
  pkgUri: vscode.Uri,
  name: string,
): Promise<boolean> {
  // Make sure the section exists so the peek lands on a real body line —
  // without touching a note that is already there.
  let notesUri = await resolveNotesFileFor(pkgUri);
  let notes = notesUri ? await store.getNotes(notesUri) : undefined;
  if (!notesUri || !notes || !findSection(notes, name)) {
    notesUri = await ensureSection(store, pkgUri, name);
    notes = await store.getNotes(notesUri);
  }
  const section = notes ? findSection(notes, name) : undefined;
  if (!notesUri || !notes || !section) return false;

  const deps = store.depsForDocument(pkgEditor.document);
  const dep = deps.find((d) => d.noteKey === name || normalizeName(d.noteKey) === normalizeName(name));
  if (!dep) return false;
  const anchor = pkgEditor.document.positionAt(dep.primaryRange.offset);

  const bodyLine = Math.min(section.bodyStart, Math.max(notes.lines.length - 1, 0));
  const target = new vscode.Location(notesUri, new vscode.Range(bodyLine, 0, bodyLine, 0));
  await vscode.commands.executeCommand('editor.action.peekLocations', pkgUri, anchor, [target], 'peek');
  vscode.window.setStatusBarMessage(S.peekHint(notesFileLabelForManifest(pkgUri)), 5000);
  return true;
}

async function openAt(notesUri: vscode.Uri, name: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(notesUri);
  const beside = noteEntryMode() === 'inputBeside';
  const ed = await vscode.window.showTextDocument(doc, {
    viewColumn: beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
  });
  revealSection(ed, name);
}

/**
 * Add or edit a dependency note.
 * - Default ("panel"): a note editor opens beside package.json.
 * - "peek": an embedded editor opens below the dependency line.
 * - "input"/"inputBeside": inline input box — new / single-line notes are
 *   written WITHOUT leaving package.json; empty input opens the file instead
 *   (longer notes); Esc cancels. Multi-line notes open the file at the section.
 * - `bodyArg` (programmatic/tests): skips every entry surface and writes directly.
 * Everything here edits the HUMAN text only; the agent block is never touched.
 */
export async function addOrEditNote(
  store: Store,
  panel: NotePanel,
  nameArg?: string,
  bodyArg?: string,
): Promise<void> {
  // 1) Determine the package.json context and the dependency name.
  const editor = vscode.window.activeTextEditor;
  let pkgUri: vscode.Uri | undefined;
  let name = nameArg;

  if (editor && isManifest(editor.document.uri)) {
    pkgUri = editor.document.uri;
    const deps = store.depsForDocument(editor.document);
    if (!name) {
      const offset = editor.document.offsetAt(editor.selection.active);
      name = dependencyAtOffset(deps, offset)?.noteKey ?? (await pickDep(deps));
    }
  } else {
    pkgUri = await defaultManifest(store);
    if (!pkgUri) {
      void vscode.window.showInformationMessage(
        vscode.workspace.workspaceFolders?.length ? S.noManifest : S.noWorkspace,
      );
      return;
    }
    if (!name) {
      const deps = await store.getDeps(pkgUri);
      name = await pickDep(deps);
    }
  }
  if (!name) return;
  const fileLabel = notesFileLabelForManifest(pkgUri);

  // Primary experience: the note editor beside package.json. Needs no anchor in
  // the editor, so it works from the command palette and coverage list too.
  // Org mode: the org note has no file to open, so the note editor is the only surface.
  if (bodyArg === undefined && (noteEntryMode() === 'panel' || orgModeNotesUri(pkgUri))) {
    await panel.show(pkgUri, name);
    return;
  }

  // Embedded peek editor below the line (unless a body was passed
  // programmatically, which always writes directly).
  if (bodyArg === undefined && noteEntryMode() === 'peek') {
    const pkgEditor =
      editor && editor.document.uri.toString() === pkgUri.toString() ? editor : undefined;
    if (pkgEditor && (await openPeek(store, pkgEditor, pkgUri, name))) return;
    // No package.json editor to anchor on → open the file at the section.
    const notesUri = await ensureSection(store, pkgUri, name);
    await openAt(notesUri, name);
    return;
  }

  // 2) Existing note?
  const resolved = await resolveNotesFileFor(pkgUri);
  const notes = resolved ? await store.getNotes(resolved) : undefined;
  const section = notes ? findSection(notes, name) : undefined;
  const existingHuman = notes && section ? sectionLayers(notes, section).human : undefined;

  if (existingHuman !== undefined && (existingHuman.includes('\n') || bodyArg !== undefined)) {
    if (bodyArg !== undefined) {
      await upsertNote(store, pkgUri, name, bodyArg);
      vscode.window.setStatusBarMessage(S.noteSaved(name, fileLabel), 4000);
      return;
    }
    await openAt(resolved!, name); // multi-line prose belongs in the editor
    return;
  }

  // 3) Inline input box (new note, or single-line edit pre-filled).
  let body = bodyArg;
  if (body === undefined) {
    body = await vscode.window.showInputBox({
      title: existingHuman !== undefined ? S.editNoteTitle(name) : S.addNoteTitle(name),
      prompt: S.addNotePrompt(fileLabel),
      placeHolder: existingHuman === undefined ? S.addNotePlaceholder : undefined,
      value: existingHuman,
    });
    if (body === undefined) return; // Esc — cancelled
  }

  if (body.trim() === '') {
    // Empty input = "I want to write more": make sure the section exists, open the file.
    const notesUri = await ensureSection(store, pkgUri, name);
    await openAt(notesUri, name);
    return;
  }

  await upsertNote(store, pkgUri, name, body);
  vscode.window.setStatusBarMessage(S.noteSaved(name, fileLabel), 4000);
}
