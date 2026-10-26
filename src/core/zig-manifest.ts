import { dependencyEntry } from './dependency';
import type { DependencyEntry, SourceRange } from './model';

type TokenKind = 'identifier' | 'string' | 'symbol';

interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
  contentStart?: number;
  contentEnd?: number;
}

interface ZonField {
  name: string;
  primaryRange: SourceRange;
  sourceRange: SourceRange;
  iconRange: SourceRange;
  equalsIndex: number;
}

const OPEN_TO_CLOSE: Readonly<Record<string, string>> = {
  '{': '}',
  '[': ']',
  '(': ')',
};

function decodeString(value: string): string {
  let out = '';
  for (let cursor = 0; cursor < value.length; cursor++) {
    const char = value[cursor]!;
    if (char !== '\\' || cursor + 1 >= value.length) {
      out += char;
      continue;
    }
    const escaped = value[++cursor]!;
    if (escaped === 'n') out += '\n';
    else if (escaped === 'r') out += '\r';
    else if (escaped === 't') out += '\t';
    else if (escaped === 'x') {
      const digits = value.slice(cursor + 1, cursor + 3);
      const code = /^[0-9A-Fa-f]{2}$/.test(digits) ? Number.parseInt(digits, 16) : undefined;
      if (code === undefined) out += 'x';
      else {
        out += String.fromCodePoint(code);
        cursor += 2;
      }
    } else if (escaped === 'u' && value[cursor + 1] === '{') {
      const close = value.indexOf('}', cursor + 2);
      const digits = close < 0 ? '' : value.slice(cursor + 2, close);
      const code = /^[0-9A-Fa-f]{1,6}$/.test(digits) ? Number.parseInt(digits, 16) : undefined;
      if (code === undefined || code > 0x10ffff) out += 'u';
      else {
        out += String.fromCodePoint(code);
        cursor = close;
      }
    } else {
      out += escaped;
    }
  }
  return out;
}

/** A small, tolerant ZON lexer. Depos reads manifests as text and never invokes Zig. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const char = text[cursor]!;
    if (/\s/.test(char)) {
      cursor++;
      continue;
    }
    if (char === '/' && text[cursor + 1] === '/') {
      cursor += 2;
      while (cursor < text.length && text[cursor] !== '\r' && text[cursor] !== '\n') cursor++;
      continue;
    }
    // A Zig multiline-string line starts with two backslashes and runs to EOL.
    if (char === '\\' && text[cursor + 1] === '\\') {
      cursor += 2;
      while (cursor < text.length && text[cursor] !== '\r' && text[cursor] !== '\n') cursor++;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const start = cursor++;
      const contentStart = cursor;
      while (cursor < text.length) {
        if (text[cursor] === '\\' && cursor + 1 < text.length) {
          cursor += 2;
          continue;
        }
        if (text[cursor] === quote) break;
        cursor++;
      }
      const contentEnd = cursor;
      if (cursor < text.length) cursor++;
      const raw = text.slice(contentStart, contentEnd);
      tokens.push({
        kind: 'string',
        value: quote === '"' ? decodeString(raw) : raw,
        start,
        end: cursor,
        contentStart,
        contentEnd,
      });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = cursor++;
      while (cursor < text.length && /[A-Za-z0-9_]/.test(text[cursor]!)) cursor++;
      tokens.push({ kind: 'identifier', value: text.slice(start, cursor), start, end: cursor });
      continue;
    }
    tokens.push({ kind: 'symbol', value: char, start: cursor, end: cursor + 1 });
    cursor++;
  }
  return tokens;
}

function fieldAt(tokens: readonly Token[], dotIndex: number): ZonField | undefined {
  const dot = tokens[dotIndex];
  if (dot?.value !== '.') return undefined;
  const next = tokens[dotIndex + 1];
  if (!next) return undefined;

  let name: string;
  let primaryRange: SourceRange;
  let sourceRange: SourceRange;
  let equalsIndex: number;
  if (next.kind === 'identifier') {
    name = next.value;
    primaryRange = { offset: next.start, length: next.end - next.start };
    sourceRange = primaryRange;
    equalsIndex = dotIndex + 2;
  } else if (next.value === '@' && tokens[dotIndex + 2]?.kind === 'string') {
    const quoted = tokens[dotIndex + 2]!;
    name = quoted.value;
    primaryRange = {
      offset: quoted.contentStart ?? quoted.start,
      length: (quoted.contentEnd ?? quoted.end) - (quoted.contentStart ?? quoted.start),
    };
    sourceRange = { offset: next.start, length: quoted.end - next.start };
    equalsIndex = dotIndex + 3;
  } else {
    return undefined;
  }
  if (tokens[equalsIndex]?.value !== '=') return undefined;
  return {
    name,
    primaryRange,
    sourceRange,
    iconRange: { offset: dot.start, length: dot.end - dot.start },
    equalsIndex,
  };
}

function dependenciesOpen(tokens: readonly Token[]): number | undefined {
  const stack: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (stack.length === 1) {
      const field = fieldAt(tokens, index);
      if (field?.name === 'dependencies' && tokens[field.equalsIndex + 1]?.value === '.' && tokens[field.equalsIndex + 2]?.value === '{') {
        return field.equalsIndex + 2;
      }
    }
    const closing = OPEN_TO_CLOSE[token.value];
    if (closing) stack.push(closing);
    else if (token.value === stack[stack.length - 1]) stack.pop();
  }
  return undefined;
}

/** Extracts direct build.zig.zon dependencies without evaluating build.zig or invoking Zig. */
export function extractZigDependencies(text: string): DependencyEntry[] {
  const tokens = tokenize(text);
  const open = dependenciesOpen(tokens);
  if (open === undefined) return [];

  const out: DependencyEntry[] = [];
  const seen = new Set<string>();
  const stack = ['}'];
  for (let index = open + 1; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (stack.length === 1) {
      if (token.value === '}') break;
      const field = fieldAt(tokens, index);
      if (field && !seen.has(field.name)) {
        seen.add(field.name);
        out.push(dependencyEntry(
          field.name,
          'dependencies',
          field.primaryRange,
          [field.sourceRange],
          field.name,
          field.iconRange,
        ));
      }
    }
    const closing = OPEN_TO_CLOSE[token.value];
    if (closing) stack.push(closing);
    else if (token.value === stack[stack.length - 1]) stack.pop();
  }
  return out;
}
