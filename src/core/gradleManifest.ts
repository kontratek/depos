import { dependencyEntry } from './dependency';
import type { DependencyEntry, SourceRange } from './model';

type TokenKind = 'identifier' | 'string' | 'symbol' | 'newline';

interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
  /** Source range inside the quotes, for string tokens. */
  contentStart?: number;
}

interface ParsedDependency {
  noteKey: string;
  primaryRange: SourceRange;
  sourceRanges: SourceRange[];
}

const WRAPPERS = new Set(['platform', 'enforcedPlatform', 'testFixtures']);
const NON_LIBRARY_CATALOGS = new Set(['bundles', 'plugins', 'versions']);
const NON_CONFIGURATIONS = new Set(['val', 'var', 'def', 'if', 'for', 'while', 'when', 'return', 'println']);
const NON_MODULE_FACTORIES = new Set(['project', 'files', 'fileTree', 'gradleApi', 'localGroovy']);

/**
 * A deliberately small Groovy/Kotlin lexer. Gradle build scripts are programs,
 * so Depos only reads statically visible declarations and never evaluates the
 * script. Keeping comments, strings and balanced delimiters distinct avoids the
 * false positives a regular-expression parser would produce.
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    const ch = text[i]!;
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      i++;
      tokens.push({ kind: 'newline', value: '\n', start, end: i });
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\r' && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\r' || text[i] === '\n') {
          const lineStart = i;
          if (text[i] === '\r' && text[i + 1] === '\n') i++;
          i++;
          tokens.push({ kind: 'newline', value: '\n', start: lineStart, end: i });
        } else {
          i++;
        }
      }
      if (i < text.length) i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = text.slice(i, i + 3) === ch.repeat(3);
      const width = triple ? 3 : 1;
      i += width;
      const contentStart = i;
      while (i < text.length) {
        if (triple && text.slice(i, i + 3) === ch.repeat(3)) break;
        if (!triple && text[i] === ch) break;
        if (!triple && text[i] === '\\' && i + 1 < text.length) i += 2;
        else i++;
      }
      const contentEnd = i;
      if (i < text.length) i += width;
      tokens.push({
        kind: 'string',
        value: text.slice(contentStart, contentEnd),
        start,
        end: i,
        contentStart,
      });
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      i++;
      while (i < text.length && /[A-Za-z0-9_$]/.test(text[i]!)) i++;
      tokens.push({ kind: 'identifier', value: text.slice(start, i), start, end: i });
      continue;
    }
    i++;
    tokens.push({ kind: 'symbol', value: ch, start, end: i });
  }
  return tokens;
}

function nextCode(tokens: readonly Token[], index: number, end = tokens.length): number {
  while (index < end && tokens[index]?.kind === 'newline') index++;
  return index;
}

function matching(tokens: readonly Token[], open: number, end: number, left: string, right: string): number | undefined {
  let depth = 0;
  for (let i = open; i < end; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'symbol') continue;
    if (token.value === left) depth++;
    else if (token.value === right && --depth === 0) return i;
  }
  return undefined;
}

function decodeSimpleString(value: string): string {
  return value.replace(/\\([\\'"nrt])/g, (_match, escaped: string) => {
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    return escaped;
  });
}

function stringRange(token: Token, start = 0, length = token.value.length): SourceRange {
  return { offset: (token.contentStart ?? token.start) + start, length };
}

function coordinateFrom(token: Token): ParsedDependency | undefined {
  if (token.kind !== 'string') return undefined;
  const first = token.value.indexOf(':');
  const second = token.value.indexOf(':', first + 1);
  const end = second === -1 ? token.value.length : second;
  if (first <= 0 || end <= first + 1) return undefined;
  const group = decodeSimpleString(token.value.slice(0, first));
  const artifact = decodeSimpleString(token.value.slice(first + 1, end));
  if (!group || !artifact) return undefined;
  const groupRange = stringRange(token, 0, first);
  const artifactRange = stringRange(token, first + 1, end - first - 1);
  return {
    noteKey: `${group}:${artifact}`,
    primaryRange: artifactRange,
    sourceRanges: [groupRange, artifactRange],
  };
}

function mapNotation(tokens: readonly Token[], start: number, end: number): ParsedDependency | undefined {
  let group: Token | undefined;
  let name: Token | undefined;
  for (let i = start; i < end; i++) {
    const key = tokens[i];
    if (key?.kind !== 'identifier' || (key.value !== 'group' && key.value !== 'name')) continue;
    const separator = nextCode(tokens, i + 1, end);
    if (![':', '='].includes(tokens[separator]?.value ?? '')) continue;
    const valueIndex = nextCode(tokens, separator + 1, end);
    const value = tokens[valueIndex];
    if (value?.kind !== 'string') continue;
    if (key.value === 'group') group = value;
    else name = value;
  }
  if (!group || !name) return undefined;
  const groupName = decodeSimpleString(group.value);
  const artifactName = decodeSimpleString(name.value);
  if (!groupName || !artifactName) return undefined;
  const groupRange = stringRange(group);
  const nameRange = stringRange(name);
  return {
    noteKey: `${groupName}:${artifactName}`,
    primaryRange: nameRange,
    sourceRanges: [groupRange, nameRange],
  };
}

function catalogAlias(tokens: readonly Token[], start: number, end: number): ParsedDependency | undefined {
  for (let i = start; i < end; i++) {
    const root = tokens[i];
    if (root?.kind !== 'identifier' || root.value !== 'libs') continue;
    const parts = ['libs'];
    let last = root;
    let cursor = i + 1;
    while (cursor + 1 < end && tokens[cursor]?.value === '.' && tokens[cursor + 1]?.kind === 'identifier') {
      const part = tokens[cursor + 1]!;
      if (part.value === 'get' && tokens[nextCode(tokens, cursor + 2, end)]?.value === '(') break;
      parts.push(part.value);
      last = part;
      cursor += 2;
    }
    if (parts.length < 2 || NON_LIBRARY_CATALOGS.has(parts[1]!)) continue;
    const range = { offset: root.start, length: last.end - root.start };
    return { noteKey: parts.join('.'), primaryRange: range, sourceRanges: [range] };
  }
  return undefined;
}

function expression(tokens: readonly Token[], start: number, end: number): ParsedDependency | undefined {
  for (let i = start; i < end; i++) {
    const token = tokens[i];
    if (token?.kind === 'identifier' && NON_MODULE_FACTORIES.has(token.value)) return undefined;
  }
  const mapped = mapNotation(tokens, start, end);
  if (mapped) return mapped;
  const alias = catalogAlias(tokens, start, end);
  if (alias) return alias;
  for (let i = start; i < end; i++) {
    const token = tokens[i]!;
    if (token.kind === 'string') {
      const coordinate = coordinateFrom(token);
      if (coordinate) return coordinate;
    }
    if (token.kind === 'identifier' && WRAPPERS.has(token.value)) {
      const open = nextCode(tokens, i + 1, end);
      if (tokens[open]?.value === '(') {
        const close = matching(tokens, open, end, '(', ')');
        if (close !== undefined) {
          const nested = expression(tokens, open + 1, close);
          if (nested) return nested;
        }
      }
    }
  }
  return undefined;
}

function topLevelComma(tokens: readonly Token[], start: number, end: number): number | undefined {
  let parens = 0;
  let brackets = 0;
  for (let i = start; i < end; i++) {
    const value = tokens[i]?.value;
    if (value === '(') parens++;
    else if (value === ')') parens--;
    else if (value === '[') brackets++;
    else if (value === ']') brackets--;
    else if (value === ',' && parens === 0 && brackets === 0) return i;
  }
  return undefined;
}

function dependencyBody(tokens: readonly Token[], start: number, end: number): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  let i = start;
  let braceDepth = 0;
  while (i < end) {
    const token = tokens[i]!;
    if (token.value === '{') {
      braceDepth++;
      i++;
      continue;
    }
    if (token.value === '}') {
      braceDepth--;
      i++;
      continue;
    }
    if (braceDepth !== 0 || (token.kind !== 'identifier' && token.kind !== 'string')) {
      i++;
      continue;
    }
    const configuration = token;
    if (configuration.kind === 'identifier' && NON_CONFIGURATIONS.has(configuration.value)) {
      while (i < end && tokens[i]?.kind !== 'newline' && tokens[i]?.value !== ';') i++;
      i++;
      continue;
    }
    const afterName = nextCode(tokens, i + 1, end);
    if (tokens[afterName]?.value === '{') {
      i++;
      continue;
    }

    let expressionStart = afterName;
    let expressionEnd = afterName;
    let statementEnd = afterName;
    if (tokens[afterName]?.value === '(') {
      const close = matching(tokens, afterName, end, '(', ')');
      if (close === undefined) {
        i++;
        continue;
      }
      expressionStart = afterName + 1;
      expressionEnd = close;
      statementEnd = close + 1;
    } else {
      let parens = 0;
      let brackets = 0;
      let cursor = afterName;
      for (; cursor < end; cursor++) {
        const current = tokens[cursor]!;
        if (current.value === '(') parens++;
        else if (current.value === ')') parens--;
        else if (current.value === '[') brackets++;
        else if (current.value === ']') brackets--;
        if (parens === 0 && brackets === 0 && (current.kind === 'newline' || current.value === ';' || current.value === '{')) break;
      }
      expressionEnd = cursor;
      statementEnd = cursor;
    }

    let scope = configuration.kind === 'string' ? decodeSimpleString(configuration.value) : configuration.value;
    if (scope === 'add') {
      const comma = topLevelComma(tokens, expressionStart, expressionEnd);
      const scopeToken = tokens[nextCode(tokens, expressionStart, expressionEnd)];
      if (comma === undefined || scopeToken?.kind !== 'string') {
        i = Math.max(statementEnd, i + 1);
        continue;
      }
      scope = decodeSimpleString(scopeToken.value);
      expressionStart = comma + 1;
    }

    const parsed = expression(tokens, expressionStart, expressionEnd);
    if (parsed && scope) {
      out.push(dependencyEntry(
        parsed.noteKey,
        scope,
        parsed.primaryRange,
        parsed.sourceRanges,
        parsed.noteKey,
        { offset: configuration.start, length: configuration.end - configuration.start },
      ));
    }
    i = Math.max(statementEnd, i + 1);
  }
  return out;
}

export function extractGradleDependencies(text: string): DependencyEntry[] {
  const tokens = tokenize(text);
  const out: DependencyEntry[] = [];
  const blocks: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.value === '}') {
      blocks.pop();
      continue;
    }
    if (token.value === '{') {
      const previous = tokens[i - 1];
      blocks.push(previous?.kind === 'identifier' ? previous.value : '');
      continue;
    }
    if (token.kind !== 'identifier' || token.value !== 'dependencies' || blocks.includes('buildscript')) continue;
    const open = nextCode(tokens, i + 1);
    if (tokens[open]?.value !== '{') continue;
    const close = matching(tokens, open, tokens.length, '{', '}');
    if (close === undefined) continue;
    out.push(...dependencyBody(tokens, open + 1, close));
    i = close;
  }
  return out;
}
