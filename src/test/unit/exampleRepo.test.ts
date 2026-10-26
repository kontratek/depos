import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../../core/analyze';
import { lintNotes } from '../../core/lint';
import { extractDeps } from '../../core/packageJson';
import { parseNotes } from '../../core/parseNotes';
import { normalizeText } from '../../core/serialize';

const read = (rel: string): string => readFileSync(new URL(`../../../docs/example-repo/${rel}`, import.meta.url), 'utf8');
const notes = read('.depos/DEPENDENCY-NOTES.md');
const deps = extractDeps(read('package.json'));

describe('docs/example-repo', () => {
  it('is a lint-clean, canonical notes file for its package.json', () => {
    const model = parseNotes(notes);
    expect(deps.length).toBeGreaterThan(0);
    expect(lintNotes(model, deps.map((d) => d.name))).toEqual([]);
    expect(model.problems).toEqual([]);
    expect(normalizeText(notes)).toBe(notes);
  });

  it('documents every dependency and keeps one removed package on purpose', () => {
    const a = analyze(deps, parseNotes(notes));
    expect(a.undocumented).toEqual([]);
    expect(a.orphans).toEqual([]);
    expect(a.removed.map((s) => s.name)).toEqual(['moment']);
  });
});
