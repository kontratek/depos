import { normalizeNameForEcosystem } from '../../core/match';
import { parseAgentFields } from '../../core/layers';
import type { ManifestKind } from '../../core/model';
import { composeSectionBody } from '../../core/serialize';
import { DEFAULT_TITLE, frontmatterLinesFor } from '../../core/template';
import { isObject, LIMITS, list, lookupKey, str } from './json';

/**
 * The org notes of one organization, as the editor keeps them on the user's machine
 * (docs/format.md, "The organization layer", org mode). No vscode import, so it is
 * unit tested. Depos is the source; this is a copy filled by a delta sync.
 */

export interface OrgNote {
  ulid: string;
  ecosystem: string;
  noteKey: string;
  displayName: string;
  humanText: string;
  fields: Array<{ key: string; value: string }>;
  scope: { kind: 'all' } | { kind: 'repos'; repositoryUlids: string[] };
  /** Sent back as the version the user edited. */
  updatedAt: string;
  updatedByName: string | null;
}

export type OrgNoteChange =
  | { kind: 'upsert'; note: OrgNote }
  | { kind: 'delete'; ulid: string; ecosystem: string; noteKey: string };

export interface OrgNotesSync {
  organization: { ulid: string; name: string };
  canEdit: boolean;
  full: boolean;
  changes: OrgNoteChange[];
  cursor: string;
  more: boolean;
}

/** What is written to disk between sessions. */
export interface OrgNotesSnapshot {
  orgUlid: string;
  orgName: string;
  canEdit: boolean;
  cursor: string;
  /** When the server last answered (ms since epoch). */
  receivedAt: number;
  notes: OrgNote[];
}

function noteOf(v: unknown): OrgNote | undefined {
  if (!isObject(v) || !str(v.ulid) || !str(v.ecosystem) || !str(v.noteKey) || !str(v.displayName)) return undefined;
  if (!str(v.humanText, LIMITS.text) || !str(v.updatedAt) || !list(v.fields)) return undefined;
  if (v.updatedByName !== null && !str(v.updatedByName)) return undefined;
  const fields: OrgNote['fields'] = [];
  for (const f of v.fields) {
    if (!isObject(f) || !str(f.key) || !str(f.value, LIMITS.text)) return undefined;
    fields.push({ key: f.key, value: f.value });
  }
  const scope = v.scope;
  if (!isObject(scope)) return undefined;
  let parsedScope: OrgNote['scope'];
  if (scope.kind === 'all') parsedScope = { kind: 'all' };
  else if (scope.kind === 'repos' && list(scope.repositoryUlids) && scope.repositoryUlids.every((u) => str(u))) {
    parsedScope = { kind: 'repos', repositoryUlids: scope.repositoryUlids as string[] };
  } else return undefined;
  return {
    ulid: v.ulid,
    ecosystem: v.ecosystem,
    noteKey: v.noteKey,
    displayName: v.displayName,
    humanText: v.humanText,
    fields,
    scope: parsedScope,
    updatedAt: v.updatedAt,
    updatedByName: v.updatedByName,
  };
}

/** One note as the server sends it after a save, checked. */
export function parseOrgNote(json: unknown): OrgNote | undefined {
  return noteOf(json);
}

/** The answer of `GET /api/extension/organizations/<ulid>/notes`, checked; undefined when it has another shape. */
export function parseOrgNotesSync(json: unknown): OrgNotesSync | undefined {
  if (!isObject(json) || !isObject(json.organization)) return undefined;
  const { organization } = json;
  if (!str(organization.ulid) || !str(organization.name) || !str(json.cursor)) return undefined;
  if (typeof json.canEdit !== 'boolean' || typeof json.full !== 'boolean' || typeof json.more !== 'boolean') return undefined;
  if (!list(json.changes)) return undefined;
  const changes: OrgNoteChange[] = [];
  for (const c of json.changes) {
    if (!isObject(c)) return undefined;
    if (c.kind === 'upsert') {
      const note = noteOf(c.note);
      if (!note) return undefined;
      changes.push({ kind: 'upsert', note });
    } else if (c.kind === 'delete' && str(c.ulid) && str(c.ecosystem) && str(c.noteKey)) {
      changes.push({ kind: 'delete', ulid: c.ulid, ecosystem: c.ecosystem, noteKey: c.noteKey });
    } else return undefined;
  }
  return {
    organization: { ulid: organization.ulid, name: organization.name },
    canEdit: json.canEdit,
    full: json.full,
    changes,
    cursor: json.cursor,
    more: json.more,
  };
}

/** A snapshot read back from disk, checked like a server answer: the file may be old or damaged. */
export function parseSnapshot(json: unknown): OrgNotesSnapshot | undefined {
  if (!isObject(json) || !str(json.orgUlid) || !str(json.orgName) || !str(json.cursor)) return undefined;
  if (typeof json.canEdit !== 'boolean' || typeof json.receivedAt !== 'number' || !list(json.notes)) return undefined;
  const notes: OrgNote[] = [];
  for (const n of json.notes) {
    const note = noteOf(n);
    if (!note) return undefined;
    notes.push(note);
  }
  return { orgUlid: json.orgUlid, orgName: json.orgName, canEdit: json.canEdit, cursor: json.cursor, receivedAt: json.receivedAt, notes };
}

/** The agent layer of an org note: one `- key: value` line per field. */
export function fieldsToAgentText(fields: OrgNote['fields']): string {
  return fields.map((f) => `- ${f.key}: ${f.value.replace(/[\r\n]+/g, ' ')}`).join('\n');
}

/**
 * The fields of an agent layer the user wrote. An org note holds fields only, so prose
 * lines are left out; `dropped` counts them so the editor can say so.
 */
export function agentTextToFields(agent: string): { fields: OrgNote['fields']; dropped: number } {
  const fields = parseAgentFields(agent).map((f) => ({ key: f.key, value: f.value }));
  const nonEmpty = agent.split(/\r?\n/).filter((l) => l.trim() !== '').length;
  return { fields, dropped: nonEmpty - fields.length };
}

/**
 * A line of an org note's human text that the notes format would read as a heading is
 * escaped (`\#`), so the text stays inside its section. Markdown shows it as `#`.
 */
function escapeHeadings(text: string): string {
  return text.split(/\r?\n/).map((line) => (/^\s{0,3}#/.test(line) ? line.replace('#', '\\#') : line)).join('\n');
}

export class OrgNotesCopy {
  private readonly byKey = new Map<string, OrgNote>();
  /** Bumped on every change: the version of the notes text built from this copy. */
  version = 0;
  orgName: string;
  canEdit: boolean;
  cursor: string;
  receivedAt: number;

  constructor(readonly orgUlid: string, snapshot?: OrgNotesSnapshot) {
    this.orgName = snapshot?.orgName ?? '';
    this.canEdit = snapshot?.canEdit ?? false;
    this.cursor = snapshot?.cursor ?? '';
    this.receivedAt = snapshot?.receivedAt ?? 0;
    for (const note of snapshot?.notes ?? []) this.byKey.set(lookupKey(note.ecosystem, note.noteKey), note);
  }

  /** True once the copy has been filled from the server at least once. */
  get loaded(): boolean {
    return this.cursor !== '';
  }

  /** Apply one page of a sync, in order. True when anything the user sees changed. */
  apply(page: OrgNotesSync, now: number): boolean {
    let changed = page.full && this.byKey.size > 0;
    if (page.full) this.byKey.clear();
    if (this.orgName !== page.organization.name || this.canEdit !== page.canEdit) changed = true;
    this.orgName = page.organization.name;
    this.canEdit = page.canEdit;
    for (const change of page.changes) {
      if (change.kind === 'upsert') {
        this.byKey.set(lookupKey(change.note.ecosystem, change.note.noteKey), change.note);
        changed = true;
        continue;
      }
      const key = lookupKey(change.ecosystem, change.noteKey);
      // Only the note that was deleted: a newer note of the same package stays.
      if (this.byKey.get(key)?.ulid === change.ulid) {
        this.byKey.delete(key);
        changed = true;
      }
    }
    this.cursor = page.cursor;
    this.receivedAt = now;
    if (changed) this.version++;
    return changed;
  }

  /** A note the server just saved, ahead of the next sync. */
  put(note: OrgNote): void {
    this.byKey.set(lookupKey(note.ecosystem, note.noteKey), note);
    this.version++;
  }

  remove(ecosystem: string, noteKey: string): void {
    if (this.byKey.delete(lookupKey(ecosystem, noteKey))) this.version++;
  }

  snapshot(): OrgNotesSnapshot {
    return {
      orgUlid: this.orgUlid,
      orgName: this.orgName,
      canEdit: this.canEdit,
      cursor: this.cursor,
      receivedAt: this.receivedAt,
      notes: [...this.byKey.values()],
    };
  }

  /** The org note of a package, if its scope covers the repository. */
  note(ecosystem: ManifestKind, name: string, repoUlid: string): OrgNote | undefined {
    const note = this.byKey.get(lookupKey(ecosystem, normalizeNameForEcosystem(name, ecosystem)));
    return note && covers(note, repoUlid) ? note : undefined;
  }

  /**
   * The org notes of one ecosystem that cover a repository, as the text of a notes file.
   * The editor reads it wherever it would read DEPENDENCY-NOTES.md, so every view shows
   * org notes through the same core code. It is never written to disk.
   */
  notesText(ecosystem: ManifestKind, repoUlid: string): string {
    const notes = [...this.byKey.values()]
      .filter((n) => n.ecosystem === ecosystem && covers(n, repoUlid))
      .sort((a, b) => (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : 0));
    const lines = [
      ...frontmatterLinesFor(ecosystem),
      '',
      `<!-- Notes of ${this.orgName.replace(/-->/g, '')}, from Depos. Read-only: change them in the note editor or in Depos. -->`,
      '',
      DEFAULT_TITLE,
    ];
    for (const n of notes) {
      lines.push('', `## ${n.displayName.replace(/[\r\n]+/g, ' ').trim()}`, '');
      const body = composeSectionBody({ human: escapeHeadings(n.humanText), agent: fieldsToAgentText(n.fields) });
      if (body !== '') lines.push(...body.split('\n'));
    }
    return lines.join('\n') + '\n';
  }
}

function covers(note: OrgNote, repoUlid: string): boolean {
  return note.scope.kind === 'all' || note.scope.repositoryUlids.includes(repoUlid);
}
