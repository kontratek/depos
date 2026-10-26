import * as vscode from 'vscode';
import { agentRulesRelPath, upsertAiInstructions } from '../../core/template';
import { notesDirForFolder } from '../resolveNotesFile';
import type { Store } from '../state';
import { S } from '../strings';
import { ensureAgentRules } from './writeNote';

/** The instruction files agents read, which get the pointer block. */
export const AI_INSTRUCTION_TARGETS = ['AGENTS.md', 'CLAUDE.md', '.cursor/rules/dependency-notes.md', '.github/copilot-instructions.md'];
const TARGETS = AI_INSTRUCTION_TARGETS;

interface TargetItem extends vscode.QuickPickItem {
  rel: string;
}

/**
 * Two writes: `.depos/AGENT-RULES.md` (`.pacmon/` in a repository not moved yet)
 * is rewritten from the extension's copy (the rules and the field list, owned
 * by Depos), and the instruction files agents already read get a short pointer
 * to it between markers. `targetsArg` names those files without the picker
 * (tests, scripts); only the known ones are accepted.
 */
export async function setupAiInstructions(store: Store, targetsArg?: readonly string[]): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showInformationMessage(S.noWorkspace);
    return;
  }

  let targets: string[];
  if (targetsArg) {
    targets = targetsArg.filter((t) => TARGETS.includes(t));
  } else {
    const items: TargetItem[] = [];
    for (const rel of TARGETS) {
      const uri = vscode.Uri.joinPath(folder.uri, ...rel.split('/'));
      const exists = (await store.getText(uri)) !== undefined;
      items.push({ label: rel, description: exists ? S.willUpdate : S.willCreate, rel, picked: exists || rel === 'AGENTS.md' });
    }
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: S.aiSetupPickPlaceholder,
    });
    if (!picked || picked.length === 0) return;
    targets = picked.map((p) => p.rel);
  }

  const notesDir = await notesDirForFolder(folder.uri);
  await ensureAgentRules(folder.uri, { overwrite: true });
  const written: string[] = [agentRulesRelPath(notesDir)];
  for (const rel of targets) {
    const parts = rel.split('/');
    const uri = vscode.Uri.joinPath(folder.uri, ...parts);
    if (parts.length > 1) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, ...parts.slice(0, -1)));
    }
    const existing = (await store.getText(uri)) ?? '';
    const updated = upsertAiInstructions(existing, notesDir);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
    written.push(rel);
  }
  vscode.window.setStatusBarMessage(S.aiSetupDone(written.join(', ')), 4000);
}
