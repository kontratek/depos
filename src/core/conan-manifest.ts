import { dependencyEntry } from './dependency';
import type { DependencyEntry } from './model';

const SCOPES = new Set(['requires', 'tool_requires', 'test_requires', 'build_requires']);
// Spaces are allowed only inside a version range: `openssl/[>=3.0 <4]`.
const REFERENCE = /^\s*([A-Za-z0-9][A-Za-z0-9_+.-]*)\/(?:\[[^\]]*]|[^\s[])+\s*$/;

interface Token {
  kind: 'identifier' | 'string' | 'punctuation' | 'newline';
  value: string;
  offset: number;
  length: number;
  contentOffset?: number;
  line: number;
  literal?: boolean;
}

function conanEntry(token: Token, scope: string): DependencyEntry | undefined {
  if (token.kind !== 'string' || !token.literal || token.contentOffset === undefined) return undefined;
  const match = REFERENCE.exec(token.value);
  if (!match?.[1]) return undefined;
  const leading = token.value.length - token.value.trimStart().length;
  const range = { offset: token.contentOffset + leading, length: match[1].length };
  return dependencyEntry(
    match[1].toLowerCase(),
    scope,
    range,
    [range],
    match[1],
    { offset: token.offset, length: 1 },
  );
}

function tokenizePython(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 0;
  const pushNewline = (): void => {
    tokens.push({ kind: 'newline', value: '\n', offset: i, length: 1, line });
    i++;
    line++;
  };
  while (i < text.length) {
    const char = text[i]!;
    if (char === '\r' && text[i + 1] === '\n') {
      i++;
      pushNewline();
      continue;
    }
    if (char === '\n') {
      pushNewline();
      continue;
    }
    if (/\s/.test(char)) {
      i++;
      continue;
    }
    if (char === '#') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }

    const prefixMatch = /^(?:[rRuUbBfF]{0,2})(['"])/.exec(text.slice(i));
    const previous = i > 0 ? text[i - 1]! : '';
    if (prefixMatch && (!previous || !/[A-Za-z0-9_]/.test(previous))) {
      const prefixLength = prefixMatch[0].length - 1;
      const quote = prefixMatch[1]!;
      const start = i;
      const tokenLine = line;
      i += prefixLength;
      const triple = text.slice(i, i + 3) === quote.repeat(3);
      const delimiterLength = triple ? 3 : 1;
      i += delimiterLength;
      const contentOffset = i;
      let escaped = false;
      while (i < text.length) {
        if (!triple && (text[i] === '\n' || text[i] === '\r')) break;
        if (triple && text.slice(i, i + 3) === quote.repeat(3)) break;
        const current = text[i]!;
        if (!triple && escaped) escaped = false;
        else if (!triple && current === '\\') escaped = true;
        else if (!triple && current === quote) break;
        if (current === '\n') line++;
        i++;
      }
      const contentEnd = i;
      if (triple && text.slice(i, i + 3) === quote.repeat(3)) i += 3;
      else if (!triple && text[i] === quote) i++;
      const prefix = text.slice(start, start + prefixLength).toLowerCase();
      tokens.push({
        kind: 'string',
        value: text.slice(contentOffset, contentEnd),
        offset: start,
        length: i - start,
        contentOffset,
        line: tokenLine,
        literal: !triple && !prefix.includes('f') && !prefix.includes('b') && !text.slice(contentOffset, contentEnd).includes('\\'),
      });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = i++;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) i++;
      tokens.push({ kind: 'identifier', value: text.slice(start, i), offset: start, length: i - start, line });
      continue;
    }
    tokens.push({ kind: 'punctuation', value: char, offset: i, length: 1, line });
    i++;
  }
  return tokens;
}

type BlockKind = 'class' | 'def';

function pythonLineContexts(text: string): Array<Set<BlockKind>> {
  const lines = text.split(/\r?\n/);
  const result: Array<Set<BlockKind>> = [];
  const stack: Array<{ indent: number; kind: BlockKind }> = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      result.push(new Set(stack.map((entry) => entry.kind)));
      continue;
    }
    const whitespace = /^\s*/.exec(raw)?.[0] ?? '';
    const indent = [...whitespace].reduce((count, value) => count + (value === '\t' ? 8 : 1), 0);
    while (stack.length && indent <= stack[stack.length - 1]!.indent) stack.pop();
    result.push(new Set(stack.map((entry) => entry.kind)));
    if (/^(?:async\s+)?def\b.*:\s*(?:#.*)?$/.test(trimmed)) stack.push({ indent, kind: 'def' });
    else if (/^class\b.*:\s*(?:#.*)?$/.test(trimmed)) stack.push({ indent, kind: 'class' });
  }
  return result;
}

function statementEnd(tokens: readonly Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === 'punctuation' && ['[', '(', '{'].includes(token.value)) depth++;
    else if (token.kind === 'punctuation' && [']', ')', '}'].includes(token.value)) depth--;
    else if (token.kind === 'newline' && depth === 0) return i;
    else if (token.kind === 'punctuation' && token.value === ';' && depth === 0) return i;
  }
  return tokens.length;
}

function literalSequence(tokens: readonly Token[], start: number, end: number): Token[] {
  const significant = tokens.slice(start, end).filter((token) => token.kind !== 'newline');
  if (!significant.length) return [];
  let left = 0;
  let right = significant.length;
  const opener = significant[0]?.value;
  const closer = opener === '[' ? ']' : opener === '(' ? ')' : undefined;
  if (closer) {
    if (significant.at(-1)?.value !== closer) return [];
    left++;
    right--;
  }
  const values: Token[] = [];
  let expectValue = true;
  for (const token of significant.slice(left, right)) {
    if (expectValue) {
      if (token.kind !== 'string' || !token.literal) return [];
      values.push(token);
      expectValue = false;
    } else {
      if (token.kind !== 'punctuation' || token.value !== ',') return [];
      expectValue = true;
    }
  }
  return values.length && (!expectValue || significant[right - 1]?.value === ',') ? values : [];
}

/** Reads literal Conan requirements without importing or executing conanfile.py. */
export function extractConanPythonDependencies(text: string): DependencyEntry[] {
  const tokens = tokenizePython(text);
  const contexts = pythonLineContexts(text);
  const out: DependencyEntry[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const context = contexts[token.line] ?? new Set<BlockKind>();

    if (
      token.kind === 'identifier'
      && SCOPES.has(token.value)
      && tokens[i + 1]?.value === '='
      && context.has('class')
      && !context.has('def')
    ) {
      const end = statementEnd(tokens, i + 2);
      for (const value of literalSequence(tokens, i + 2, end)) {
        const dependency = conanEntry(value, token.value);
        if (dependency) out.push(dependency);
      }
      i = Math.max(i, end - 1);
      continue;
    }

    if (
      token.kind === 'identifier'
      && token.value === 'self'
      && tokens[i + 1]?.value === '.'
      && tokens[i + 2]?.kind === 'identifier'
      && SCOPES.has(tokens[i + 2]!.value)
      && tokens[i + 3]?.value === '('
      && context.has('class')
    ) {
      const value = tokens[i + 4];
      const after = tokens[i + 5];
      if (value?.kind === 'string' && value.literal && (after?.value === ')' || after?.value === ',')) {
        const dependency = conanEntry(value, tokens[i + 2]!.value);
        if (dependency) out.push(dependency);
      }
    }
  }
  return out;
}

/** Reads the four dependency sections supported by Conan 1 and Conan 2 text manifests. */
export function extractConanTextDependencies(text: string): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  let scope: string | undefined;
  let offset = 0;
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const section = /^\s*\[([^\]]+)]\s*$/.exec(line);
    if (section) {
      const candidate = section[1]!.trim().toLowerCase();
      scope = SCOPES.has(candidate) ? candidate : undefined;
    } else if (scope && line.trim() && !/^\s*[#;]/.test(line)) {
      const leading = line.length - line.trimStart().length;
      const token: Token = {
        kind: 'string',
        value: line.trim(),
        offset: offset + leading,
        length: line.trim().length,
        contentOffset: offset + leading,
        line: 0,
        literal: true,
      };
      const dependency = conanEntry(token, scope);
      if (dependency) out.push(dependency);
    }
    offset += rawLine.length + 1;
  }
  return out;
}

export function extractConanDependencies(text: string, path = 'conanfile.py'): DependencyEntry[] {
  const basename = path.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase();
  return basename === 'conanfile.txt'
    ? extractConanTextDependencies(text)
    : extractConanPythonDependencies(text);
}
