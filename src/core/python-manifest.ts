import { dependencyEntry } from './dependency';
import type { DependencyEntry, SourceRange } from './model';
import { commentStart, lineRecords, nestingDelta, unquotedEquals } from './toml-scan';

interface TomlString {
  value: string;
  range: SourceRange;
  contentOffset: number;
  rawContent: string;
}

interface TomlAssignment {
  table: string[];
  key: string;
  keyRange: SourceRange;
  valueText: string;
  valueOffset: number;
}

export function normalizePythonPackageName(value: string): string {
  return value.trim().toLowerCase().replace(/[._-]+/g, '-');
}

function splitDottedKey(raw: string): string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  const push = (end: number): boolean => {
    const token = raw.slice(start, end).trim();
    if (!token) return false;
    if ((token[0] === '"' || token[0] === "'") && token.at(-1) === token[0]) {
      parts.push(token.slice(1, -1));
    } else parts.push(token);
    return true;
  };
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (quote === '"' && escaped) escaped = false;
    else if (quote === '"' && char === '\\') escaped = true;
    else if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '.') {
      if (!push(i)) return undefined;
      start = i + 1;
    }
  }
  return !quote && push(raw.length) ? parts : undefined;
}

function tomlAssignments(text: string): TomlAssignment[] {
  const lines = lineRecords(text);
  const out: TomlAssignment[] = [];
  let table: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const content = line.text.slice(0, commentStart(line.text));
    const trimmed = content.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('[')) {
      if (!trimmed.startsWith('[[') && trimmed.endsWith(']')) {
        table = splitDottedKey(trimmed.slice(1, -1)) ?? [];
      } else table = [];
      continue;
    }
    const equals = unquotedEquals(content);
    if (equals < 0) continue;
    const rawKey = content.slice(0, equals);
    const keyToken = rawKey.trim();
    const keyParts = splitDottedKey(keyToken);
    if (!keyParts?.length) continue;
    const keyLeading = rawKey.length - rawKey.trimStart().length;
    const keyRawOffset = line.offset + keyLeading;
    const quoted = (keyToken[0] === '"' || keyToken[0] === "'") && keyToken.at(-1) === keyToken[0];
    const keyRange = {
      offset: keyRawOffset + (quoted ? 1 : 0),
      length: keyToken.length - (quoted ? 2 : 0),
    };
    let valueText = content.slice(equals + 1);
    const valueOffset = line.offset + equals + 1;
    let depth = nestingDelta(valueText);
    while (depth > 0 && i + 1 < lines.length) {
      const next = lines[++i]!;
      const nextContent = next.text.slice(0, commentStart(next.text));
      valueText += ' '.repeat(Math.max(0, next.offset - (valueOffset + valueText.length))) + nextContent;
      depth += nestingDelta(nextContent);
    }
    out.push({ table, key: keyParts.join('.'), keyRange, valueText, valueOffset });
  }
  return out;
}

function arrayStrings(assignment: TomlAssignment): TomlString[] {
  const out: TomlString[] = [];
  const raw = assignment.valueText;
  let inlineTableDepth = 0;
  for (let i = 0; i < raw.length; i++) {
    const quote = raw[i];
    if (quote === '{') {
      inlineTableDepth++;
      continue;
    }
    if (quote === '}') {
      inlineTableDepth = Math.max(0, inlineTableDepth - 1);
      continue;
    }
    if (quote !== '"' && quote !== "'") continue;
    if (raw.slice(i, i + 3) === quote.repeat(3)) {
      const end = raw.indexOf(quote.repeat(3), i + 3);
      if (end < 0) break;
      i = end + 2;
      continue;
    }
    const start = i;
    let escaped = false;
    for (i++; i < raw.length; i++) {
      const char = raw[i]!;
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && char === '\\') escaped = true;
      else if (char === quote) break;
    }
    if (i >= raw.length) break;
    const rawContent = raw.slice(start + 1, i);
    if (inlineTableDepth === 0) {
      out.push({
        value: rawContent,
        rawContent,
        contentOffset: assignment.valueOffset + start + 1,
        range: { offset: assignment.valueOffset + start, length: i - start + 1 },
      });
    }
  }
  return out;
}

function requirementName(raw: string): { name: string; start: number; length: number } | undefined {
  const match = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(raw);
  if (!match?.[1]) return undefined;
  const end = match[0].length;
  const next = raw[end];
  if (next && !/[\s[(<>=!~@;]/.test(next)) return undefined;
  return { name: match[1], start: match[0].length - match[1].length, length: match[1].length };
}

/**
 * What a PEP 508 requirement writes after its name and extras: the version
 * specifier (`>=2.31`, `==2.0.1`), or `@ <url>` for a direct reference. The
 * environment marker after `;` is left out. Undefined when it writes neither.
 */
export function requirementSpec(raw: string, nameEnd: number): string | undefined {
  let rest = raw.slice(nameEnd).trimStart();
  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close < 0) return undefined;
    rest = rest.slice(close + 1).trimStart();
  }
  const marker = rest.indexOf(';');
  if (marker >= 0) rest = rest.slice(0, marker);
  rest = rest.trim();
  if (rest.startsWith('@')) {
    const url = rest.slice(1).trim();
    return url ? `@ ${url}` : undefined;
  }
  // The old form in parentheses: `name (>=1.0)`.
  if (rest.startsWith('(') && rest.endsWith(')')) rest = rest.slice(1, -1).trim();
  return rest || undefined;
}

/**
 * The one release an exact pin names (`==2.0.1`, `===2.0.1`), or undefined. A
 * range, a wildcard (`==2.*`), several clauses or a URL can install more than
 * one release. Requirements files from `pip freeze` and `pip-compile` pin
 * every package this way.
 */
export function pythonPinnedVersion(versionSpec: string | undefined): string | undefined {
  const match = /^===?\s*([A-Za-z0-9][A-Za-z0-9!+._-]*)$/.exec(versionSpec?.trim() ?? '');
  return match?.[1];
}

function withSpec(entry: DependencyEntry, versionSpec: string | undefined): DependencyEntry {
  return versionSpec ? { ...entry, versionSpec } : entry;
}

function entryFromRequirement(value: TomlString, scope: string): DependencyEntry | undefined {
  const parsed = requirementName(value.rawContent);
  if (!parsed) return undefined;
  const range = { offset: value.contentOffset + parsed.start, length: parsed.length };
  return withSpec(
    dependencyEntry(normalizePythonPackageName(parsed.name), scope, range, [range], parsed.name, value.range),
    requirementSpec(value.rawContent, parsed.start + parsed.length),
  );
}

/**
 * The version a Poetry dependency writes: the string (`"^2.0"`), or the
 * `version` key of its inline table. Poetry's own syntax, not PEP 440; a
 * path, git or url dependency has none.
 */
function poetrySpec(valueText: string): string | undefined {
  const text = valueText.trim();
  const plain = /^(["'])(.*)\1$/.exec(text);
  if (plain) return plain[2]!.trim() || undefined;
  if (!text.startsWith('{')) return undefined;
  const version = /(?:^|[{,\s])version\s*=\s*(["'])([^"']*)\1/.exec(text);
  return version?.[2]?.trim() || undefined;
}

function tableEquals(table: readonly string[], ...wanted: string[]): boolean {
  return table.length === wanted.length && table.every((part, index) => part === wanted[index]);
}

/** Static pyproject.toml parser. It records only dependency declarations and never evaluates a build backend. */
export function extractPyprojectDependencies(text: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  for (const assignment of tomlAssignments(text)) {
    let arrayScope: string | undefined;
    if (tableEquals(assignment.table, 'project') && assignment.key === 'dependencies') arrayScope = 'project';
    else if (tableEquals(assignment.table, 'project', 'optional-dependencies')) arrayScope = `extra:${assignment.key}`;
    else if (tableEquals(assignment.table, 'dependency-groups')) arrayScope = `group:${assignment.key}`;
    else if (tableEquals(assignment.table, 'build-system') && assignment.key === 'requires') arrayScope = 'build-system';
    else if (tableEquals(assignment.table, 'tool', 'uv') && assignment.key === 'dev-dependencies') arrayScope = 'uv:dev';
    if (arrayScope) {
      for (const value of arrayStrings(assignment)) {
        const entry = entryFromRequirement(value, arrayScope);
        if (entry) out.push(entry);
      }
      continue;
    }

    let poetryScope: string | undefined;
    if (tableEquals(assignment.table, 'tool', 'poetry', 'dependencies')) poetryScope = 'poetry:main';
    else if (tableEquals(assignment.table, 'tool', 'poetry', 'dev-dependencies')) poetryScope = 'poetry:dev';
    else if (
      assignment.table.length === 5
      && assignment.table[0] === 'tool'
      && assignment.table[1] === 'poetry'
      && assignment.table[2] === 'group'
      && assignment.table[4] === 'dependencies'
    ) poetryScope = `poetry:group:${assignment.table[3]}`;
    if (poetryScope && assignment.key.toLowerCase() !== 'python') {
      const displayName = assignment.key;
      out.push(withSpec(dependencyEntry(
        normalizePythonPackageName(displayName),
        poetryScope,
        assignment.keyRange,
        [assignment.keyRange],
        displayName,
        assignment.keyRange,
      ), poetrySpec(assignment.valueText)));
    }
  }
  return out;
}

function requirementsLogicalLines(text: string): Array<{ value: string; positions: number[] }> {
  const lines = lineRecords(text);
  const out: Array<{ value: string; positions: number[] }> = [];
  let value = '';
  let positions: number[] = [];
  for (const line of lines) {
    let part = line.text;
    const continued = /\\\s*$/.test(part);
    if (continued) part = part.replace(/\\\s*$/, '');
    for (let i = 0; i < part.length; i++) {
      value += part[i];
      positions.push(line.offset + i);
    }
    if (continued) {
      value += ' ';
      positions.push(line.offset + line.text.length);
    } else {
      out.push({ value, positions });
      value = '';
      positions = [];
    }
  }
  if (value) out.push({ value, positions });
  return out;
}

function requirementCommentStart(value: string): number {
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '#' && (i === 0 || /\s/.test(value[i - 1]!))) return i;
  }
  return value.length;
}

/** Parses named requirements from one pip requirements file; includes and constraints remain separate manifests. */
export function extractRequirementsDependencies(text: string, scope = 'requirements.txt'): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  for (const logical of requirementsLogicalLines(text)) {
    const withoutComment = logical.value.slice(0, requirementCommentStart(logical.value));
    const leading = withoutComment.length - withoutComment.trimStart().length;
    let candidate = withoutComment.trimStart();
    let candidateStart = leading;
    if (!candidate) continue;
    if (/^(?:-r|--requirement|-c|--constraint)(?:\s|=)/.test(candidate) || candidate.startsWith('--')) continue;
    const editable = /^(?:-e|--editable)(?:\s+|=)/.exec(candidate);
    if (editable) {
      candidateStart += editable[0].length;
      candidate = candidate.slice(editable[0].length);
    } else if (candidate.startsWith('-')) continue;

    let parsed = requirementName(candidate);
    // An editable install or an `#egg=` reference is a checkout, not a release: it has no version spec.
    let versionSpec = parsed && !editable
      // Per-requirement options (`--hash=…`) follow the requirement after a space.
      ? requirementSpec(candidate.replace(/\s+--?[A-Za-z].*$/, ''), parsed.start + parsed.length)
      : undefined;
    if (!parsed) {
      const egg = /[#&]egg=([A-Za-z0-9][A-Za-z0-9._-]*)/i.exec(candidate);
      if (egg?.[1] && egg.index >= 0) {
        parsed = { name: egg[1], start: egg.index + egg[0].length - egg[1].length, length: egg[1].length };
        versionSpec = undefined;
      }
    }
    if (!parsed) continue;
    const logicalStart = candidateStart + parsed.start;
    const offset = logical.positions[logicalStart];
    if (offset === undefined) continue;
    const range = { offset, length: parsed.length };
    out.push(withSpec(dependencyEntry(
      normalizePythonPackageName(parsed.name),
      scope,
      range,
      [range],
      parsed.name,
      range,
    ), versionSpec));
  }
  return out;
}

export function pythonRequirementsScope(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const marker = '/requirements/';
  const index = normalized.toLowerCase().lastIndexOf(marker);
  if (index >= 0) return normalized.slice(index + 1);
  return normalized.split('/').at(-1) ?? 'requirements.txt';
}
