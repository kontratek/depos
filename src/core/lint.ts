import { AGENT_FIELDS, EXPOSURE_VALUES, RUNTIME_VALUES } from './vocabulary';
import { AGENT_FIELD_RE, layerRanges } from './layers';
import type { ManifestKind, NoteSection, NotesFileModel } from './model';
import { normalizeNameForEcosystem } from './match';
import { closest, levenshtein } from './similar';
import { DEFAULT_TITLE, FORMAT_VERSION_V2, SUPPORTED_FORMAT_VERSIONS } from './template';

/** Columns [start, end) within the finding's line: the key, or the value at fault. */
export interface Span {
  start: number;
  end: number;
}

/** What a heading inside a section was most likely meant to be. */
export type StrayHeadingMeant = 'agent-notes' | 'generated';

export type LintFinding =
  | { kind: 'wrongHeadingLevel'; line: number; name: string; level: number }
  | { kind: 'missingSpaceAfterHashes'; line: number; name: string }
  | { kind: 'missingFrontmatter'; line: number }
  /** `format:` names a version this Depos does not read. */
  | { kind: 'unknownFormat'; line: number; version: string }
  | { kind: 'missingEcosystem'; line: number }
  | { kind: 'wrongEcosystem'; line: number; actual: string; expected: ManifestKind }
  /** The one `#` heading is `# Dependency Notes`: missing, worded differently, or repeated. */
  | { kind: 'missingTitle'; line: number }
  | { kind: 'wrongTitle'; line: number; text: string }
  | { kind: 'extraTitle'; line: number; text: string }
  /** A heading inside a section other than `### Agent notes`. */
  | { kind: 'strayHeading'; line: number; text: string; level: number; meant?: StrayHeadingMeant }
  /** A `- key: value` line under `### Agent notes` whose key is not in the
   *  vocabulary. `suggestion` is the field a misspelling most likely meant. */
  | { kind: 'unknownAgentKey'; line: number; key: string; value: string; span: Span; suggestion?: string }
  | { kind: 'emptyAgentValue'; line: number; key: string; span: Span }
  | { kind: 'badAgentValue'; line: number; key: string; value: string; expected: string; span: Span }
  /** `status: removed …` on a package that is still in package.json. */
  | { kind: 'removedButPresent'; line: number; name: string; span: Span };

const ANY_HEADING_RE = /^(#{1,6})(?!#)\s+(.+?)\s*$/;
const NO_SPACE_H2_RE = /^##(?=[^#\s])(.+?)\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const TITLE_TEXT = DEFAULT_TITLE.replace(/^#\s+/, '');

const AGENT_KEY_LIST = AGENT_FIELDS.map((f) => f.key);
const AGENT_KEYS = new Set(AGENT_KEY_LIST);
/** Nothing, or only dashes: the placeholder agents write when they have nothing to say. */
const EMPTY_VALUE_RE = /^[-—–]*$/;
const STATUS_RE = /^(dead|removal-planned|removed\s+\d{4}-\d{2}(\b.*)?)$/i;
const VERSION_RE = /^v?\d+(\.\d+)*/i;

/**
 * The vocabulary key a misspelling most likely meant (`contraint` →
 * `constraint`, `bump_with` → `bump-with`, `notes` → `note`), when it is
 * close enough to be sure; undefined otherwise, so `dafdsf` gets no guess.
 */
export function closestAgentKey(key: string): string | undefined {
  return closest(key, AGENT_KEY_LIST);
}

/** `### Agent Note`, `### AI notes` → the agent heading; `### Generated` → the reserved one. */
export function classifyStrayHeading(text: string): StrayHeadingMeant | undefined {
  const t = text.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t === 'generated') return 'generated';
  if (/\bagents?\b|\bai\b/.test(t) || levenshtein(t, 'agent notes') <= 3) return 'agent-notes';
  return undefined;
}

/** What the value of an enumerated field must look like, or undefined when it is fine. */
function valueProblem(key: string, value: string): string | undefined {
  const oneOf = (allowed: readonly string[]): string | undefined =>
    value
      .toLowerCase()
      .split(/\s*[,|/]\s*/)
      .every((v) => allowed.includes(v))
      ? undefined
      : `one of ${allowed.join(' | ')}`;
  switch (key) {
    case 'runtime':
      return oneOf(RUNTIME_VALUES);
    case 'exposure':
      return oneOf(EXPOSURE_VALUES);
    case 'status':
      return STATUS_RE.test(value) ? undefined : 'dead | removal-planned | removed YYYY-MM — reason';
    case 'verified':
      return VERSION_RE.test(value) ? undefined : 'a version, e.g. 4.18.2';
    default:
      return undefined;
  }
}

/**
 * Format lint — every finding is a mistake with a fix, never a matter of taste:
 * - the frontmatter and its `format:` version; the one `# Dependency Notes` title;
 * - `## name` is a package (so a dependency name under another level, or
 *   `##name`, is a mistake), and inside a section the only heading is
 *   `### Agent notes` — anything else is plain text;
 * - the agent layer has a fixed vocabulary: unknown keys, empty values,
 *   enumerated values of the wrong shape, and `status: removed` on a package
 *   that is still in package.json.
 * The human text itself is never looked at, and prose lines in the agent block
 * are fine.
 */
export function lintNotes(
  model: NotesFileModel,
  depNames: readonly string[],
  expectedEcosystem?: ManifestKind,
): LintFinding[] {
  const findings: LintFinding[] = [];
  const normalize = (name: string): string => normalizeNameForEcosystem(name, model.frontmatter?.ecosystem);
  const deps = new Set(depNames.map(normalize));

  if (!model.frontmatter) {
    findings.push({ kind: 'missingFrontmatter', line: 0 });
  } else if (
    model.frontmatter.formatVersion !== undefined
    && !(SUPPORTED_FORMAT_VERSIONS as readonly string[]).includes(model.frontmatter.formatVersion)
  ) {
    let line = model.frontmatter.startLine;
    for (let i = model.frontmatter.startLine; i <= model.frontmatter.endLine; i++) {
      if (/^format\s*:/.test(model.lines[i] ?? '')) {
        line = i;
        break;
      }
    }
    findings.push({ kind: 'unknownFormat', line, version: model.frontmatter.formatVersion });
  }
  if (model.frontmatter?.formatVersion === FORMAT_VERSION_V2) {
    if (!model.frontmatter.ecosystem) {
      findings.push({ kind: 'missingEcosystem', line: model.frontmatter.startLine });
    } else if (expectedEcosystem && model.frontmatter.ecosystem !== expectedEcosystem) {
      findings.push({
        kind: 'wrongEcosystem',
        line: model.frontmatter.startLine,
        actual: model.frontmatter.ecosystem,
        expected: expectedEcosystem,
      });
    }
  }

  // A `# lodash` where lodash is a dependency is a package heading at the
  // wrong level, not a title; the loop below reports it as such.
  const titleText = model.titleLine === undefined ? undefined : (model.lines[model.titleLine] ?? '').replace(/^#\s+/, '').trim();
  const titleIsDep = titleText !== undefined && deps.has(normalize(titleText));
  if (model.titleLine === undefined) {
    const after = model.aiComment?.endLine ?? model.frontmatter?.endLine;
    const line = after === undefined ? 0 : Math.min(after + 1, Math.max(model.lines.length - 1, 0));
    findings.push({ kind: 'missingTitle', line });
  } else if (titleText !== undefined && titleText !== TITLE_TEXT && !titleIsDep) {
    findings.push({ kind: 'wrongTitle', line: model.titleLine, text: titleText });
  }

  const inHeaderBlock = (line: number): boolean => {
    if (model.frontmatter && line >= model.frontmatter.startLine && line <= model.frontmatter.endLine) return true;
    if (model.aiComment && line >= model.aiComment.startLine && line <= model.aiComment.endLine) return true;
    return false;
  };
  const sectionAt = (line: number): NoteSection | undefined =>
    model.sections.find((s) => line >= s.bodyStart && line < s.bodyEnd);

  let inFence = false;
  for (let i = 0; i < model.lines.length; i++) {
    const line = model.lines[i] ?? '';
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || inHeaderBlock(i) || (i === model.titleLine && !titleIsDep)) continue;

    const noSpace = NO_SPACE_H2_RE.exec(line);
    if (noSpace && noSpace[1] !== undefined && deps.has(normalize(noSpace[1]))) {
      findings.push({ kind: 'missingSpaceAfterHashes', line: i, name: noSpace[1].trim() });
      continue;
    }

    const h = ANY_HEADING_RE.exec(line);
    if (!h || h[1] === undefined || h[2] === undefined) continue;
    const level = h[1].length;
    const text = h[2].trim();
    if (level !== 2 && deps.has(normalize(text))) {
      findings.push({ kind: 'wrongHeadingLevel', line: i, name: text, level });
      continue;
    }
    if (level === 1) {
      findings.push({ kind: 'extraTitle', line: i, text });
      continue;
    }
    if (level >= 3) {
      const section = sectionAt(i);
      if (!section || i === section.agentHeadingLine) continue; // intro headings are free
      const meant = i === section.generatedHeadingLine ? 'generated' : classifyStrayHeading(text);
      findings.push(
        meant === undefined
          ? { kind: 'strayHeading', line: i, text, level }
          : { kind: 'strayHeading', line: i, text, level, meant },
      );
    }
  }

  for (const section of model.sections) {
    const r = layerRanges(section);
    if (r.agentStart === undefined || r.agentEnd === undefined) continue;
    let agentFence = false;
    for (let i = r.agentStart; i < r.agentEnd; i++) {
      const line = model.lines[i] ?? '';
      if (FENCE_RE.test(line)) {
        agentFence = !agentFence;
        continue;
      }
      if (agentFence) continue;
      const m = AGENT_FIELD_RE.exec(line);
      if (!m || m[1] === undefined || m[2] === undefined) continue; // prose is fine
      if (m[2].startsWith('//')) continue; // a bare URL (`- https://…`), not a field
      const key = m[1].toLowerCase();
      const value = m[2].trim();
      const keyStart = line.indexOf(m[1]);
      const keySpan: Span = { start: keyStart, end: keyStart + m[1].length };
      // `(.*)$` runs to the end of the line, so the raw value starts there.
      const valueStart = line.length - m[2].length;
      const valueSpan: Span = { start: valueStart, end: valueStart + value.length };
      if (!AGENT_KEYS.has(key)) {
        const suggestion = closestAgentKey(key);
        findings.push(
          suggestion === undefined
            ? { kind: 'unknownAgentKey', line: i, key, value, span: keySpan }
            : { kind: 'unknownAgentKey', line: i, key, value, span: keySpan, suggestion },
        );
        continue;
      }
      if (EMPTY_VALUE_RE.test(value)) {
        findings.push({ kind: 'emptyAgentValue', line: i, key, span: keySpan });
        continue;
      }
      if (key === 'status' && /^removed\b/i.test(value) && deps.has(normalize(section.name))) {
        findings.push({ kind: 'removedButPresent', line: i, name: section.name, span: valueSpan });
        continue;
      }
      const expected = valueProblem(key, value);
      if (expected !== undefined) {
        findings.push({ kind: 'badAgentValue', line: i, key, value, expected, span: valueSpan });
      }
    }
  }

  return findings;
}
