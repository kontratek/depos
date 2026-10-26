import * as vscode from 'vscode';
import { INLINE_SOURCES, type InlineSource } from '../core/layers';
import { NOTES_DIR, NOTES_DIRS, NOTES_REL_PATH, type NotesDir } from '../core/template';
import { DEFAULT_NOTE_BUTTONS, type NoteButton } from './noteButtonIds';
import { setting, updateSetting } from './settings';
import {
  MANIFEST_ADAPTERS,
  manifestAdapterForKind,
  manifestAdapterForPath,
  notesKindOfPath,
  notesRelativePathIn,
} from '../core/manifest';
import type { ManifestKind } from '../core/model';

export { AGENT_RULES_REL_PATH, NOTES_REL_PATH } from '../core/template';

/** Where the notes live, wherever a manifest sits: under `.depos/`, or under
 *  `.pacmon/` in a repository not moved yet. The layout is part of the format,
 *  so it is not a setting. */
const NOTES_GLOB_PATHS = MANIFEST_ADAPTERS.map((adapter) => adapter.notesRelativePath.slice(NOTES_DIR.length + 1));
export const NOTES_GLOB = `**/{${NOTES_DIRS.join(',')}}/{${NOTES_GLOB_PATHS.join(',')}}`;

/** How messages name the notes file. */
export function notesFileLabel(kind: ManifestKind = 'npm'): string {
  return manifestAdapterForKind(kind).notesRelativePath;
}

/** `dir`: the directory of the manifest's notes (`notesDirForManifest`). */
export function notesFileLabelForManifest(uri: vscode.Uri, dir: NotesDir = NOTES_DIR): string {
  const adapter = manifestAdapterForPath(uri.path);
  return adapter ? notesRelativePathIn(adapter, dir) : NOTES_REL_PATH;
}

export const MANIFEST_SELECTOR: vscode.DocumentSelector = MANIFEST_ADAPTERS.flatMap((adapter) =>
  adapter.discoveryGlobs.map((pattern) => ({ pattern })),
);

/** Which layer of a note feeds the end-of-line preview and leads the hover. */
export function inlineSource(): InlineSource {
  const v = setting<string>('inlineSource', 'human-first');
  return (INLINE_SOURCES as readonly string[]).includes(v) ? (v as InlineSource) : 'human-first';
}

export type DecorationStyle = 'preview' | 'badge' | 'off';

export function decorationsSetting(): DecorationStyle {
  return setting<DecorationStyle>('decorations', 'preview');
}

export function monorepoMode(): 'nearest' | 'rootOnly' {
  return setting<'nearest' | 'rootOnly'>('monorepo', 'nearest');
}

export type NoteEntryMode = 'panel' | 'peek' | 'input' | 'inputBeside' | 'comments';

export function noteEntryMode(): NoteEntryMode {
  return setting<NoteEntryMode>('noteEntry', 'panel');
}

/** Clickable ways into a note from package.json (see noteButtons.ts). */
export { ALL_NOTE_BUTTONS, type NoteButton } from './noteButtonIds';

export function noteButtonEnabled(which: NoteButton): boolean {
  return setting<NoteButton[]>('noteButtons', [...DEFAULT_NOTE_BUTTONS]).includes(which);
}

/** Remembers the style to come back to when markers are toggled off again.
 *  Workspace state, so its Pacmon-era key stays: renaming it would forget. */
const LAST_STYLE_KEY = 'pacmon.lastDecorationStyle';

/**
 * The setting is the only source of truth. It used to be outranked by a hidden
 * per-workspace flag, which meant choosing "off" could do nothing at all.
 */
export function decorationsEnabled(): boolean {
  return decorationsSetting() !== 'off';
}

/** "Toggle Note Markers": flips the setting for THIS workspace, so the choice
 *  stays visible in settings instead of hiding in workspace state. */
export async function toggleDecorationsState(context: vscode.ExtensionContext): Promise<boolean> {
  const style = decorationsSetting();
  if (style !== 'off') {
    await context.workspaceState.update(LAST_STYLE_KEY, style);
    await updateSetting('decorations', 'off', vscode.ConfigurationTarget.Workspace);
    return false;
  }
  const restore = context.workspaceState.get<DecorationStyle>(LAST_STYLE_KEY) ?? 'preview';
  await updateSetting('decorations', restore, vscode.ConfigurationTarget.Workspace);
  return true;
}

export function uriBasename(uri: vscode.Uri): string {
  const parts = uri.path.split('/');
  return parts[parts.length - 1] ?? '';
}

export function isPackageJson(uri: vscode.Uri): boolean {
  return uriBasename(uri) === 'package.json';
}

export function isManifest(uri: vscode.Uri): boolean {
  return manifestAdapterForPath(uri.path) !== undefined;
}

/** `DEPENDENCY-NOTES.md` inside a `.depos/` (or `.pacmon/`) directory — nothing
 *  else counts, not even a `DEPENDENCY-NOTES.md` at the root. */
export function isNotesFile(uri: vscode.Uri): boolean {
  return notesKindOfPath(uri.path) !== undefined;
}
