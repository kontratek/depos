import { dependencyEntry } from './dependency';
import type { DependencyEntry, SourceRange } from './model';

type TokenKind = 'word' | 'atom' | 'literal' | 'symbol';

interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
  contentStart?: number;
  contentEnd?: number;
}

const OPEN_TO_CLOSE: Readonly<Record<string, string>> = {
  '(': ')',
  '[': ']',
  '{': '}',
};

function decodeQuoted(value: string, quote: string): string {
  if (quote === '"') {
    try {
      return JSON.parse(`"${value}"`) as string;
    } catch {
      // Keep malformed-but-readable names useful while the user is editing.
    }
  }
  return value.replace(/\\([\\'"nrt])/g, (_match, escaped: string) => {
    if (escaped === 'n') return '\n';
    if (escaped === 'r') return '\r';
    if (escaped === 't') return '\t';
    return escaped;
  });
}

function quotedEnd(text: string, start: number, quote: '"' | "'"): number {
  const triple = text.slice(start, start + 3) === quote.repeat(3);
  const marker = triple ? quote.repeat(3) : quote;
  let cursor = start + marker.length;
  while (cursor < text.length) {
    if (text.startsWith(marker, cursor)) return cursor + marker.length;
    if (text[cursor] === '\\' && cursor + 1 < text.length) cursor += 2;
    else cursor++;
  }
  return text.length;
}

function sigilEnd(text: string, start: number): number | undefined {
  if (text[start] !== '~' || !/[A-Za-z]/.test(text[start + 1] ?? '')) return undefined;
  const delimiterStart = start + 2;
  const opening = text[delimiterStart];
  if (!opening || /[A-Za-z0-9_\s]/.test(opening)) return undefined;
  if ((opening === '"' || opening === "'") && text.slice(delimiterStart, delimiterStart + 3) === opening.repeat(3)) {
    let cursor = quotedEnd(text, delimiterStart, opening);
    while (/[A-Za-z]/.test(text[cursor] ?? '')) cursor++;
    return cursor;
  }
  const closing = ({ '(': ')', '[': ']', '{': '}', '<': '>' } as Record<string, string>)[opening] ?? opening;
  let depth = opening === closing ? 0 : 1;
  let cursor = delimiterStart + 1;
  while (cursor < text.length) {
    const char = text[cursor]!;
    if (char === '\\' && cursor + 1 < text.length) {
      cursor += 2;
      continue;
    }
    if (opening !== closing && char === opening) depth++;
    if (char === closing) {
      if (opening === closing || --depth === 0) {
        cursor++;
        while (/[A-Za-z]/.test(text[cursor] ?? '')) cursor++;
        return cursor;
      }
    }
    cursor++;
  }
  return text.length;
}

/** A small Elixir lexer used only for statically visible Mix dependency lists. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const char = text[cursor]!;
    if (/\s/.test(char)) {
      cursor++;
      continue;
    }
    if (char === '#') {
      while (cursor < text.length && text[cursor] !== '\n') cursor++;
      continue;
    }
    const endOfSigil = sigilEnd(text, cursor);
    if (endOfSigil !== undefined) {
      tokens.push({ kind: 'literal', value: text.slice(cursor, endOfSigil), start: cursor, end: endOfSigil });
      cursor = endOfSigil;
      continue;
    }
    if (char === ':' && (text[cursor + 1] === '"' || text[cursor + 1] === "'")) {
      const quote = text[cursor + 1] as '"' | "'";
      const quotedStart = cursor + 1;
      const end = quotedEnd(text, quotedStart, quote);
      const markerWidth = text.slice(quotedStart, quotedStart + 3) === quote.repeat(3) ? 3 : 1;
      const contentStart = quotedStart + markerWidth;
      const contentEnd = Math.max(contentStart, end - markerWidth);
      tokens.push({
        kind: 'atom',
        value: decodeQuoted(text.slice(contentStart, contentEnd), quote),
        start: cursor,
        end,
        contentStart,
        contentEnd,
      });
      cursor = end;
      continue;
    }
    if (char === ':') {
      const match = /^[A-Za-z_][A-Za-z0-9_@!?]*/.exec(text.slice(cursor + 1));
      if (match) {
        const end = cursor + 1 + match[0].length;
        tokens.push({
          kind: 'atom',
          value: match[0],
          start: cursor,
          end,
          contentStart: cursor + 1,
          contentEnd: end,
        });
        cursor = end;
        continue;
      }
    }
    if (char === '"' || char === "'") {
      const end = quotedEnd(text, cursor, char);
      tokens.push({ kind: 'literal', value: text.slice(cursor, end), start: cursor, end });
      cursor = end;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_@!?]*/.exec(text.slice(cursor));
    if (word) {
      const end = cursor + word[0].length;
      tokens.push({ kind: 'word', value: word[0], start: cursor, end });
      cursor = end;
      continue;
    }
    tokens.push({ kind: 'symbol', value: char, start: cursor, end: cursor + 1 });
    cursor++;
  }
  return tokens;
}

function matchingToken(tokens: readonly Token[], openIndex: number): number | undefined {
  const wanted = OPEN_TO_CLOSE[tokens[openIndex]?.value ?? ''];
  if (!wanted) return undefined;
  const stack = [wanted];
  for (let i = openIndex + 1; i < tokens.length; i++) {
    const value = tokens[i]!.value;
    const nested = OPEN_TO_CLOSE[value];
    if (nested) stack.push(nested);
    else if (value === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return undefined;
}

function literalListStarts(tokens: readonly Token[]): number[] {
  const starts = new Set<number>();
  const ancestors: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (
      !ancestors.includes('}')
      && token.kind === 'word'
      && token.value === 'deps'
      && tokens[i + 1]?.value === ':'
      && tokens[i + 2]?.value === '['
    ) {
      starts.add(i + 2);
    }
    if (token.kind === 'word' && (token.value === 'def' || token.value === 'defp')) {
      if (tokens[i + 1]?.kind === 'word' && tokens[i + 1]?.value === 'deps') {
        let cursor = i + 2;
        if (tokens[cursor]?.value === '(') {
          const close = matchingToken(tokens, cursor);
          if (close !== undefined && close === cursor + 1) cursor = close + 1;
          else cursor = -1;
        }
        if (tokens[cursor]?.value === ',') cursor++;
        if (tokens[cursor]?.value === 'do') {
          cursor++;
          if (tokens[cursor]?.value === ':') cursor++;
          if (tokens[cursor]?.value === '[') starts.add(cursor);
        }
      }
    }
    const nested = OPEN_TO_CLOSE[token.value];
    if (nested) ancestors.push(nested);
    else if (token.value === ancestors[ancestors.length - 1]) ancestors.pop();
  }
  return [...starts].sort((a, b) => a - b);
}

function atomsFromOption(tokens: readonly Token[], name: string): string[] | undefined {
  const stack: string[] = [];
  for (let i = 0; i < tokens.length - 2; i++) {
    const token = tokens[i]!;
    if (stack.length === 0 && token.kind === 'word' && token.value === name && tokens[i + 1]?.value === ':') {
      const value = tokens[i + 2]!;
      if (value.kind === 'atom') return [value.value];
      if (value.value !== '[') return undefined;
      const close = matchingToken(tokens, i + 2);
      if (close === undefined) return undefined;
      const atoms: string[] = [];
      for (let j = i + 3; j < close; j++) {
        const item = tokens[j]!;
        if (item.kind === 'atom') atoms.push(item.value);
        else if (item.value !== ',') return undefined;
      }
      return atoms.length > 0 ? atoms : undefined;
    }
    const nested = OPEN_TO_CLOSE[token.value];
    if (nested) stack.push(nested);
    else if (token.value === stack[stack.length - 1]) stack.pop();
  }
  return undefined;
}

/** The token a top-level keyword option names (`git: "…"`), or undefined. */
function keywordToken(tokens: readonly Token[], name: string): Token | undefined {
  const stack: string[] = [];
  for (let i = 0; i < tokens.length - 2; i++) {
    const token = tokens[i]!;
    if (stack.length === 0 && token.kind === 'word' && token.value === name && tokens[i + 1]?.value === ':') return tokens[i + 2];
    const nested = OPEN_TO_CLOSE[token.value];
    if (nested) stack.push(nested);
    else if (token.value === stack[stack.length - 1]) stack.pop();
  }
  return undefined;
}

/** A plain double- or single-quoted string token's content, or undefined (a sigil, an atom, …). */
function stringContent(token: Token | undefined): string | undefined {
  if (token?.kind !== 'literal') return undefined;
  const quote = token.value[0];
  if ((quote !== '"' && quote !== "'") || token.value.length < 2 || token.value.at(-1) !== quote) return undefined;
  return decodeQuoted(token.value.slice(1, -1), quote);
}

/**
 * The requirement a dependency writes (`"~> 1.7"`), or where it comes from instead,
 * prefixed as npm does so a consumer can leave it out of registry checks:
 * `git+<url>` (`git:` and `github:`), `file:<path>`, `workspace:umbrella` (a sibling
 * umbrella app), `package:<name>` (`hex: :name`, a renamed package) and
 * `registry:<name>` (a private organization or repository).
 */
function mixSpec(options: readonly Token[]): string | undefined {
  const git = stringContent(keywordToken(options, 'git'));
  if (git) return `git+${git}`;
  const github = stringContent(keywordToken(options, 'github'));
  if (github) return `git+https://github.com/${github}`;
  const path = stringContent(keywordToken(options, 'path'));
  if (path) return `file:${path}`;
  if (keywordToken(options, 'in_umbrella')?.value === 'true') return 'workspace:umbrella';
  const organization = stringContent(keywordToken(options, 'organization'));
  const repo = stringContent(keywordToken(options, 'repo'));
  if (organization || (repo && repo !== 'hexpm')) return `registry:${organization ?? repo}`;
  const hex = keywordToken(options, 'hex');
  if (hex?.kind === 'atom') return `package:${hex.value}`;
  const requirement = stringContent(options[0]);
  return requirement?.trim() || undefined;
}

/**
 * The one release an exact requirement names, or undefined. In Elixir a version
 * with no operator is an exact match, as `==` is (`Version.match?/2`).
 */
export function mixPinnedVersion(versionSpec: string | undefined): string | undefined {
  return /^(?:==\s*)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(versionSpec?.trim() ?? '')?.[1];
}

function dependencyFromTuple(tokens: readonly Token[]): DependencyEntry | undefined {
  if (tokens.length < 4 || tokens[0]?.value !== '{' || tokens[tokens.length - 1]?.value !== '}') return undefined;
  const atom = tokens[1];
  if (!atom || atom.kind !== 'atom' || tokens[2]?.value !== ',') return undefined;
  const options = tokens.slice(3, -1);
  const versionSpec = mixSpec(options);
  const environments = atomsFromOption(options, 'only');
  const targets = atomsFromOption(options, 'targets');
  let scope = 'deps';
  if (environments) scope += `:${environments.join(',')}`;
  if (targets) scope += `@${targets.join(',')}`;
  const primaryRange: SourceRange = {
    offset: atom.contentStart ?? atom.start,
    length: (atom.contentEnd ?? atom.end) - (atom.contentStart ?? atom.start),
  };
  const entry = dependencyEntry(
    atom.value,
    scope,
    primaryRange,
    [{ offset: atom.start, length: atom.end - atom.start }],
    atom.value,
    { offset: tokens[0]!.start, length: 1 },
  );
  return versionSpec ? { ...entry, versionSpec } : entry;
}

function dependenciesFromList(tokens: readonly Token[], open: number, close: number): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  let elementStart = open + 1;
  const stack: string[] = [];
  const visit = (end: number): void => {
    const element = tokens.slice(elementStart, end);
    const dependency = dependencyFromTuple(element);
    if (dependency) out.push(dependency);
  };
  for (let i = open + 1; i < close; i++) {
    const value = tokens[i]!.value;
    const nested = OPEN_TO_CLOSE[value];
    if (nested) stack.push(nested);
    else if (value === stack[stack.length - 1]) stack.pop();
    else if (value === ',' && stack.length === 0) {
      visit(i);
      elementStart = i + 1;
    }
  }
  visit(close);
  return out;
}

/** Extracts direct, statically visible Mix dependencies without evaluating mix.exs. */
export function extractMixDependencies(text: string): DependencyEntry[] {
  const tokens = tokenize(text);
  const out: DependencyEntry[] = [];
  const seen = new Set<string>();
  for (const open of literalListStarts(tokens)) {
    const close = matchingToken(tokens, open);
    if (close === undefined) continue;
    for (const dependency of dependenciesFromList(tokens, open, close)) {
      const key = `${dependency.scope}\0${dependency.noteKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(dependency);
    }
  }
  return out;
}
