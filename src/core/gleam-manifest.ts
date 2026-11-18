import { dependencyEntry } from './dependency';
import type { DependencyEntry, SourceRange } from './model';

interface ParsedKey {
  value: string;
  range: SourceRange;
}

/**
 * Dependency tables, by the scope each is reported under. Gleam documents
 * `dev_dependencies`, and also reads the older `dev-dependencies` that many published
 * packages still write: both are one scope.
 */
const DEPENDENCY_SCOPES = new Map([
  ['dependencies', 'dependencies'],
  ['dev_dependencies', 'dev_dependencies'],
  ['dev-dependencies', 'dev_dependencies'],
]);

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
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote === '"' && escaped) {
      escaped = false;
    } else if (quote === '"' && char === '\\') {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

function unquotedIndex(text: string, wanted: string): number {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote === '"' && escaped) {
      escaped = false;
    } else if (quote === '"' && char === '\\') {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === wanted) {
      return index;
    }
  }
  return -1;
}

function nestingDelta(text: string): number {
  let delta = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const char of text) {
    if (quote === '"' && escaped) {
      escaped = false;
    } else if (quote === '"' && char === '\\') {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '{' || char === '[') {
      delta++;
    } else if (char === '}' || char === ']') {
      delta--;
    }
  }
  return delta;
}

function decodeKey(raw: string): string | undefined {
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"')) return undefined;
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.startsWith("'")) return raw.endsWith("'") ? raw.slice(1, -1) : undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) return undefined;
  return raw;
}

function dependencyKey(raw: string, absoluteOffset: number): ParsedKey | undefined {
  const leading = raw.length - raw.trimStart().length;
  const token = raw.trim();
  if (!token) return undefined;
  const value = decodeKey(token);
  if (value === undefined) return undefined;
  return { value, range: { offset: absoluteOffset + leading, length: token.length } };
}

function tableName(content: string): string | undefined {
  const match = /^\s*\[\s*([^\]]+)\s*\]\s*$/.exec(content);
  return match?.[1]?.trim();
}

/** A TOML basic or literal string's content, or undefined for any other value. */
function stringValue(raw: string): string | undefined {
  const match = /^\s*(?:"([^"\\]*)"|'([^']*)')\s*$/.exec(raw);
  return match ? (match[1] ?? match[2]) : undefined;
}

/** One key of an inline table: `{ version = "~> 4.0", … }`. */
function inlineValue(raw: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|[{,\\s])${key}\\s*=\\s*(?:"([^"\\\\]*)"|'([^']*)')`).exec(raw);
  return match ? (match[1] ?? match[2]) : undefined;
}

/** A hex name, not a requirement: `hex = "other_name"` renames, `hex = "~> 1.0"` is the requirement. */
const HEX_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * The requirement a dependency writes (`">= 0.44.0 and < 2.0.0"`, `{ version = "~> 4.0" }`),
 * or where it comes from instead, prefixed as npm does so a consumer can leave it out of
 * registry checks: `git+<url>`, `file:<path>` and `package:<name>` for a renamed package.
 */
function gleamSpec(name: string, value: string): string | undefined {
  const plain = stringValue(value);
  if (plain !== undefined) return plain.trim() || undefined;
  const git = inlineValue(value, 'git');
  if (git) return `git+${git}`;
  const path = inlineValue(value, 'path');
  if (path) return `file:${path}`;
  const hex = inlineValue(value, 'hex');
  if (hex && HEX_NAME.test(hex) && hex !== name) return `package:${hex}`;
  const version = inlineValue(value, 'version') ?? (hex && !HEX_NAME.test(hex) ? hex : undefined);
  return version?.trim() || undefined;
}

/**
 * The one release an exact requirement names, or undefined. Gleam reads requirements
 * as Hex does: a version with no operator is an exact match, as `==` is.
 */
export function gleamPinnedVersion(versionSpec: string | undefined): string | undefined {
  return /^(?:==\s*)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(versionSpec?.trim() ?? '')?.[1];
}

/** Extracts direct Gleam dependencies without invoking Gleam or resolving packages. */
export function extractGleamDependencies(text: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  const seen = new Set<string>();
  let activeScope: string | undefined;
  let continuationDepth = 0;
  // An inline table that spans lines: its text so far, read once it closes.
  let pending: { index: number; name: string; text: string } | undefined;
  const setSpec = (index: number, name: string, value: string): void => {
    const versionSpec = gleamSpec(name, value);
    if (versionSpec) out[index] = { ...out[index]!, versionSpec };
  };

  for (const line of splitLines(text)) {
    const content = contentBeforeComment(line.text);
    if (continuationDepth > 0) {
      continuationDepth = Math.max(0, continuationDepth + nestingDelta(content));
      if (pending) {
        pending.text += `\n${content}`;
        if (continuationDepth === 0) {
          setSpec(pending.index, pending.name, pending.text);
          pending = undefined;
        }
      }
      continue;
    }

    if (content.trimStart().startsWith('[')) {
      const name = tableName(content);
      activeScope = name ? DEPENDENCY_SCOPES.get(name) : undefined;
      continue;
    }
    if (!activeScope) continue;

    const equals = unquotedIndex(content, '=');
    if (equals < 0) continue;
    const key = dependencyKey(content.slice(0, equals), line.offset);
    if (!key) continue;

    const id = `${activeScope}\0${key.value}`;
    const value = content.slice(equals + 1);
    continuationDepth = Math.max(0, nestingDelta(value));
    if (!seen.has(id)) {
      seen.add(id);
      out.push(dependencyEntry(key.value, activeScope, key.range));
      if (continuationDepth > 0) pending = { index: out.length - 1, name: key.value, text: value };
      else setSpec(out.length - 1, key.value, value);
    }
  }

  return out;
}
