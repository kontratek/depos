import { dependencyEntry } from './dependency';
import type { DependencyEntry, SourceRange } from './model';

type TokenKind = 'word' | 'symbol' | 'string' | 'punctuation' | 'newline';

interface Token {
  kind: TokenKind;
  value: string;
  offset: number;
  length: number;
  contentRange?: SourceRange;
  literal?: boolean;
}

interface RubyBlock {
  /** `source`, `git` and `path` blocks say where the gems inside them come from. */
  kind: 'group' | 'platform' | 'definition' | 'gemspec' | 'source' | 'git' | 'path' | 'generic';
  values?: string[];
  receiver?: string;
}

const GEM_NAME = /^[A-Za-z0-9._-]+$/;
const GEMSPEC_METHODS = new Map([
  ['add_dependency', 'runtime'],
  ['add_runtime_dependency', 'runtime'],
  ['add_development_dependency', 'development'],
]);
const DEFINITION_WORDS = new Set(['def', 'class', 'module']);
const BLOCK_WORDS = new Set(['if', 'unless', 'case', 'begin', 'while', 'until', 'for']);

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').at(-1) ?? '';
}

export function isRubyManifestPath(path: string): boolean {
  const name = basename(path);
  return name === 'Gemfile' || name === 'gems.rb' || name.endsWith('.gemspec');
}

function skipQuoted(text: string, start: number, quote: string): number {
  let cursor = start + 1;
  while (cursor < text.length) {
    if (text[cursor] === '\\' && cursor + 1 < text.length) {
      cursor += 2;
      continue;
    }
    if (text[cursor] === quote) return cursor + 1;
    if (text[cursor] === '\n' || text[cursor] === '\r') return cursor;
    cursor++;
  }
  return cursor;
}

function skipPercentLiteral(text: string, start: number): number | undefined {
  if (text[start] !== '%') return undefined;
  let cursor = start + 1;
  if (/[qQrwWixs]/.test(text[cursor] ?? '')) cursor++;
  const opening = text[cursor];
  if (!opening || /[A-Za-z0-9_\s]/.test(opening)) return undefined;
  const closing = ({ '(': ')', '[': ']', '{': '}', '<': '>' } as Record<string, string>)[opening] ?? opening;
  const balanced = closing !== opening;
  let depth = 1;
  cursor++;
  while (cursor < text.length) {
    const char = text[cursor]!;
    if (char === '\\' && cursor + 1 < text.length) {
      cursor += 2;
      continue;
    }
    if (balanced && char === opening) depth++;
    if (char === closing && --depth === 0) return cursor + 1;
    cursor++;
  }
  return cursor;
}

function skipHeredoc(text: string, start: number): number | undefined {
  const match = /^<<[-~]?(?:(['"`])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*))/.exec(text.slice(start));
  const delimiter = match?.[2] ?? match?.[3];
  if (!match || !delimiter) return undefined;
  const firstNewline = text.indexOf('\n', start + match[0].length);
  if (firstNewline < 0) return text.length;
  let cursor = firstNewline + 1;
  while (cursor <= text.length) {
    const newline = text.indexOf('\n', cursor);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(cursor, end).replace(/\r$/, '').trim();
    if (line === delimiter) return newline < 0 ? end : newline + 1;
    if (newline < 0) return text.length;
    cursor = newline + 1;
  }
  return text.length;
}

function tokenizeRuby(text: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  let lineStart = true;
  while (cursor < text.length) {
    const char = text[cursor]!;
    if (char === '\r' && text[cursor + 1] === '\n') {
      tokens.push({ kind: 'newline', value: '\n', offset: cursor, length: 2 });
      cursor += 2;
      lineStart = true;
      continue;
    }
    if (char === '\n' || char === '\r') {
      tokens.push({ kind: 'newline', value: '\n', offset: cursor, length: 1 });
      cursor++;
      lineStart = true;
      continue;
    }
    if (/\s/.test(char)) {
      cursor++;
      continue;
    }
    if (lineStart && text.startsWith('=begin', cursor) && /(?:\s|$)/.test(text[cursor + 6] ?? '')) {
      const endMatch = /(?:^|\r?\n)=end(?:\s|$)/gm;
      endMatch.lastIndex = cursor + 6;
      const match = endMatch.exec(text);
      cursor = match ? match.index + match[0].length : text.length;
      tokens.push({ kind: 'newline', value: '\n', offset: cursor, length: 0 });
      lineStart = true;
      continue;
    }
    lineStart = false;
    if (char === '#') {
      while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') cursor++;
      continue;
    }
    const heredocEnd = text.startsWith('<<', cursor) ? skipHeredoc(text, cursor) : undefined;
    if (heredocEnd !== undefined) {
      cursor = heredocEnd;
      tokens.push({ kind: 'newline', value: '\n', offset: cursor, length: 0 });
      lineStart = true;
      continue;
    }
    const percentEnd = skipPercentLiteral(text, cursor);
    if (percentEnd !== undefined) {
      tokens.push({ kind: 'string', value: '', offset: cursor, length: percentEnd - cursor, literal: false });
      cursor = percentEnd;
      continue;
    }
    if (char === '/' && text.indexOf('/', cursor + 1) >= 0) {
      let end = cursor + 1;
      while (end < text.length && text[end] !== '\n' && text[end] !== '\r') {
        if (text[end] === '\\' && end + 1 < text.length) end += 2;
        else if (text[end++] === '/') break;
      }
      tokens.push({ kind: 'string', value: '', offset: cursor, length: end - cursor, literal: false });
      cursor = end;
      continue;
    }
    if (char === '"' || char === '\'') {
      const end = skipQuoted(text, cursor, char);
      const closed = text[end - 1] === char;
      const contentEnd = closed ? end - 1 : end;
      const raw = text.slice(cursor + 1, contentEnd);
      const literal = closed && !raw.includes('\\') && (char === '\'' || !raw.includes('#{'));
      tokens.push({
        kind: 'string',
        value: raw,
        offset: cursor,
        length: end - cursor,
        contentRange: { offset: cursor + 1, length: raw.length },
        literal,
      });
      cursor = end;
      continue;
    }
    if (char === ':' && /[A-Za-z_]/.test(text[cursor + 1] ?? '')) {
      const start = cursor++;
      const valueStart = cursor;
      while (/[A-Za-z0-9_!?]/.test(text[cursor] ?? '')) cursor++;
      tokens.push({ kind: 'symbol', value: text.slice(valueStart, cursor), offset: start, length: cursor - start });
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = cursor++;
      while (/[A-Za-z0-9_!?]/.test(text[cursor] ?? '')) cursor++;
      tokens.push({ kind: 'word', value: text.slice(start, cursor), offset: start, length: cursor - start });
      continue;
    }
    const pair = text.slice(cursor, cursor + 2);
    if (pair === '=>' || pair === '::' || pair === '->') {
      tokens.push({ kind: 'punctuation', value: pair, offset: cursor, length: 2 });
      cursor += 2;
      continue;
    }
    tokens.push({ kind: 'punctuation', value: char, offset: cursor, length: 1 });
    cursor++;
  }
  return tokens;
}

function statements(tokens: readonly Token[]): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];
  const stack: string[] = [];
  const closeFor: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const flush = (): void => {
    if (current.length) out.push(current);
    current = [];
  };
  for (const token of tokens) {
    if ((token.kind === 'newline' || token.value === ';') && stack.length === 0) {
      flush();
      continue;
    }
    if (token.kind === 'newline') continue;
    current.push(token);
    const close = closeFor[token.value];
    if (close) stack.push(close);
    else if (token.value === stack.at(-1)) stack.pop();
  }
  flush();
  return out;
}

function literalValues(tokens: readonly Token[], start: number): string[] {
  const token = tokens[start];
  if (!token) return [];
  if (token.kind === 'symbol') return [token.value];
  if (token.kind === 'string' && token.literal) return [token.value];
  if (token.value !== '[') return [];
  const values: string[] = [];
  for (let i = start + 1; i < tokens.length && tokens[i]?.value !== ']'; i++) {
    const item = tokens[i]!;
    if (item.value === ',') continue;
    if (item.kind !== 'symbol' && !(item.kind === 'string' && item.literal)) return [];
    values.push(item.value);
  }
  return values;
}

function optionValues(tokens: readonly Token[], names: readonly string[]): string[] {
  for (let i = 0; i < tokens.length - 2; i++) {
    const token = tokens[i]!;
    const modern = token.kind === 'word' && names.includes(token.value) && tokens[i + 1]?.value === ':';
    const legacy = token.kind === 'symbol' && names.includes(token.value) && tokens[i + 1]?.value === '=>';
    if (modern || legacy) return literalValues(tokens, i + 2);
  }
  return [];
}

function orderedUnique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * The requirement strings right after a gem's name (`'~> 7.0', '>= 7.0.4'`), joined as
 * RubyGems writes a requirement list. Undefined when there are none.
 */
function requirementAfter(tokens: readonly Token[], nameIndex: number): string | undefined {
  const parts: string[] = [];
  for (let i = nameIndex + 1; tokens[i]?.value === ','; i += 2) {
    const value = tokens[i + 1];
    if (value?.kind !== 'string' || !value.literal || tokens[i + 2]?.value === ':') break;
    parts.push(value.value.trim());
  }
  return parts.length ? parts.join(', ') : undefined;
}

/**
 * Where a gem comes from when it is not rubygems.org, prefixed as npm does so a
 * consumer can leave it out of registry checks: `git+<url>` (`git:`, `github:` or a
 * `git` block), `file:<path>` (`path:` or a `path` block) and `registry:<url>`
 * (`source:` or a `source` block other than rubygems.org).
 */
function rubySource(options: readonly Token[], blocks: readonly RubyBlock[]): string | undefined {
  const git = optionValues(options, ['git'])[0];
  if (git) return `git+${git}`;
  const github = optionValues(options, ['github'])[0];
  if (github) return `git+https://github.com/${github}`;
  const path = optionValues(options, ['path'])[0];
  if (path) return `file:${path}`;
  const source = optionValues(options, ['source'])[0];
  if (source && !RUBYGEMS_SOURCE.test(source)) return `registry:${source}`;
  const block = [...blocks].reverse().find((candidate) => candidate.kind === 'git' || candidate.kind === 'path' || candidate.kind === 'source');
  const value = block?.values?.[0];
  if (block?.kind === 'git' && value) return `git+${value}`;
  if (block?.kind === 'path' && value) return `file:${value}`;
  if (block?.kind === 'source' && value && !RUBYGEMS_SOURCE.test(value)) return `registry:${value}`;
  return undefined;
}

const RUBYGEMS_SOURCE = /^https?:\/\/rubygems\.org\/?$/i;

function withSpec(entry: DependencyEntry, versionSpec: string | undefined): DependencyEntry {
  return versionSpec ? { ...entry, versionSpec } : entry;
}

/**
 * The one release an exact requirement names (`'1.2.3'` or `'= 1.2.3'`), or undefined.
 * RubyGems reads a bare version as `=`. A pessimistic or ranged requirement, or more
 * than one, can install more than one release.
 */
export function rubyPinnedVersion(versionSpec: string | undefined): string | undefined {
  return /^(?:=\s*)?(\d+(?:\.[0-9A-Za-z]+)*)$/.exec(versionSpec?.trim() ?? '')?.[1];
}

function gemfileDependency(tokens: readonly Token[], blocks: readonly RubyBlock[]): DependencyEntry | undefined {
  if (blocks.some((block) => block.kind === 'definition')) return undefined;
  const call = tokens[0];
  if (call?.kind !== 'word' || call.value !== 'gem') return undefined;
  const nameIndex = tokens[1]?.value === '(' ? 2 : 1;
  const name = tokens[nameIndex];
  if (name?.kind !== 'string' || !name.literal || !name.contentRange || !GEM_NAME.test(name.value)) return undefined;
  const groups = orderedUnique([
    ...blocks.filter((block) => block.kind === 'group').flatMap((block) => block.values ?? []),
    ...optionValues(tokens.slice(nameIndex + 1), ['group', 'groups']),
  ]);
  const platforms = orderedUnique([
    ...blocks.filter((block) => block.kind === 'platform').flatMap((block) => block.values ?? []),
    ...optionValues(tokens.slice(nameIndex + 1), ['platform', 'platforms']),
  ]);
  const scope = `${groups.length ? groups.join(',') : 'default'}${platforms.length ? `@${platforms.join(',')}` : ''}`;
  return withSpec(dependencyEntry(
    name.value,
    scope,
    name.contentRange,
    [{ offset: name.offset, length: name.length }],
    name.value,
    { offset: call.offset, length: call.length },
  ), rubySource(tokens.slice(nameIndex + 1), blocks) ?? requirementAfter(tokens, nameIndex));
}

function gemspecDependency(tokens: readonly Token[], blocks: readonly RubyBlock[]): DependencyEntry | undefined {
  const spec = [...blocks].reverse().find((block) => block.kind === 'gemspec');
  if (!spec?.receiver || blocks.slice(blocks.indexOf(spec) + 1).some((block) => block.kind === 'definition')) return undefined;
  const receiver = tokens[0];
  const method = tokens[2];
  if (receiver?.kind !== 'word' || receiver.value !== spec.receiver || tokens[1]?.value !== '.' || method?.kind !== 'word') return undefined;
  const scope = GEMSPEC_METHODS.get(method.value);
  if (!scope) return undefined;
  const nameIndex = tokens[3]?.value === '(' ? 4 : 3;
  const name = tokens[nameIndex];
  if (name?.kind !== 'string' || !name.literal || !name.contentRange || !GEM_NAME.test(name.value)) return undefined;
  return withSpec(dependencyEntry(
    name.value,
    scope,
    name.contentRange,
    [{ offset: name.offset, length: name.length }],
    name.value,
    { offset: method.offset, length: method.length },
  ), requirementAfter(tokens, nameIndex));
}

function openedBlock(tokens: readonly Token[]): RubyBlock | undefined {
  const first = tokens[0];
  if (!first) return undefined;
  if (DEFINITION_WORDS.has(first.value)) return { kind: 'definition' };
  if (BLOCK_WORDS.has(first.value)) return { kind: 'generic' };
  const doIndex = tokens.findIndex((token) => token.kind === 'word' && token.value === 'do');
  if (doIndex < 0) return undefined;
  if (first.kind === 'word' && first.value === 'group') {
    return { kind: 'group', values: tokens.slice(1, doIndex).filter((token) => token.kind === 'symbol').map((token) => token.value) };
  }
  if (first.kind === 'word' && (first.value === 'platform' || first.value === 'platforms')) {
    return { kind: 'platform', values: tokens.slice(1, doIndex).filter((token) => token.kind === 'symbol').map((token) => token.value) };
  }
  if (first.kind === 'word' && (first.value === 'source' || first.value === 'git' || first.value === 'path')) {
    const target = tokens.slice(1, doIndex).find((token) => token.kind === 'string' && token.literal);
    return { kind: first.value, values: target ? [target.value] : [] };
  }
  const gemspecPrefix = tokens.slice(0, 6).map((token) => token.value).join(' ');
  if (gemspecPrefix === 'Gem :: Specification . new do' && tokens[6]?.value === '|' && tokens[7]?.kind === 'word') {
    return { kind: 'gemspec', receiver: tokens[7].value };
  }
  return { kind: 'generic' };
}

function extract(text: string, gemspec: boolean): DependencyEntry[] {
  const out: DependencyEntry[] = [];
  const blocks: RubyBlock[] = [];
  for (const statement of statements(tokenizeRuby(text))) {
    let start = 0;
    while (statement[start]?.value === 'end') {
      blocks.pop();
      start++;
    }
    const body = statement.slice(start);
    if (!body.length) continue;
    const dependency = gemspec ? gemspecDependency(body, blocks) : gemfileDependency(body, blocks);
    if (dependency) out.push(dependency);
    const block = openedBlock(body);
    if (block) blocks.push(block);
  }
  return out;
}

/** Reads literal RubyGems/Bundler declarations without evaluating Ruby. */
export function extractRubyDependencies(text: string, path = 'Gemfile'): DependencyEntry[] {
  return extract(text, basename(path).endsWith('.gemspec'));
}

/** Aggregate views show one row per exact Ruby gem name. */
export function uniqueRubyDependencies(dependencies: readonly DependencyEntry[]): DependencyEntry[] {
  const unique = new Map<string, DependencyEntry>();
  for (const dependency of dependencies) {
    if (!unique.has(dependency.noteKey)) unique.set(dependency.noteKey, dependency);
  }
  return [...unique.values()];
}
