import { describe, expect, it } from 'vitest';
import { analyze } from '../../core/analyze';
import { sectionLayers } from '../../core/layers';
import { findSection, parseNotes } from '../../core/parseNotes';
import type { DepEntry } from '../../core/model';
import {
  agentTextToFields,
  fieldsToAgentText,
  OrgNotesCopy,
  parseOrgNotesSync,
  parseSnapshot,
  type OrgNote,
  type OrgNotesSync,
} from '../../ext/web/orgNotes';

/** Org mode (docs/format.md, "The organization layer"): the local copy of the org notes. */

const REPO = 'R'.repeat(26);
const OTHER_REPO = 'S'.repeat(26);

function note(overrides: Partial<OrgNote> = {}): OrgNote {
  return {
    ulid: 'N1'.padEnd(26, '0'),
    ecosystem: 'npm',
    noteKey: 'express',
    displayName: 'express',
    humanText: 'HTTP layer. Do not upgrade to v5.',
    fields: [{ key: 'constraint', value: 'Stay on 4.x' }, { key: 'usage', value: 'src/http.ts' }],
    scope: { kind: 'all' },
    updatedAt: '2026-10-07T10:00:00.000Z',
    updatedByName: 'Ada',
    ...overrides,
  };
}

function page(overrides: Partial<OrgNotesSync> = {}): OrgNotesSync {
  return {
    organization: { ulid: 'O'.repeat(26), name: 'Acme' },
    canEdit: true,
    full: true,
    changes: [{ kind: 'upsert', note: note() }],
    cursor: `2026-10-07T10:00:00.000Z|${'0'.repeat(26)}`,
    more: false,
    ...overrides,
  };
}

const dep = (name: string): DepEntry => ({ noteKey: name, displayName: name } as DepEntry);

describe('parseOrgNotesSync', () => {
  it('accepts the answer of Depos', () => {
    const answer = page({ changes: [{ kind: 'upsert', note: note() }, { kind: 'delete', ulid: 'N2'.padEnd(26, '0'), ecosystem: 'npm', noteKey: 'lodash' }] });
    expect(parseOrgNotesSync(JSON.parse(JSON.stringify(answer)))).toEqual(answer);
  });

  it('rejects any other shape', () => {
    for (const bad of [
      null,
      { ...page(), canEdit: 'yes' },
      { ...page(), changes: [{ kind: 'rename' }] },
      { ...page(), changes: [{ kind: 'upsert', note: { ...note(), scope: { kind: 'some' } } }] },
      { ...page(), changes: [{ kind: 'upsert', note: { ...note(), humanText: 'x'.repeat(100_001) } }] },
    ]) {
      expect(parseOrgNotesSync(bad)).toBeUndefined();
    }
  });
});

describe('OrgNotesCopy', () => {
  it('is not loaded until the first sync, then keeps the cursor and the editor flag', () => {
    const copy = new OrgNotesCopy('O'.repeat(26));
    expect(copy.loaded).toBe(false);
    expect(copy.apply(page(), 1000)).toBe(true);
    expect(copy.loaded).toBe(true);
    expect(copy.canEdit).toBe(true);
    expect(copy.receivedAt).toBe(1000);
  });

  it('a full sync replaces the copy; a delta adds, changes and deletes in order', () => {
    const copy = new OrgNotesCopy('O'.repeat(26));
    copy.apply(page({ changes: [{ kind: 'upsert', note: note({ noteKey: 'lodash', displayName: 'lodash', ulid: 'N2'.padEnd(26, '0') }) }] }), 1);
    copy.apply(page(), 2);
    expect(copy.note('npm', 'lodash', REPO)).toBeUndefined();

    copy.apply(page({ full: false, changes: [
      { kind: 'delete', ulid: note().ulid, ecosystem: 'npm', noteKey: 'express' },
      { kind: 'upsert', note: note({ ulid: 'N3'.padEnd(26, '0'), humanText: 'Recreated.' }) },
    ] }), 3);
    expect(copy.note('npm', 'express', REPO)?.humanText).toBe('Recreated.');
  });

  it('a late delete of an older note does not remove the newer one', () => {
    const copy = new OrgNotesCopy('O'.repeat(26));
    copy.apply(page({ changes: [{ kind: 'upsert', note: note({ ulid: 'NEW'.padEnd(26, '0') }) }] }), 1);
    copy.apply(page({ full: false, changes: [{ kind: 'delete', ulid: 'OLD'.padEnd(26, '0'), ecosystem: 'npm', noteKey: 'express' }] }), 2);
    expect(copy.note('npm', 'express', REPO)).toBeDefined();
  });

  it('finds a note by name the way Depos stores keys, within its scope', () => {
    const copy = new OrgNotesCopy('O'.repeat(26));
    copy.apply(page({ changes: [
      { kind: 'upsert', note: note() },
      { kind: 'upsert', note: note({ ulid: 'N2'.padEnd(26, '0'), ecosystem: 'python', noteKey: 'django-rest', displayName: 'Django_Rest', scope: { kind: 'repos', repositoryUlids: [OTHER_REPO] } }) },
    ] }), 1);
    expect(copy.note('npm', 'Express', REPO)?.displayName).toBe('express');
    expect(copy.note('python', 'django.rest', OTHER_REPO)).toBeDefined();
    expect(copy.note('python', 'django.rest', REPO)).toBeUndefined();
  });

  it('survives a round trip through its snapshot', () => {
    const copy = new OrgNotesCopy('O'.repeat(26));
    copy.apply(page(), 5);
    const again = new OrgNotesCopy('O'.repeat(26), parseSnapshot(JSON.parse(JSON.stringify(copy.snapshot()))));
    expect(again.loaded).toBe(true);
    expect(again.note('npm', 'express', REPO)).toEqual(note());
    expect(parseSnapshot({ ...copy.snapshot(), notes: [{ broken: true }] })).toBeUndefined();
  });
});

describe('notesText: org notes read through the notes format', () => {
  const copy = new OrgNotesCopy('O'.repeat(26));
  copy.apply(page({ changes: [
    { kind: 'upsert', note: note() },
    { kind: 'upsert', note: note({ ulid: 'N2'.padEnd(26, '0'), noteKey: 'lodash', displayName: 'lodash', humanText: '# Not a heading\n## Not a section either', fields: [] }) },
    { kind: 'upsert', note: note({ ulid: 'N3'.padEnd(26, '0'), noteKey: 'only-other', displayName: 'only-other', scope: { kind: 'repos', repositoryUlids: [OTHER_REPO] } }) },
    { kind: 'upsert', note: note({ ulid: 'N4'.padEnd(26, '0'), ecosystem: 'cargo', noteKey: 'serde', displayName: 'serde' }) },
  ] }), 1);

  it('parses back into the same layers, for the repository and ecosystem only', () => {
    const model = parseNotes(copy.notesText('npm', REPO));
    expect(model.sections.map((s) => s.name)).toEqual(['express', 'lodash']);
    const express = sectionLayers(model, findSection(model, 'express')!);
    expect(express.human).toBe('HTTP layer. Do not upgrade to v5.');
    expect(agentTextToFields(express.agent).fields).toEqual(note().fields);
  });

  it('keeps a heading in the human text inside its section', () => {
    const model = parseNotes(copy.notesText('npm', REPO));
    expect(model.problems).toEqual([]);
    expect(sectionLayers(model, findSection(model, 'lodash')!).human).toBe('\\# Not a heading\n\\## Not a section either');
  });

  it('gives coverage the same answer as a notes file would', () => {
    const { documented, undocumented } = analyze([dep('express'), dep('react')], parseNotes(copy.notesText('npm', REPO)));
    expect(documented.map((d) => d.noteKey)).toEqual(['express']);
    expect(undocumented.map((d) => d.noteKey)).toEqual(['react']);
  });

  it('writes the ecosystem into the frontmatter of a v2 ecosystem', () => {
    expect(parseNotes(copy.notesText('cargo', REPO)).frontmatter?.ecosystem).toBe('cargo');
  });
});

describe('agent text and fields', () => {
  it('keeps field lines and counts the prose it leaves out', () => {
    expect(agentTextToFields('- purpose: HTTP\nSome prose.\n\n- Owner: platform')).toEqual({
      fields: [{ key: 'purpose', value: 'HTTP' }, { key: 'owner', value: 'platform' }],
      dropped: 1,
    });
  });

  it('writes one line per field', () => {
    expect(fieldsToAgentText([{ key: 'purpose', value: 'a\nb' }, { key: 'owner', value: 'x' }])).toBe('- purpose: a b\n- owner: x');
  });
});
