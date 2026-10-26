import * as vscode from 'vscode';
import { dependencyAtOffset } from '../core/manifest';
import { sectionLayers } from '../core/layers';
import { findSection } from '../core/parseNotes';
import { isManifest, noteEntryMode, notesFileLabelForManifest } from './config';
import { logError } from './log';
import { notesDirForManifest, resolveNotesFileFor } from './resolveNotesFile';
import { notesDirOf } from '../core/template';
import type { Store } from './state';
import { upsertNote } from './commands/writeNote';

/**
 * EXPERIMENTAL note-entry surface (depos.noteEntry = "comments"):
 * dependency lines get a commenting range; the comment thread's multi-line
 * input box writes straight to DEPENDENCY-NOTES.md via the "Save note" button.
 */
export class NoteComments implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly threads = new Map<string, vscode.CommentThread>();

  constructor(private readonly store: Store) {
    this.controller = vscode.comments.createCommentController('pacmon', 'Depos Dependency Notes');
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (doc) => {
        if (noteEntryMode() !== 'comments' || !isManifest(doc.uri)) return [];
        const deps = this.store.depsForDocument(doc);
        return deps.map((d) => {
          const line = doc.positionAt(d.primaryRange.offset).line;
          return new vscode.Range(line, 0, line, 0);
        });
      },
    };
  }

  dispose(): void {
    this.controller.dispose();
  }

  /** "Save note" button inside the comment thread input. */
  async saveFromReply(reply: vscode.CommentReply): Promise<void> {
    try {
      const thread = reply.thread;
      if (!thread.range) {
        thread.dispose();
        return;
      }
      const doc = await vscode.workspace.openTextDocument(thread.uri);
      const deps = this.store.depsForDocument(doc);
      const offset = doc.offsetAt(new vscode.Position(thread.range.start.line, 0));
      const lineEnd = doc.offsetAt(doc.lineAt(thread.range.start.line).range.end);
      const dep = deps.find((d) => d.primaryRange.offset >= offset && d.primaryRange.offset <= lineEnd)
        ?? dependencyAtOffset(deps, offset);
      if (!dep) {
        thread.dispose();
        return;
      }
      const body = reply.text.trim();
      if (body !== '') await upsertNote(this.store, thread.uri, dep.noteKey, body);
      await this.showThread(thread, dep.noteKey);
    } catch (e) {
      logError('comments.saveFromReply', e);
    }
  }

  /** Render the saved note back into the thread (read-only preview). */
  private async showThread(thread: vscode.CommentThread, depName: string): Promise<void> {
    const pkgUri = thread.uri;
    const notesUri = await resolveNotesFileFor(pkgUri);
    const notes = notesUri ? await this.store.getNotes(notesUri) : undefined;
    const section = notes ? findSection(notes, depName) : undefined;
    // The thread mirrors what people wrote; the agent block stays in the file.
    const bodyText = notes && section ? sectionLayers(notes, section).human : '';
    const md = new vscode.MarkdownString(bodyText || '_(empty note)_');
    const comment: vscode.Comment = {
      body: md,
      mode: vscode.CommentMode.Preview,
      author: { name: notesFileLabelForManifest(pkgUri, notesUri ? notesDirOf(notesUri.path) : await notesDirForManifest(pkgUri)) },
    };
    thread.comments = [comment];
    thread.label = depName;
    thread.canReply = true;
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    this.threads.set(`${thread.uri.toString()}:${depName}`, thread);
  }
}
