import * as vscode from 'vscode';
import { findSection } from '../../core/parseNotes';
import {
  composeSectionBody,
  insertSectionIntoText,
  replaceHumanBodyInText,
  replaceSectionLayersInText,
} from '../../core/serialize';
import { newNotesFileContent } from '../../core/template';
import { manifestAdapterForPath } from '../../core/manifest';
import { agentRulesText } from '../agentRules';
import { agentRulesUriFor, clearResolverCache, creationTargetFor, resolveNotesFileFor } from '../resolveNotesFile';
import type { Store } from '../state';

/**
 * Org mode: a note is saved to the organization, never to the notes file. Returns the
 * notes uri when the package is in org mode and the note was handled, else undefined.
 * `agent` undefined keeps the agent fields as they are.
 */
export type OrgWriter = (pkgUri: vscode.Uri, name: string, human: string | undefined, agent: string | undefined) => Promise<vscode.Uri | undefined>;
let orgWriter: OrgWriter | undefined;

export function setOrgWriter(fn: OrgWriter): void {
  orgWriter = fn;
}

/** Write full text to the notes file. Through the open document only when it
 *  has UNSAVED edits (preserves them + undo); otherwise straight to disk —
 *  VS Code refreshes clean open editors by itself, and this avoids
 *  "File Modified Since" save races. */
export async function writeNotesText(notesUri: vscode.Uri, newText: string): Promise<void> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === notesUri.toString());
  if (open && open.isDirty) {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      open.lineAt(open.lineCount - 1).range.end,
    );
    edit.replace(notesUri, fullRange, newText);
    await vscode.workspace.applyEdit(edit);
    await open.save();
  } else {
    await vscode.workspace.fs.writeFile(notesUri, new TextEncoder().encode(newText));
  }
}

/**
 * `.pacmon/AGENT-RULES.md` at the workspace root: the rules agents read before
 * they write, a copy of the extension's own `assets/AGENT-RULES.md`. Created
 * alongside the first note; rewritten only when asked to (`overwrite`).
 */
export async function ensureAgentRules(
  anchor: vscode.Uri,
  opts: { overwrite?: boolean } = {},
): Promise<vscode.Uri | undefined> {
  const uri = agentRulesUriFor(anchor);
  if (!uri) return undefined;
  if (!opts.overwrite) {
    try {
      await vscode.workspace.fs.stat(uri);
      return uri;
    } catch {
      // not there yet — written below
    }
  }
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(await agentRulesText()));
  return uri;
}

/** Every write into `.pacmon/` also makes sure the agent rules are there: a
 *  repository can arrive with a notes file but no AGENT-RULES.md (written by hand,
 *  or cloned from a team that never ran the setup command). */
async function settle(store: Store, notesUri: vscode.Uri): Promise<vscode.Uri> {
  await ensureAgentRules(notesUri);
  store.invalidate(notesUri);
  return notesUri;
}

interface Located {
  notesUri: vscode.Uri;
  /** Current text, or undefined when the file does not exist yet. */
  text: string | undefined;
}

async function locate(store: Store, pkgUri: vscode.Uri): Promise<Located> {
  const resolved = await resolveNotesFileFor(pkgUri);
  if (resolved && (await onDisk(resolved))) {
    const text = await store.getText(resolved);
    if (text !== undefined) return { notesUri: resolved, text };
  }
  if (resolved) clearResolverCache(); // the file went away under a stale cache entry
  return { notesUri: await creationTargetFor(pkgUri), text: undefined };
}

/** A real stat: the resolver's cache and a just-closed editor's document can
 *  both still vouch for a file that was deleted on disk. */
async function onDisk(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** First write next to a package.json: the `.pacmon/` directory and the notes
 *  file with its one section. The agent rules follow in `settle`. */
async function createNotesFile(
  notesUri: vscode.Uri,
  manifestUri: vscode.Uri,
  name: string,
  body: string,
): Promise<void> {
  const ecosystem = manifestAdapterForPath(manifestUri.path)?.kind;
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(notesUri, '..'));
  await vscode.workspace.fs.writeFile(
    notesUri,
    new TextEncoder().encode(newNotesFileContent('\n', name, body, ecosystem)),
  );
  clearResolverCache(); // the walk-up cache still says "nothing here"
}

/** Make sure the section exists. Never touches what is already there. */
export async function ensureSection(store: Store, pkgUri: vscode.Uri, name: string): Promise<vscode.Uri> {
  // Org mode: an org note exists only once it says something; nothing to prepare.
  const org = await orgWriter?.(pkgUri, name, undefined, undefined);
  if (org) return org;
  const { notesUri, text } = await locate(store, pkgUri);
  if (text === undefined) {
    await createNotesFile(notesUri, pkgUri, name, '');
  } else {
    const notes = await store.getNotes(notesUri);
    if (notes && findSection(notes, name)) return notesUri;
    await writeNotesText(notesUri, insertSectionIntoText(text, name, ''));
  }
  return settle(store, notesUri);
}

/**
 * Write the HUMAN text of a dependency's section; the agent block and anything
 * below it are left exactly as they are. Creates the notes file (with template)
 * when missing and inserts a new section at the sorted spot. Returns the notes
 * file uri.
 */
export async function upsertNote(
  store: Store,
  pkgUri: vscode.Uri,
  name: string,
  human: string,
): Promise<vscode.Uri> {
  const org = await orgWriter?.(pkgUri, name, human, undefined);
  if (org) return org;
  const { notesUri, text } = await locate(store, pkgUri);
  if (text === undefined) {
    await createNotesFile(notesUri, pkgUri, name, human);
  } else {
    const notes = await store.getNotes(notesUri);
    const next =
      notes && findSection(notes, name)
        ? replaceHumanBodyInText(text, name, human)
        : insertSectionIntoText(text, name, human);
    await writeNotesText(notesUri, next);
  }
  return settle(store, notesUri);
}

/** Write both layers at once (the note panel). A `### Generated` tail survives. */
export async function upsertNoteLayers(
  store: Store,
  pkgUri: vscode.Uri,
  name: string,
  human: string,
  agent: string,
): Promise<vscode.Uri> {
  const org = await orgWriter?.(pkgUri, name, human, agent);
  if (org) return org;
  const { notesUri, text } = await locate(store, pkgUri);
  if (text === undefined) {
    await createNotesFile(notesUri, pkgUri, name, composeSectionBody({ human, agent }));
  } else {
    const notes = await store.getNotes(notesUri);
    const next =
      notes && findSection(notes, name)
        ? replaceSectionLayersInText(text, name, { human, agent })
        : insertSectionIntoText(text, name, composeSectionBody({ human, agent }));
    await writeNotesText(notesUri, next);
  }
  return settle(store, notesUri);
}
