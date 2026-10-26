import * as vscode from 'vscode';
import { inNotesDir, NOTES_DIR, type NotesDir } from '../core/template';

/**
 * `assets/AGENT-RULES.md` of the installed extension: the file Depos copies
 * into a workspace as `.depos/AGENT-RULES.md`. Hand-written for `.depos/` and
 * shipped as is; read once, on first use.
 */
const ASSET_PATH = ['assets', 'AGENT-RULES.md'];

let extensionRoot: vscode.Uri | undefined;
let text: Promise<string> | undefined;

/** Called from activate(). */
export function setExtensionRoot(uri: vscode.Uri): void {
  extensionRoot = uri;
  text = undefined;
}

async function readAsset(): Promise<string> {
  if (!extensionRoot) throw new Error('Depos: extension root not set');
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionRoot, ...ASSET_PATH));
  return new TextDecoder().decode(bytes).replace(/\r\n/g, '\n');
}

/** The rules as they read in a repository whose notes are under `dir`. */
export async function agentRulesText(dir: NotesDir = NOTES_DIR): Promise<string> {
  text ??= readAsset();
  return inNotesDir(await text, dir);
}
