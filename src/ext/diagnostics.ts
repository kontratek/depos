import * as vscode from 'vscode';
import { lintNotes } from '../core/lint';
import { parseNotes } from '../core/parseNotes';
import { isNotesFile } from './config';
import { suggestMoveNotes } from './commands/moveNotes';
import { dependenciesForNotes, notesKind, shadowingNotesFile } from './resolveNotesFile';
import type { Store } from './state';
import { S } from './strings';

export const DIAG_SOURCE = 'depos';
export type DiagCode =
  | 'duplicate-section'
  | 'wrong-heading-level'
  | 'missing-space'
  | 'missing-frontmatter'
  | 'unknown-format'
  | 'missing-ecosystem'
  | 'wrong-ecosystem'
  | 'missing-title'
  | 'wrong-title'
  | 'extra-title'
  | 'stray-heading'
  | 'unknown-agent-key'
  | 'empty-agent-value'
  | 'bad-agent-value'
  | 'removed-but-present'
  | 'shadowed-notes-file';

/**
 * Guidance, only while a notes file is open — and every item a Warning: one
 * colour, one meaning, something here is wrong and has a fix.
 * - duplicate sections
 * - format lint: frontmatter and its version; the one `# Dependency Notes` title;
 *   a dependency name under the wrong heading level or as "##name"; a heading
 *   inside a section other than `### Agent notes`
 * - agent-block lint: a key outside the vocabulary, an empty value, an
 *   enumerated value of the wrong shape, `status: removed` on a package that
 *   is still in package.json — on the key or value alone, never the human text
 * Sections whose package is not in package.json are NOT diagnostics: they get
 * a marker before the heading (orphanMarkers.ts). A removed package's notes
 * are worth keeping, and a marker does not nag.
 * package.json itself never gets diagnostics.
 */
export class NotesDiagnostics implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('depos');
  private readonly disposables: vscode.Disposable[] = [];
  /** The newest refresh started for each open notes file, by URI. */
  private readonly latestRefresh = new Map<string, number>();
  private refreshCount = 0;

  constructor(private readonly store: Store) {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => void this.refresh(doc)),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.latestRefresh.delete(doc.uri.toString());
        this.collection.delete(doc.uri);
      }),
      this.store.onDidChange(() => {
        for (const doc of vscode.workspace.textDocuments) void this.refresh(doc);
      }),
    );
    for (const doc of vscode.workspace.textDocuments) void this.refresh(doc);
  }

  dispose(): void {
    this.collection.dispose();
    for (const d of this.disposables) d.dispose();
  }

  private async refresh(doc: vscode.TextDocument): Promise<void> {
    if (!isNotesFile(doc.uri)) return;
    const key = doc.uri.toString();
    const refreshId = ++this.refreshCount;
    this.latestRefresh.set(key, refreshId);
    const model = parseNotes(doc.getText());
    const diags: vscode.Diagnostic[] = [];
    const warning = vscode.DiagnosticSeverity.Warning;

    const lineRange = (line: number): vscode.Range => {
      const clamped = Math.min(line, Math.max(doc.lineCount - 1, 0));
      return doc.lineAt(clamped).range;
    };
    /** Just the key or the value at fault — the line itself is fine. */
    const spanRange = (line: number, span: { start: number; end: number }): vscode.Range => {
      const clamped = Math.min(line, Math.max(doc.lineCount - 1, 0));
      const len = doc.lineAt(clamped).text.length;
      return new vscode.Range(clamped, Math.min(span.start, len), clamped, Math.min(span.end, len));
    };

    const push = (range: vscode.Range, message: string, code: DiagCode): void => {
      const d = new vscode.Diagnostic(range, message, warning);
      d.source = DIAG_SOURCE;
      d.code = code;
      diags.push(d);
    };

    for (const p of model.problems) {
      push(lineRange(p.line), S.duplicateSection(p.name, p.firstLine + 1), 'duplicate-section');
    }

    const shadowing = shadowingNotesFile(doc.uri);
    const deps = await dependenciesForNotes(this.store, doc.uri);
    const shadow = await shadowing;
    // Refreshes of one file can wait on the same dependency discovery and finish
    // in any order. One that started later saw newer text; this result would
    // overwrite its diagnostics, and no event would come to correct them.
    if (this.latestRefresh.get(key) !== refreshId) return;

    // A .pacmon/ file with a .depos/ one beside it is never read.
    if (shadow) push(lineRange(0), S.shadowedNotesFile(vscode.workspace.asRelativePath(shadow, false)), 'shadowed-notes-file');
    suggestMoveNotes(doc.uri);

    for (const f of lintNotes(model, deps.map((d) => d.noteKey), notesKind(doc.uri))) {
      switch (f.kind) {
        case 'wrongHeadingLevel':
          push(lineRange(f.line), S.wrongHeadingLevel(f.name), 'wrong-heading-level');
          break;
        case 'missingSpaceAfterHashes':
          push(lineRange(f.line), S.missingSpaceAfterHashes(f.name), 'missing-space');
          break;
        case 'missingFrontmatter':
          push(lineRange(0), S.missingFrontmatter, 'missing-frontmatter');
          break;
        case 'unknownFormat':
          push(lineRange(f.line), S.unknownFormat(f.version), 'unknown-format');
          break;
        case 'missingEcosystem':
          push(lineRange(f.line), S.missingEcosystem, 'missing-ecosystem');
          break;
        case 'wrongEcosystem':
          push(lineRange(f.line), S.wrongEcosystem(f.actual, f.expected), 'wrong-ecosystem');
          break;
        case 'missingTitle':
          push(lineRange(f.line), S.missingTitle, 'missing-title');
          break;
        case 'wrongTitle':
          push(lineRange(f.line), S.wrongTitle, 'wrong-title');
          break;
        case 'extraTitle':
          push(lineRange(f.line), S.extraTitle, 'extra-title');
          break;
        case 'strayHeading':
          push(
            lineRange(f.line),
            f.meant === 'agent-notes' ? S.strayHeadingAgent : f.meant === 'generated' ? S.strayHeadingGenerated : S.strayHeading,
            'stray-heading',
          );
          break;
        case 'removedButPresent':
          push(spanRange(f.line, f.span), S.removedButPresent(f.name), 'removed-but-present');
          break;
        case 'unknownAgentKey':
          push(
            spanRange(f.line, f.span),
            f.suggestion === undefined ? S.unknownAgentKey(f.key) : S.unknownAgentKeySuggest(f.key, f.suggestion),
            'unknown-agent-key',
          );
          break;
        case 'emptyAgentValue':
          push(spanRange(f.line, f.span), S.emptyAgentValue(f.key), 'empty-agent-value');
          break;
        case 'badAgentValue':
          push(spanRange(f.line, f.span), S.badAgentValue(f.key, f.expected), 'bad-agent-value');
          break;
      }
    }

    this.collection.set(doc.uri, diags);
  }
}
