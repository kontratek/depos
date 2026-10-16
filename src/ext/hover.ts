import * as vscode from 'vscode';
import { orderedLayers, sectionLayers } from '../core/layers';
import { dependencyAtOffset, manifestAdapterForPath } from '../core/manifest';
import { findSection } from '../core/parseNotes';
import { inlineSource, MANIFEST_SELECTOR, notesFileLabelForManifest } from './config';
import { logError } from './log';
import { resolveNotesFileFor } from './resolveNotesFile';
import type { Store } from './state';
import { S } from './strings';
import type { OrgContext } from './web/orgContext';
import { orgView, type OrgView } from './web/orgView';

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

      const kind = manifestAdapterForPath(doc.uri.path)?.kind;
      const folderOrg = kind ? org.forUri(doc.uri) : undefined;
      const orgPart = kind && folderOrg?.layer ? orgView({ ...folderOrg, layer: folderOrg.layer }, kind, dep.noteKey, shortTime) : undefined;

      const notesUri = await resolveNotesFileFor(doc.uri);
      const notes = notesUri ? await store.getNotes(notesUri) : undefined;
      const section = notes ? findSection(notes, dep.noteKey) : undefined;
      // Both layers, in the order the setting asks for, a rule between them.
      const parts = notes && section ? orderedLayers(sectionLayers(notes, section), inlineSource()) : [];
      // Undocumented lines stay silent, unless the organization has something to say.
      if (parts.length === 0 && !orgPart) return undefined;

      const md = new vscode.MarkdownString(undefined, true);
      md.isTrusted = { enabledCommands: ['pacmon.addOrEditNote', 'pacmon.openNotesFile'] };
      // Org mode: the note is the org note, not a section of the notes file.
      const orgNotes = org.notesFor(doc.uri);
      const fileLabel = orgNotes ? S.orgNotesLabel(orgNotes.copy.orgName) : notesFileLabelForManifest(doc.uri);
      md.appendMarkdown(`**${dep.displayName}** ${S.hoverSourceSuffix(fileLabel)}\n\n`);
      if (parts.length > 0) md.appendMarkdown(`${parts.map((p) => p.text).join('\n\n---\n\n')}\n\n`);
      if (orgPart) appendOrg(md, orgPart);
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

function shortTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** The allowlist result, after the note and apart from it. Server text goes in with appendText (escaped). */
function appendOrg(md: vscode.MarkdownString, view: OrgView): void {
  md.appendMarkdown('---\n\n');
  md.appendText(S.orgAllowlistLine(view.allowlist.result, view.allowlist.mode));
  if (view.allowlist.reason) md.appendText(` — ${S.orgReason(view.allowlist.reason)}`);
  if (view.allowlist.expires) md.appendText(` · ${S.orgExpires(view.allowlist.expires)}`);
  md.appendMarkdown('\n\n');
  md.appendMarkdown(`[${S.orgOpenWeb}](${view.link}) · `);
  md.appendText(view.received);
  md.appendMarkdown('\n\n');
}
