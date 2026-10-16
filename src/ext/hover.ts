import * as vscode from 'vscode';
import { orderedLayers, sectionLayers } from '../core/layers';
import { dependencyAtOffset } from '../core/manifest';
import { findSection } from '../core/parseNotes';
import { inlineSource, MANIFEST_SELECTOR, notesFileLabelForManifest } from './config';
import { logError } from './log';
import { resolveNotesFileFor } from './resolveNotesFile';
import type { Store } from './state';
import { S } from './strings';
import type { OrgContext } from './web/orgContext';

export function registerHover(store: Store, org: OrgContext): vscode.Disposable {
  return vscode.languages.registerHoverProvider(MANIFEST_SELECTOR, {
    async provideHover(doc, position) {
      try {
        return await provide(doc, position);
      } catch (e) {
        logError('hover.provideHover', e);
        return undefined;
      }
    },
  });

  async function provide(doc: vscode.TextDocument, position: vscode.Position): Promise<vscode.Hover | undefined> {
    {
      const deps = store.depsForDocument(doc);
      if (deps.length === 0) return undefined;
      const offset = doc.offsetAt(position);
      const dep = dependencyAtOffset(deps, offset);
      if (!dep) return undefined;

      const notesUri = await resolveNotesFileFor(doc.uri);
      if (!notesUri) return undefined;
      const notes = await store.getNotes(notesUri);
      if (!notes) return undefined;
      const section = findSection(notes, dep.noteKey);
      if (!section) return undefined; // undocumented lines stay silent

      // Both layers, in the order the setting asks for, a rule between them.
      const parts = orderedLayers(sectionLayers(notes, section), inlineSource());
      if (parts.length === 0) return undefined; // a heading with nothing under it is no note
      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = { enabledCommands: ['pacmon.addOrEditNote', 'pacmon.openNotesFile'] };
      // Org mode: the note is the org note, not a section of the notes file.
      const orgNotes = org.notesFor(doc.uri);
      const fileLabel = orgNotes ? S.orgNotesLabel(orgNotes.copy.orgName) : notesFileLabelForManifest(doc.uri);
      md.appendMarkdown(`**${dep.displayName}** ${S.hoverSourceSuffix(fileLabel)}\n\n`);
      if (parts.length > 0) md.appendMarkdown(`${parts.map((p) => p.text).join('\n\n---\n\n')}\n\n`);
      const arg = encodeURIComponent(JSON.stringify([dep.noteKey]));
      md.appendMarkdown(
        `---\n\n[${S.hoverEditNote}](command:pacmon.addOrEditNote?${arg}) · [${S.hoverOpenFile(fileLabel)}](command:pacmon.openNotesFile)`,
      );

      const hit = dep.sourceRanges.find((range) => offset >= range.offset && offset <= range.offset + range.length)
        ?? dep.primaryRange;
      const start = doc.positionAt(hit.offset);
      const end = doc.positionAt(hit.offset + hit.length);
      return new vscode.Hover(md, new vscode.Range(start, end));
    }
  }
}
