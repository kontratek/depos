import * as vscode from 'vscode';
import {
  AGENT_RULES_FILE_NAME,
  LEGACY_NOTES_DIR,
  NOTES_DIR,
  NOTES_FILE_NAME,
  notesDirOf,
  upsertAiInstructions,
} from '../../core/template';
import { clearResolverCache, DISCOVERY_EXCLUDE } from '../resolveNotesFile';
import type { Store } from '../state';
import { S } from '../strings';
import { AI_INSTRUCTION_TARGETS } from './aiSetup';
import { ensureAgentRules, writeNotesText } from './writeNote';

export const MOVE_NOTES_COMMAND = 'depos.moveNotes';

/** The header comment of a notes file names the AGENT-RULES.md beside it (template.ts). */
const LEGACY_RULES_REF = `rules in ${LEGACY_NOTES_DIR}/${AGENT_RULES_FILE_NAME}`;
const CURRENT_RULES_REF = `rules in ${NOTES_DIR}/${AGENT_RULES_FILE_NAME}`;

const SUGGESTED_KEY = 'depos.moveNotesSuggested';
let memento: vscode.Memento | undefined;

/** Called from activate(): the suggestion below is made once per workspace. */
export function setMoveNotesState(workspaceState: vscode.Memento): void {
  memento = workspaceState;
}

/**
 * Once per workspace, when a notes file under `.pacmon/` is open: the move
 * command, offered. Never run without asking — a teammate on a version from
 * before Depos reads `.pacmon/` only.
 */
export function suggestMoveNotes(notesUri: vscode.Uri): void {
  if (!memento || notesDirOf(notesUri.path) !== LEGACY_NOTES_DIR) return;
  if (memento.get<boolean>(SUGGESTED_KEY)) return;
  void memento.update(SUGGESTED_KEY, true);
  void vscode.window.showInformationMessage(S.moveNotesSuggest, S.moveNotesAction).then((choice) => {
    if (choice === S.moveNotesAction) void vscode.commands.executeCommand(MOVE_NOTES_COMMAND);
  });
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** Every `.pacmon/` directory in the workspace that holds anything. */
async function legacyNotesDirs(): Promise<vscode.Uri[]> {
  const dirs = new Map<string, vscode.Uri>();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, `**/${LEGACY_NOTES_DIR}/**`),
      DISCOVERY_EXCLUDE,
    );
    for (const file of files) {
      const at = file.path.lastIndexOf(`/${LEGACY_NOTES_DIR}/`);
      const dir = file.with({ path: file.path.slice(0, at + LEGACY_NOTES_DIR.length + 1) });
      dirs.set(dir.toString(), dir);
    }
  }
  return [...dirs.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * "Move Notes to .depos/": every `.pacmon/` directory of the workspace — the
 * notes' directory from before Pacmon became Depos — renamed to `.depos/` at
 * once, and what points into them brought along: the header comment of each
 * notes file, AGENT-RULES.md, and the pointer block of the instruction files.
 * One workspace edit, so open editors follow and Undo puts the directories back.
 * `confirmed` skips the question, for programmatic callers (tests, scripts).
 */
export async function moveNotesToDepos(store: Store, confirmed = false): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length) {
    void vscode.window.showInformationMessage(S.noWorkspace);
    return;
  }
  const legacy = await legacyNotesDirs();
  if (legacy.length === 0) {
    void vscode.window.showInformationMessage(S.moveNotesNone);
    return;
  }
  const conflicts: vscode.Uri[] = [];
  for (const dir of legacy) {
    if (await exists(vscode.Uri.joinPath(dir, '..', NOTES_DIR))) conflicts.push(dir);
  }
  if (conflicts.length > 0) {
    void vscode.window.showWarningMessage(
      S.moveNotesConflict(conflicts.map((dir) => vscode.workspace.asRelativePath(dir, false)).join(', ')),
    );
    return;
  }
  if (!confirmed) {
    const choice = await vscode.window.showWarningMessage(S.moveNotesConfirm(legacy.length), { modal: true }, S.moveNotesAction);
    if (choice !== S.moveNotesAction) return;
  }

  const edit = new vscode.WorkspaceEdit();
  const moved: vscode.Uri[] = [];
  for (const dir of legacy) {
    const target = vscode.Uri.joinPath(dir, '..', NOTES_DIR);
    edit.renameFile(dir, target, { overwrite: false });
    moved.push(target);
  }
  if (!(await vscode.workspace.applyEdit(edit))) return;
  clearResolverCache();

  // The header comment of each notes file now names `.depos/AGENT-RULES.md`.
  for (const dir of moved) {
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(dir, `**/${NOTES_FILE_NAME}`));
    for (const file of files) {
      const text = await readText(file);
      if (text !== undefined && text.includes(LEGACY_RULES_REF)) {
        await writeNotesText(file, text.replace(LEGACY_RULES_REF, CURRENT_RULES_REF));
      }
    }
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    // The rules themselves, rewritten for `.depos/` where the root had a copy.
    if (await exists(vscode.Uri.joinPath(folder.uri, NOTES_DIR, AGENT_RULES_FILE_NAME))) {
      await ensureAgentRules(folder.uri, { overwrite: true });
    }
    // The pointer block, in the instruction files that have one.
    for (const rel of AI_INSTRUCTION_TARGETS) {
      const uri = vscode.Uri.joinPath(folder.uri, ...rel.split('/'));
      const text = await readText(uri);
      if (text === undefined || !/<!-- (?:depos|pacmon):/.test(text)) continue;
      const updated = upsertAiInstructions(text, NOTES_DIR);
      if (updated !== text) await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
    }
  }
  store.invalidateAll();
  vscode.window.setStatusBarMessage(S.moveNotesDone(legacy.length), 5000);
}
