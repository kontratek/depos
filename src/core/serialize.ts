import type { NoteSection, NotesFileModel } from './model';
import { layerRanges, sectionLayers } from './layers';
import { parseNotes } from './parseNotes';
import { normalizeNameForEcosystem } from './match';
import {
  AGENT_NOTES_HEADING,
  DEFAULT_FRONTMATTER_LINES,
  DEFAULT_TITLE,
  FRONTMATTER_DEFAULTS,
  FORMAT_VERSION_V2,
  formatCommentLines,
  frontmatterLinesFor,
  NOTES_DIR,
  type NotesDir,
} from './template';

function trimmedBodyLines(model: NotesFileModel, s: NoteSection): string[] {
  let start = s.bodyStart;
  let end = s.bodyEnd;
  while (start < end && (model.lines[start] ?? '').trim() === '') start++;
  while (end > start && (model.lines[end - 1] ?? '').trim() === '') end--;
  return model.lines.slice(start, end);
}

function trimmedRangeLines(model: NotesFileModel, startLine: number, endLine: number): string[] {
  let start = startLine;
  let end = endLine + 1;
  while (start < end && (model.lines[start] ?? '').trim() === '') start++;
  while (end > start && (model.lines[end - 1] ?? '').trim() === '') end--;
  return model.lines.slice(start, end);
}

/**
 * Frontmatter as written, with the format's own keys appended when missing.
 * Unknown keys and their order are kept — the file may carry other tools' data.
 */
function frontmatterLines(model: NotesFileModel): string[] {
  if (!model.frontmatter) return [...DEFAULT_FRONTMATTER_LINES];
  const inner = model.lines.slice(model.frontmatter.startLine + 1, model.frontmatter.endLine);
  const present = new Set(inner.map((l) => /^([A-Za-z][\w-]*):/.exec(l)?.[1]));
  const defaults = model.frontmatter.formatVersion === FORMAT_VERSION_V2 && model.frontmatter.ecosystem
    ? frontmatterLinesFor(model.frontmatter.ecosystem).slice(1, -1).map((line) => {
        const split = line.indexOf(':');
        return [line.slice(0, split), line.slice(split + 1).trim()] as const;
      })
    : FRONTMATTER_DEFAULTS;
  const missing = defaults.filter(([key]) => !present.has(key)).map(([key, value]) => `${key}: ${value}`);
  return ['---', ...inner, ...missing, '---'];
}

/**
 * Canonical form: frontmatter (format keys guaranteed), the format-owned
 * header comment, title, intro (if present), sections alphabetically sorted
 * with canonical `## name` headings, one blank line between blocks, single
 * trailing newline. Section bodies are preserved verbatim (outer blank lines
 * trimmed), so the `### Agent notes` block inside a body survives untouched.
 * Duplicate sections are kept (flagged elsewhere).
 *
 * The header comment is regenerated, not copied: it belongs to the format.
 * A file's own commentary belongs in the intro, below the title. `dir` is the
 * notes directory the file sits in (`notesDirOf` its path); the comment names
 * the AGENT-RULES.md there.
 */
export function serialize(model: NotesFileModel, dir: NotesDir = NOTES_DIR): string {
  const out: string[] = [];

  out.push(...frontmatterLines(model));

  out.push('');
  out.push(...formatCommentLines(model.frontmatter?.ecosystem, dir));

  out.push('');
  // The title is the format's, like the header comment: always `# Dependency Notes`.
  out.push(DEFAULT_TITLE);

  if (model.intro) {
    const intro = trimmedRangeLines(model, model.intro.startLine, model.intro.endLine);
    if (intro.length > 0) {
      out.push('');
      out.push(...intro);
    }
  }

  const sorted = [...model.sections].sort((a, b) => {
    const an = normalizeNameForEcosystem(a.name, model.frontmatter?.ecosystem);
    const bn = normalizeNameForEcosystem(b.name, model.frontmatter?.ecosystem);
    if (an < bn) return -1;
    if (an > bn) return 1;
    return a.headingLine - b.headingLine; // stable for duplicates
  });

  for (const s of sorted) {
    out.push('');
    out.push(`## ${s.name.trim()}`);
    const body = trimmedBodyLines(model, s);
    if (body.length > 0) {
      out.push('');
      out.push(...body);
    }
  }

  return out.join(model.eol) + model.eol;
}

/** Parse + serialize convenience. */
export function normalizeText(text: string, dir: NotesDir = NOTES_DIR): string {
  return serialize(parseNotes(text), dir);
}

/**
 * Where to insert a new section into the CURRENT (possibly unsorted) document.
 * Returns the 0-based line to insert before, or null to append at end of file.
 * If the document's sections are sorted, the sorted position is used; otherwise
 * we append at the end (no pretending).
 */
export function insertionLine(model: NotesFileModel, name: string): number | null {
  const normalize = (value: string): string => normalizeNameForEcosystem(value, model.frontmatter?.ecosystem);
  const names = model.sections.map((s) => normalize(s.name));
  const isSorted = names.every((n, i) => i === 0 || (names[i - 1] ?? '') <= n);
  if (!isSorted) return null;
  const key = normalize(name);
  for (const s of model.sections) {
    if (normalize(s.name) > key) return s.headingLine;
  }
  return null;
}

/** Snippet for a new section (empty body line when no body given). */
export function sectionSnippet(name: string, eol: string, body?: string): string {
  const head = `## ${name.trim()}${eol}${eol}`;
  if (!body || body.trim() === '') return head;
  return head + body.trim().split(/\r?\n/).join(eol) + eol;
}

/** Prefix that guarantees exactly one blank line between previous content and a new block. */
export function separatorPrefix(textBefore: string, eol: string): string {
  if (textBefore.length === 0) return '';
  if (textBefore.endsWith(eol + eol) || textBefore.endsWith('\n\n')) return '';
  if (textBefore.endsWith('\n')) return eol;
  return eol + eol;
}

/**
 * A section body from its layers: human text, then the agent block under its
 * heading (omitted when empty), then the generated block verbatim (it carries
 * its own heading). '\n'-joined; callers re-split per document eol.
 */
export function composeSectionBody(l: { human: string; agent?: string; generated?: string }): string {
  const out: string[] = [];
  const human = l.human.trim();
  const agent = (l.agent ?? '').trim();
  const generated = (l.generated ?? '').trim();
  if (human !== '') out.push(...human.split(/\r?\n/));
  if (agent !== '') {
    if (out.length > 0) out.push('');
    out.push(AGENT_NOTES_HEADING, '', ...agent.split(/\r?\n/));
  }
  if (generated !== '') {
    if (out.length > 0) out.push('');
    out.push(...generated.split(/\r?\n/));
  }
  return out.join('\n');
}

/** Rebuild `text` with `region` in place of lines [from, to) and a guaranteed trailing eol. */
function splice(model: NotesFileModel, from: number, to: number, region: string[]): string {
  const rebuilt = [...model.lines.slice(0, from), ...region, ...model.lines.slice(to)];
  let out = rebuilt.join(model.eol);
  if (!out.endsWith(model.eol)) out += model.eol;
  return out;
}

function bodyRegion(newBody: string, hasTail: boolean): string[] {
  const bodyLines = newBody.trim() === '' ? [] : newBody.trim().split(/\r?\n/);
  const region: string[] = [''];
  if (bodyLines.length > 0) {
    region.push(...bodyLines);
    if (hasTail) region.push('');
  }
  return region;
}

/**
 * Replace the WHOLE body of an existing section in a notes-file TEXT (heading
 * kept) — every layer. Returns the original text unchanged when the section is
 * not found. Human-only edits must use `replaceHumanBodyInText` instead, or
 * they wipe the agent block.
 */
export function replaceSectionBodyInText(text: string, name: string, newBody: string): string {
  const model = parseNotes(text);
  const key = normalizeNameForEcosystem(name, model.frontmatter?.ecosystem);
  const section = model.sections.find((s) => normalizeNameForEcosystem(s.name, model.frontmatter?.ecosystem) === key);
  if (!section) return text;
  const hasTail = section.bodyEnd < model.lines.length;
  return splice(model, section.headingLine + 1, section.bodyEnd, bodyRegion(newBody, hasTail));
}

/**
 * Replace only the human layer of a section: the lines between the heading and
 * the first reserved sub-heading. The `### Agent notes` and `### Generated`
 * blocks are left exactly as they were.
 */
export function replaceHumanBodyInText(text: string, name: string, human: string): string {
  const model = parseNotes(text);
  const key = normalizeNameForEcosystem(name, model.frontmatter?.ecosystem);
  const section = model.sections.find((s) => normalizeNameForEcosystem(s.name, model.frontmatter?.ecosystem) === key);
  if (!section) return text;
  const { humanEnd } = layerRanges(section);
  const hasTail = humanEnd < model.lines.length;
  return splice(model, section.headingLine + 1, humanEnd, bodyRegion(human, hasTail));
}

/**
 * Replace the human and agent layers together (the note editor's save path).
 * The generated block, if any, is carried over untouched.
 */
export function replaceSectionLayersInText(
  text: string,
  name: string,
  l: { human: string; agent: string },
): string {
  const model = parseNotes(text);
  const key = normalizeNameForEcosystem(name, model.frontmatter?.ecosystem);
  const section = model.sections.find((s) => normalizeNameForEcosystem(s.name, model.frontmatter?.ecosystem) === key);
  if (!section) return text;
  const { generated } = sectionLayers(model, section);
  return replaceSectionBodyInText(text, name, composeSectionBody({ human: l.human, agent: l.agent, generated }));
}

/**
 * Insert a new section into a notes-file TEXT at the sorted position (or append),
 * with correct blank-line separation. Pure text-level — usable without an editor.
 */
export function insertSectionIntoText(text: string, name: string, body?: string): string {
  const model = parseNotes(text);
  const eol = model.eol;
  const before = insertionLine(model, name);
  const lines = model.lines;

  if (before === null) {
    const base = text.replace(/\r?\n$/, '');
    const withSep = base + eol + separatorPrefix(base + eol, eol) + sectionSnippet(name, eol, body);
    return withSep;
  }

  const beforeText = lines.slice(0, before).join(eol) + (before > 0 ? eol : '');
  const afterText = lines.slice(before).join(eol);
  return beforeText + separatorPrefix(beforeText, eol) + sectionSnippet(name, eol, body) + afterText;
}
