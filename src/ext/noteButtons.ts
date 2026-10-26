import * as vscode from 'vscode';
import { affectsSetting } from './settings';
import type { DepEntry } from '../core/model';
import { findSection } from '../core/parseNotes';
import { isManifest, MANIFEST_SELECTOR, type NoteButton, noteButtonEnabled } from './config';
import { logError } from './log';
import { MARK } from './markIcon';
import { resolveNotesFileFor } from './resolveNotesFile';
import type { Store } from './state';
import { S } from './strings';

/**
 * Ways to reach a dependency's note straight from package.json, chosen with
 * `depos.noteButtons` (and from the Depos view in the activity bar).
 *
 * ON BY DEFAULT — the pair that won the 2026-09-04 comparison:
 *
 *   iconLeft  the Depos mark at the dependency's manifest-specific anchor —
 *             before the name in npm/Cargo, before `<dependency>` in Maven,
 *             and before the configuration call in Gradle;
 *             filled when it has a note, hollow when it does not — with the words
 *             in the hover. A DECORATION, not an inlay hint: only decorations
 *             expose `cursor`, so only they can turn the mouse into a hand,
 *             and the styling is ours. Like an inlay hint it is injected into
 *             the rendered line, so each dependency key is pushed right while
 *             `name`/`version` stay put — the indent column survives, the keys
 *             no longer align, and the mark plus its margin keeps that to
 *             roughly two columns.
 *
 *             Drawing it at the START of the line instead was built and
 *             dropped (2026-09-13). The marks line up in a column either way,
 *             because every dependency key in a package.json sits at the same
 *             depth; the line start only moves that column four characters
 *             left, and it costs the indent ladder — the whole line shifts by
 *             the mark's width, so a marked line no longer steps out from the
 *             `"devDependencies"` above it.
 *             Decorations take no click event, so the plain click is read off
 *             the caret: a click still moves it, and a mouse-kind caret landing
 *             at or before the key opens the note. The target is exactly the
 *             strip the glyph occupies; clicking the name, the version or
 *             anywhere else on the line just places the caret, and keyboard or
 *             programmatic moves are ignored. The hover carries a command link
 *             as a keyboard-reachable fallback.
 *   link      the package NAME itself, opened with Ctrl+click. Adds no pixels
 *             to the file. VS Code renders command targets as editor links and
 *             fixes those at Ctrl+click; extensions cannot change that gesture.
 *
 * OFF BY DEFAULT — lost the comparison, kept because the trade is a matter of
 * taste and some people will want them:
 *
 *   codelens   a clickable line above each dependency. Unmissable, and it
 *              roughly doubles the apparent height of package.json.
 *   inlayHint  the same chip as iconLeft but at the END of the line, with the
 *              words spelled out. Competes with the note preview for that
 *              space, and being an inlay hint it needs Ctrl+click.
 *   lightbulb  a code action, so the bulb shows only on the line the cursor is
 *              on. Marks nothing at rest — the quietest option — but costs two
 *              clicks (bulb, then the action).
 *
 * One idea was built and dropped outright: a plain click ANYWHERE on the line,
 * retargeting an open panel. It took clicks the user meant for the text.
 * The Comments API gutter "+" was never a candidate: its button cannot be
 * rebound to a command, so it always opens a comment thread rather than the
 * note editor. It remains available as `depos.noteEntry: "comments"`.
 *
 * NOTE that `iconLeft`, `codelens` and `inlayHint` mark dependencies with no
 * note yet — the one thing Depos otherwise never does, and why these are
 * switchable. `link` and `lightbulb` do not: a link is drawn over every
 * dependency name alike and only its tooltip tells the two apart, and the bulb
 * shows only on the line the cursor is on.
 */

/**
 * One decoration type for one state of the mark. `light` and `dark` repeat the
 * whole `before` block rather than adding to a shared one above them: the theme
 * merge is shallow, so a `before` inside `light` replaces the outer one
 * outright instead of extending it.
 */
function markType(uris: { light: vscode.Uri; dark: vscode.Uri }): vscode.TextEditorDecorationType {
  const before = (
    contentIconPath: vscode.Uri,
  ): vscode.ThemableDecorationAttachmentRenderOptions => ({
    contentIconPath,
    margin: '0 0.35em 0 0',
    textDecoration: 'none; cursor: pointer',
  });
  return vscode.window.createTextEditorDecorationType({
    light: { before: before(uris.light) },
    dark: { before: before(uris.dark) },
    cursor: 'pointer',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}

/** Every affordance fires the same command, so they differ only in shape. */
function noteCommand(name: string, documented: boolean): vscode.Command {
  return {
    command: 'depos.addOrEditNote',
    title: documented ? S.buttonEdit : S.buttonAdd,
    tooltip: S.buttonTooltip(name),
    arguments: [name],
  };
}

export class NoteButtons implements vscode.Disposable {
  private readonly refresh = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * The link provider is registered and dropped by hand. Unlike code lenses
   * and inlay hints, DocumentLinkProvider has NO change event and VS Code
   * caches what it returns, so returning [] does not make a switched-off link
   * disappear — only replacing the registration does.
   */
  private linkReg: vscode.Disposable | undefined;
  /**
   * The iconLeft mark, one decoration type per state — NOT one type carrying
   * per-range `renderOptions`. VS Code hashes each distinct `renderOptions`
   * object into its own dynamic CSS rule, so two fixed types mean two rules
   * and no per-dependency hashing, however long the file's dependency list.
   */
  private readonly markTypes = {
    documented: markType(MARK.documented),
    undocumented: markType(MARK.undocumented),
  };

  constructor(private readonly store: Store) {
    this.disposables.push(
      this.refresh,
      // A note written elsewhere fills the hollow mark (and turns "Add note"
      // into "Edit note");
      // a config change switches whole affordances on and off.
      store.onDidChange(() => this.onChanged()),
      vscode.window.onDidChangeTextEditorSelection((e) => void this.onIconClick(e)),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshIcons()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshIcons()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (affectsSetting(e, 'noteButtons')) this.onChanged();
      }),

      vscode.languages.registerCodeLensProvider(MANIFEST_SELECTOR, {
        onDidChangeCodeLenses: this.refresh.event,
        provideCodeLenses: (doc) => this.guard('codelens', doc, (deps, has) =>
          deps.map((d) => {
            const line = doc.positionAt(d.primaryRange.offset).line;
            return new vscode.CodeLens(new vscode.Range(line, 0, line, 0), noteCommand(d.noteKey, has(d)));
          }),
        ),
      }),

      vscode.languages.registerInlayHintsProvider(MANIFEST_SELECTOR, {
        onDidChangeInlayHints: this.refresh.event,
        provideInlayHints: (doc, range) => this.guard('inlayHint', doc, (deps, has) =>
          deps
            .filter((d) => range.contains(doc.positionAt(d.primaryRange.offset)))
            .map((d) => {
              const line = doc.positionAt(d.primaryRange.offset).line;
              const part = new vscode.InlayHintLabelPart(has(d) ? S.buttonEdit : S.buttonAdd);
              part.command = noteCommand(d.noteKey, has(d));
              part.tooltip = S.buttonTooltip(d.displayName);
              const hint = new vscode.InlayHint(doc.lineAt(line).range.end, [part]);
              hint.paddingLeft = true;
              return hint;
            }),
        ),
      }),

      vscode.languages.registerCodeActionsProvider(
        MANIFEST_SELECTOR,
        {
          provideCodeActions: (doc, range) => this.guard('lightbulb', doc, (deps, has) => {
            const lineStart = doc.offsetAt(new vscode.Position(range.start.line, 0));
            const lineEnd = doc.offsetAt(doc.lineAt(range.start.line).range.end);
            const dep = deps.find((d) => d.primaryRange.offset >= lineStart && d.primaryRange.offset <= lineEnd);
            if (!dep) return [];
            const action = new vscode.CodeAction(
              has(dep) ? S.buttonEdit : S.buttonAdd,
              vscode.CodeActionKind.QuickFix,
            );
            action.command = noteCommand(dep.noteKey, has(dep));
            return [action];
          }),
        },
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
      ),

    );
    this.refreshIcons();
    this.syncLinks();
  }

  dispose(): void {
    this.linkReg?.dispose();
    this.markTypes.documented.dispose();
    this.markTypes.undocumented.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private onChanged(): void {
    this.refresh.fire();
    this.refreshIcons();
    this.syncLinks();
  }

  private syncLinks(): void {
    this.linkReg?.dispose();
    this.linkReg = undefined;
    if (!noteButtonEnabled('link')) return;
    this.linkReg = vscode.languages.registerDocumentLinkProvider(MANIFEST_SELECTOR, {
      provideDocumentLinks: (doc) => this.guard('link', doc, (deps, has) =>
        deps.map((d) => {
          const raw = doc.getText(new vscode.Range(
            doc.positionAt(d.primaryRange.offset),
            doc.positionAt(d.primaryRange.offset + d.primaryRange.length),
          ));
          const trimQuotes = raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
          const start = doc.positionAt(d.primaryRange.offset + (trimQuotes ? 1 : 0));
          const end = doc.positionAt(d.primaryRange.offset + d.primaryRange.length - (trimQuotes ? 1 : 0));
          const args = encodeURIComponent(JSON.stringify([d.noteKey]));
          const link = new vscode.DocumentLink(
            new vscode.Range(start, end),
            vscode.Uri.parse(`command:depos.addOrEditNote?${args}`),
          );
          link.tooltip = has(d) ? S.buttonEdit : S.buttonAdd;
          return link;
        }),
      ),
    });
  }

  private refreshIcons(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      void this.drawIcons(editor);
    }
  }

  /** Draw (or clear) the iconLeft mark on one editor. */
  private async drawIcons(editor: vscode.TextEditor): Promise<void> {
    const doc = editor.document;
    if (!isManifest(doc.uri)) return;
    const marks = await this.guard('iconLeft', doc, (deps, has) =>
      deps.map((d) => {
        const iconPos = doc.positionAt(d.iconRange.offset);
        const documented = has(d);
        const hover = new vscode.MarkdownString(undefined, true);
        hover.isTrusted = { enabledCommands: ['depos.addOrEditNote'] };
        const arg = encodeURIComponent(JSON.stringify([d.noteKey]));
        hover.appendMarkdown(
          `[${documented ? S.buttonEdit : S.buttonAdd}](command:depos.addOrEditNote?${arg}) — ${d.displayName}`,
        );
        return {
          documented,
          option: {
            // One character wide: the manifest-specific icon anchor. The mark
            // is rendered just before it, and the hand cursor covers both.
            range: new vscode.Range(iconPos, iconPos.translate(0, 1)),
            hoverMessage: hover,
          } satisfies vscode.DecorationOptions,
        };
      }),
    );
    // Two passes, because the state is the decoration type. An empty array is
    // how a type is cleared, so a note written elsewhere moves its dependency
    // from one pass to the other without leaving the old mark behind.
    editor.setDecorations(
      this.markTypes.documented,
      marks.filter((m) => m.documented).map((m) => m.option),
    );
    editor.setDecorations(
      this.markTypes.undocumented,
      marks.filter((m) => !m.documented).map((m) => m.option),
    );
  }

  /**
   * Plain click on the mark. A decoration takes no click event, so this reads
   * the caret instead: a mouse click lands a caret, and one that lands at or
   * before the key of a dependency line is a click on the strip the mark
   * occupies. Every other click on the line — the name, the version, the
   * trailing comma — is left alone, and keyboard and programmatic moves are
   * ignored outright.
   */
  private async onIconClick(e: vscode.TextEditorSelectionChangeEvent): Promise<void> {
    try {
      // No glyph drawn, no click target.
      if (!noteButtonEnabled('iconLeft')) return;
      if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
      if (e.selections.length !== 1) return;
      const sel = e.selections[0]!;
      if (!sel.isEmpty) return;
      const doc = e.textEditor.document;
      if (!isManifest(doc.uri)) return;

      const deps = this.store.depsForDocument(doc);
      const dep = deps.find((d) => doc.positionAt(d.iconRange.offset).line === sel.active.line);
      if (!dep) return;
      if (sel.active.character > doc.positionAt(dep.iconRange.offset).character) return;

      await vscode.commands.executeCommand('depos.addOrEditNote', dep.noteKey);
    } catch (err) {
      logError('noteButtons.iconLeft.click', err);
    }
  }

  /**
   * Shared front door: honours the setting, resolves the deps and the notes
   * file once, and never lets a provider throw into the editor.
   */
  private async guard<T>(
    which: NoteButton,
    doc: vscode.TextDocument,
    build: (deps: readonly DepEntry[], has: (d: DepEntry) => boolean) => T[],
  ): Promise<T[]> {
    try {
      if (!noteButtonEnabled(which)) return [];
      const deps = this.store.depsForDocument(doc);
      if (deps.length === 0) return [];
      const notesUri = await resolveNotesFileFor(doc.uri);
      const notes = notesUri ? await this.store.getNotes(notesUri) : undefined;
      const has = (d: DepEntry): boolean => (notes ? findSection(notes, d.noteKey) !== undefined : false);
      return build(deps, has);
    } catch (e) {
      logError(`noteButtons.${which}`, e);
      return [];
    }
  }
}
