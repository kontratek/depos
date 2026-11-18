import { dependencyEntry } from './dependency';
import type { DependencyEntry, SourceRange } from './model';

interface KeyPart {
  value: string;
  range: SourceRange;
}

const DEPENDENCY_TABLES = new Set(['dependencies', 'dev-dependencies', 'build-dependencies']);

function splitLines(text: string): Array<{ text: string; offset: number }> {
  const lines: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  for (const line of text.split(/\r?\n/)) {
    lines.push({ text: line, offset });
    offset += line.length + (text.slice(offset + line.length, offset + line.length + 2) === '\r\n' ? 2 : 1);
  }
  return lines;
}

function contentBeforeComment(line: string): string {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '#') return line.slice(0, i);
  }
  return line;
}

function decodeKey(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

function keyParts(raw: string, absoluteOffset: number): KeyPart[] | undefined {
  const out: KeyPart[] = [];
  let start = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  const push = (end: number): boolean => {
    const segment = raw.slice(start, end);
    const leading = segment.length - segment.trimStart().length;
    const token = segment.trim();
    if (token === '') return false;
    if ((token.startsWith('"') && !token.endsWith('"')) || (token.startsWith("'") && !token.endsWith("'"))) {
      return false;
    }
    out.push({
      value: decodeKey(token),
      range: { offset: absoluteOffset + start + leading, length: token.length },
    });
    return true;
  };

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '.') {
      if (!push(i)) return undefined;
      start = i + 1;
    }
  }
  if (quote || !push(raw.length)) return undefined;
  return out;
}

function unquotedIndex(raw: string, wanted: string): number {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === wanted) return i;
  }
  return -1;
}

function nestingDelta(raw: string): number {
  let delta = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{' || char === '[') delta++;
    else if (char === '}' || char === ']') delta--;
  }
  return delta;
}

function tableHeader(line: string): { body: string; start: number } | undefined {
  const leading = line.length - line.trimStart().length;
  if (line[leading] !== '[' || line[leading + 1] === '[') return undefined;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = leading + 1; i < line.length; i++) {
    const char = line[i]!;
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ']') return { body: line.slice(leading + 1, i), start: leading + 1 };
  }
  return undefined;
}

function tableScope(parts: readonly KeyPart[]): { scope: string; dependencyIndex?: number } | undefined {
  if (parts.length === 0 || parts[0]!.value === 'workspace') return undefined;
  let sectionIndex = -1;
  if (DEPENDENCY_TABLES.has(parts[0]!.value)) sectionIndex = 0;
  else if (parts[0]!.value === 'target') {
    sectionIndex = parts.findIndex((part, index) => index >= 2 && DEPENDENCY_TABLES.has(part.value));
  }
  if (sectionIndex < 0) return undefined;
  const section = parts[sectionIndex]!.value;
  const scope = sectionIndex === 0
    ? section
    : `target:${parts.slice(1, sectionIndex).map((part) => part.value).join('.')}/${section}`;
  return { scope, dependencyIndex: parts.length > sectionIndex + 1 ? sectionIndex + 1 : undefined };
}

/** The keys of a dependency that say where it comes from (https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html). */
const SOURCE_KEYS = ['version', 'git', 'path', 'package', 'registry'] as const;
type SourceKey = typeof SOURCE_KEYS[number];
type SourceKeys = Partial<Record<SourceKey, string>>;

function isSourceKey(key: string): key is SourceKey {
  return (SOURCE_KEYS as readonly string[]).includes(key);
}

/** A TOML basic or literal string's content, or undefined for any other value. */
function stringValue(raw: string): string | undefined {
  const text = raw.trim();
  const match = /^"([^"\\]*)"$|^'([^']*)'$/.exec(text);
  return match ? (match[1] ?? match[2]) : undefined;
}

/** The source keys an inline table writes: `{ version = "1", features = [...] }`. */
function inlineSourceKeys(raw: string): SourceKeys {
  const keys: SourceKeys = {};
  for (const match of raw.matchAll(/(?:^|[{,\s])(version|git|path|package|registry)\s*=\s*(?:"([^"\\]*)"|'([^']*)')/g)) {
    keys[match[1] as SourceKey] = match[2] ?? match[3];
  }
  return keys;
}

/**
 * The version a dependency writes (`"1.0"`, `"=1.2.3"`), or where it comes from
 * instead, in npm's prefixed form so a consumer can tell it is not a crates.io
 * release under this name: `git+<url>`, `file:<path>`, `registry:<name>` (another
 * registry) and `package:<name>` (renamed: the key is not the crate's name).
 * Undefined when it writes none, as `workspace = true` does.
 */
function cargoSpec(keys: SourceKeys): string | undefined {
  if (keys.git) return `git+${keys.git}`;
  if (keys.path) return `file:${keys.path}`;
  if (keys.registry) return `registry:${keys.registry}`;
  if (keys.package) return `package:${keys.package}`;
  return keys.version || undefined;
}

/**
 * The one release an exact requirement names (`=1.2.3`), or undefined. A bare
 * `1.2.3` is a caret requirement in Cargo, not a pin.
 */
export function cargoPinnedVersion(versionSpec: string | undefined): string | undefined {
  return /^=\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(versionSpec?.trim() ?? '')?.[1];
}

/** Extracts direct Cargo dependencies without evaluating a workspace or running Cargo. */
export function extractCargoDependencies(text: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  const indexById = new Map<string, number>();
  const sources = new Map<number, SourceKeys>();
  let activeScope: string | undefined;
  // A `[dependencies.serde]` table: its own keys follow, one per line.
  let tableEntry: number | undefined;
  let continuationDepth = 0;
  // An inline table that spans lines: its text so far, read once it closes.
  let pending: { index: number; text: string } | undefined;

  const add = (part: KeyPart, scope: string): number => {
    const id = `${scope}\0${part.value}`;
    const known = indexById.get(id);
    if (known !== undefined) return known;
    out.push(dependencyEntry(part.value, scope, part.range));
    indexById.set(id, out.length - 1);
    return out.length - 1;
  };
  const setSource = (index: number, keys: SourceKeys): void => {
    sources.set(index, { ...sources.get(index), ...keys });
  };

  for (const line of splitLines(text)) {
    const content = contentBeforeComment(line.text);
    if (continuationDepth > 0) {
      continuationDepth = Math.max(0, continuationDepth + nestingDelta(content));
      if (pending) {
        pending.text += `\n${content}`;
        if (continuationDepth === 0) {
          setSource(pending.index, inlineSourceKeys(pending.text));
          pending = undefined;
        }
      }
      continue;
    }
    const header = tableHeader(content);
    if (!header && content.trimStart().startsWith('[')) {
      activeScope = undefined;
      tableEntry = undefined;
      continue;
    }
    if (header) {
      const parts = keyParts(header.body, line.offset + header.start);
      const context = parts ? tableScope(parts) : undefined;
      activeScope = context?.dependencyIndex === undefined ? context?.scope : undefined;
      tableEntry = undefined;
      if (parts && context?.dependencyIndex !== undefined) {
        const dependency = parts[context.dependencyIndex];
        if (dependency) {
          const index = add(dependency, context.scope);
          // Only the dependency's own table holds its source keys, not `[dependencies.x.features]`.
          if (parts.length === context.dependencyIndex + 1) tableEntry = index;
        }
      }
      continue;
    }
    const equals = unquotedIndex(content, '=');
    if (equals < 0) continue;
    const rawKey = content.slice(0, equals);
    const value = content.slice(equals + 1);
    if (tableEntry !== undefined) {
      const key = rawKey.trim();
      const text = stringValue(value);
      if (isSourceKey(key) && text !== undefined) setSource(tableEntry, { [key]: text });
      continue;
    }
    if (!activeScope) continue;
    const leading = rawKey.length - rawKey.trimStart().length;
    const parts = keyParts(rawKey.trim(), line.offset + leading);
    if (parts?.[0]) {
      const index = add(parts[0], activeScope);
      if (parts.length === 1) {
        // `serde = "1.0"` or `serde = { version = "1.0", … }`, the table maybe over several lines.
        const plain = stringValue(value);
        if (plain !== undefined) setSource(index, { version: plain });
        else if (nestingDelta(value) > 0) pending = { index, text: value };
        else setSource(index, inlineSourceKeys(value));
      }
      else if (parts.length === 2 && isSourceKey(parts[1]!.value)) {
        // `serde.version = "1.0"`.
        const text = stringValue(value);
        if (text !== undefined) setSource(index, { [parts[1]!.value]: text });
      }
    }
    continuationDepth = Math.max(0, nestingDelta(value));
  }
  return out.map((entry, index) => {
    const versionSpec = cargoSpec(sources.get(index) ?? {});
    return versionSpec ? { ...entry, versionSpec } : entry;
  });
}
