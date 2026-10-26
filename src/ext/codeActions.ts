import * as vscode from 'vscode';
import { keepAsNoteLine, rewriteUnknownKeyLine } from '../core/fixes';
import { AGENT_FIELD_RE } from '../core/layers';
import { classifyStrayHeading, lintNotes } from '../core/lint';
import { parseNotes } from '../core/parseNotes';
import { normalizeText } from '../core/serialize';
import { AGENT_NOTES_HEADING, DEFAULT_TITLE, notesDirOf } from '../core/template';
import { NOTES_GLOB, isNotesFile } from './config';
import { DIAG_SOURCE, type DiagCode } from './diagnostics';
import { S } from './strings';

const HEADING_TEXT_RE = /^#{1,6}\s*(.+?)\s*$/;

/** "Fix All" (the command, or `editor.codeActionsOnSave`) picks this kind up. */
export const FIX_ALL_KIND = vscode.CodeActionKind.SourceFixAll.append('depos');
/**
 * The kind from before Pacmon became Depos, which people put in
 * `editor.codeActionsOnSave`. Still answered when asked for by name; one
 * action per request either way, so no fix runs twice.
 */
export const LEGACY_FIX_ALL_KIND = vscode.CodeActionKind.SourceFixAll.append('pacmon');

function fixAllKindFor(only: vscode.CodeActionKind | undefined): vscode.CodeActionKind {
  return only && !only.contains(FIX_ALL_KIND) && only.contains(LEGACY_FIX_ALL_KIND) ? LEGACY_FIX_ALL_KIND : FIX_ALL_KIND;
}

function removeLine(doc: vscode.TextDocument, diag: vscode.Diagnostic, preferred = false): vscode.CodeAction {
  const fix = new vscode.CodeAction(S.fixRemoveLine, vscode.CodeActionKind.QuickFix);
  fix.diagnostics = [diag];
  fix.isPreferred = preferred;
  fix.edit = new vscode.WorkspaceEdit();
  fix.edit.delete(doc.uri, doc.lineAt(diag.range.start.line).rangeIncludingLineBreak);
  return fix;
}

/** Replace the diagnostic's whole line. */
function replaceLine(doc: vscode.TextDocument, diag: vscode.Diagnostic, title: string, text: string, preferred: boolean): vscode.CodeAction {
  const fix = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  fix.diagnostics = [diag];
  fix.isPreferred = preferred;
  fix.edit = new vscode.WorkspaceEdit();
  fix.edit.replace(doc.uri, doc.lineAt(diag.range.start.line).range, text);
  return fix;
}

/** The text of a heading line, without its hashes. */
function headingText(lineText: string): string {
  return HEADING_TEXT_RE.exec(lineText)?.[1] ?? lineText.replace(/^#+\s*/, '').trim();
}

/** Every unknown key in the file, rewritten at once. Nothing is deleted. */
export function fixAllEdit(doc: vscode.TextDocument): { edit: vscode.WorkspaceEdit; count: number } | undefined {
  const edit = new vscode.WorkspaceEdit();
  let count = 0;
  for (const f of lintNotes(parseNotes(doc.getText()), [])) {
    if (f.kind !== 'unknownAgentKey') continue;
    const rewritten = rewriteUnknownKeyLine(doc.lineAt(f.line).text);
    if (!rewritten) continue;
    edit.replace(doc.uri, doc.lineAt(f.line).range, rewritten.text);
    count++;
  }
  return count > 0 ? { edit, count } : undefined;
}

/** The code lens above an agent block, and a palette-less command: fix this file. */
export async function fixAgentNotes(uriArg: unknown): Promise<void> {
  const uri = uriArg instanceof vscode.Uri ? uriArg : vscode.window.activeTextEditor?.document.uri;
  if (!uri || !isNotesFile(uri)) return;
  const doc = await vscode.workspace.openTextDocument(uri);
  const fix = fixAllEdit(doc);
  if (fix) await vscode.workspace.applyEdit(fix.edit);
}

/**
 * Our diagnostics on the line the cursor is on — not only the ones VS Code
 * hands over for the exact cursor position. The squiggle sits on the key
 * alone, and the fix must be there wherever on the line the caret is.
 */
function diagnosticsOnLine(doc: vscode.TextDocument, range: vscode.Range, context: vscode.CodeActionContext): vscode.Diagnostic[] {
  const seen = new Set<string>();
  const out: vscode.Diagnostic[] = [];
  const all = [
    ...context.diagnostics,
    ...vscode.languages.getDiagnostics(doc.uri).filter((d) => d.range.start.line === range.start.line),
  ];
  for (const d of all) {
    if (d.source !== DIAG_SOURCE) continue;
    const id = `${String(d.code)}:${d.range.start.line}:${d.range.start.character}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(d);
  }
  return out;
}

/** Quick fixes for Depos diagnostics, a fix-all for the agent block, and a
 *  formatting provider so the editor's own "Format Document" (and
 *  format-on-save) normalizes the notes file. */
export function registerFixProviders(): vscode.Disposable[] {
  const selector: vscode.DocumentFilter = { pattern: NOTES_GLOB };

  const codeActions = vscode.languages.registerCodeActionsProvider(
    selector,
    {
      provideCodeActions(doc, range, context) {
        const actions: vscode.CodeAction[] = [];

        const fixAllKind = fixAllKindFor(context.only);
        if (context.only === undefined || context.only.contains(fixAllKind)) {
          const all = fixAllEdit(doc);
          if (all) {
            const action = new vscode.CodeAction(S.fixAllTitle(all.count), fixAllKind);
            action.edit = all.edit;
            actions.push(action);
          }
        }

        for (const diag of diagnosticsOnLine(doc, range, context)) {
          const code = diag.code as DiagCode;
          const line = diag.range.start.line;
          if (line >= doc.lineCount) continue;
          const lineText = doc.lineAt(line).text;
          // A diagnostic can outlive the text it was raised on (the collection
          // refreshes a beat after an edit): a fix is offered only while the
          // line still looks like what the diagnostic says it is.
          const isHeading = /^#/.test(lineText);
          const isField = AGENT_FIELD_RE.test(lineText);

          if ((code === 'wrong-heading-level' || code === 'missing-space') && isHeading) {
            const name = headingText(lineText);
            actions.push(replaceLine(doc, diag, S.fixHeading(name), `## ${name}`, true));
          }

          if (code === 'missing-frontmatter' || code === 'missing-title') {
            const fix = new vscode.CodeAction(S.runFormat, vscode.CodeActionKind.QuickFix);
            fix.diagnostics = [diag];
            fix.isPreferred = true;
            fix.command = { command: 'depos.normalizeNotesFile', title: S.runFormat };
            actions.push(fix);
          }

          if (code === 'wrong-title' && isHeading) {
            actions.push(replaceLine(doc, diag, S.fixTitle, DEFAULT_TITLE, true));
          }

          if ((code === 'extra-title' || code === 'stray-heading') && isHeading) {
            const text = headingText(lineText);
            const meant = code === 'stray-heading' ? classifyStrayHeading(text) : undefined;
            if (meant === 'agent-notes') {
              actions.push(replaceLine(doc, diag, S.fixAgentHeading, AGENT_NOTES_HEADING, true));
            }
            // A heading nobody may write becomes a bold line: the words stay.
            if (meant !== 'generated') {
              actions.push(replaceLine(doc, diag, S.fixPlainText, `**${text}**`, meant === undefined));
            }
          }

          if (code === 'removed-but-present' && isField) actions.push(removeLine(doc, diag, true));

          if (code === 'unknown-agent-key' && isField) {
            const rewritten = rewriteUnknownKeyLine(lineText);
            if (rewritten?.renamedTo !== undefined) {
              const rename = new vscode.CodeAction(S.fixRenameKey(rewritten.renamedTo), vscode.CodeActionKind.QuickFix);
              rename.diagnostics = [diag];
              rename.isPreferred = true;
              rename.edit = new vscode.WorkspaceEdit();
              rename.edit.replace(doc.uri, doc.lineAt(line).range, rewritten.text);
              actions.push(rename);
            }
            // Keeping the content is always on offer: `- foo: bar` → `- note: foo: bar`.
            const asNote = keepAsNoteLine(lineText);
            if (asNote !== undefined) {
              const keep = new vscode.CodeAction(S.fixKeepAsNote, vscode.CodeActionKind.QuickFix);
              keep.diagnostics = [diag];
              keep.isPreferred = rewritten?.renamedTo === undefined;
              keep.edit = new vscode.WorkspaceEdit();
              keep.edit.replace(doc.uri, doc.lineAt(line).range, asNote);
              actions.push(keep);
            }
            actions.push(removeLine(doc, diag));
          }

          if (code === 'empty-agent-value' && isField) actions.push(removeLine(doc, diag));
        }
        return actions;
      },
    },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, FIX_ALL_KIND, LEGACY_FIX_ALL_KIND] },
  );

  const formatting = vscode.languages.registerDocumentFormattingEditProvider(selector, {
    provideDocumentFormattingEdits(doc) {
      const original = doc.getText();
      const canonical = normalizeText(original, notesDirOf(doc.uri.path));
      if (canonical === original) return [];
      const fullRange = new vscode.Range(new vscode.Position(0, 0), doc.lineAt(doc.lineCount - 1).range.end);
      return [vscode.TextEdit.replace(fullRange, canonical)];
    },
  });

  return [codeActions, formatting];
}
