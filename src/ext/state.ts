import * as vscode from 'vscode';
import type { DepEntry, NotesFileModel } from '../core/model';
import { parseNotes } from '../core/parseNotes';
import { manifestAdapterForPath } from '../core/manifest';

interface CacheEntry<T> {
  version: string;
  value: T;
}

/**
 * Versioned caches for parsed notes files and package.json dependency lists.
 * All file IO goes through vscode.workspace.fs (web-safe). No work happens on
 * keystrokes: callers are notified via a debounced onDidChange event and pull
 * lazily.
 */
/** Notes that are not files: org mode builds them from the org notes (web/orgContext.ts). */
export interface VirtualNotes {
  readNotes(uri: vscode.Uri): { version: string; text: string } | undefined;
}

export class Store implements vscode.Disposable {
  private notesCache = new Map<string, CacheEntry<NotesFileModel>>();
  private depsCache = new Map<string, CacheEntry<DepEntry[]>>();
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastManifest: vscode.Uri | undefined;
  private virtual: VirtualNotes | undefined;
  private virtualScheme: string | undefined;

  /** Notes under `scheme` are read from `source`, never from disk. */
  setVirtualNotes(scheme: string, source: VirtualNotes): void {
    this.virtualScheme = scheme;
    this.virtual = source;
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.emitter.dispose();
  }

  /** Debounced change signal (decorations/diagnostics refresh). */
  fireSoon(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(), 300);
  }

  invalidate(uri: vscode.Uri): void {
    const key = uri.toString();
    this.notesCache.delete(key);
    this.depsCache.delete(key);
    this.fireSoon();
  }

  invalidateAll(): void {
    this.notesCache.clear();
    this.depsCache.clear();
    this.fireSoon();
  }

  rememberManifest(uri: vscode.Uri): void {
    if (manifestAdapterForPath(uri.path)) this.lastManifest = uri;
  }

  getLastManifest(): vscode.Uri | undefined {
    return this.lastManifest;
  }

  /** Text of a file. The open document wins only while it has unsaved edits;
   *  otherwise disk is the source of truth (mirrors writeNotesText). */
  async getText(uri: vscode.Uri): Promise<string | undefined> {
    if (uri.scheme === this.virtualScheme) return this.virtual?.readNotes(uri)?.text;
    const open = this.openDoc(uri);
    if (open && open.isDirty) return open.getText();
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder('utf-8').decode(bytes);
    } catch {
      return open ? open.getText() : undefined;
    }
  }

  async getNotes(uri: vscode.Uri): Promise<NotesFileModel | undefined> {
    const key = uri.toString();
    const version = await this.versionKey(uri);
    if (version === undefined) {
      this.notesCache.delete(key);
      return undefined;
    }
    const hit = this.notesCache.get(key);
    if (hit && hit.version === version) return hit.value;
    const text = await this.getText(uri);
    if (text === undefined) return undefined;
    const value = parseNotes(text);
    this.notesCache.set(key, { version, value });
    return value;
  }

  async getDeps(uri: vscode.Uri): Promise<DepEntry[]> {
    const key = uri.toString();
    const version = await this.versionKey(uri);
    if (version === undefined) {
      this.depsCache.delete(key);
      return [];
    }
    const hit = this.depsCache.get(key);
    if (hit && hit.version === version) return hit.value;
    const text = await this.getText(uri);
    if (text === undefined) return [];
    const value = manifestAdapterForPath(uri.path)?.extractDependencies(text, uri.path) ?? [];
    this.depsCache.set(key, { version, value });
    return value;
  }

  /** Deps straight from an open document (hover path — no fs round-trip). */
  depsForDocument(doc: vscode.TextDocument): DepEntry[] {
    this.rememberManifest(doc.uri);
    const key = doc.uri.toString();
    const version = `doc:${doc.version}`;
    const hit = this.depsCache.get(key);
    if (hit && hit.version === version) return hit.value;
    const value = manifestAdapterForPath(doc.uri.path)?.extractDependencies(doc.getText(), doc.uri.path) ?? [];
    this.depsCache.set(key, { version, value });
    return value;
  }

  private openDoc(uri: vscode.Uri): vscode.TextDocument | undefined {
    const key = uri.toString();
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  }

  private async versionKey(uri: vscode.Uri): Promise<string | undefined> {
    if (uri.scheme === this.virtualScheme) {
      const version = this.virtual?.readNotes(uri)?.version;
      return version === undefined ? undefined : `virtual:${version}`;
    }
    const open = this.openDoc(uri);
    if (open) return `doc:${open.version}`;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return `fs:${stat.mtime}:${stat.size}`;
    } catch {
      return undefined;
    }
  }
}
