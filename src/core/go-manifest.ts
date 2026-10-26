import { dependencyEntry } from './dependency';
import type { DependencyEntry, SourceRange } from './model';

interface GoToken {
  value: string;
  /** Range of the token's content, without surrounding quotes. */
  range: SourceRange;
  quoted: boolean;
}

interface GoLine {
  tokens: GoToken[];
  comment: string;
}

interface GoModule {
  path: string;
  scope: string;
  range: SourceRange;
  toolRanges: SourceRange[];
}

function decodeInterpreted(value: string): string {
  return value.replace(/\\(.)/g, (_, escaped: string) => {
    if (escaped === 'n') return '\n';
    if (escaped === 't') return '\t';
    if (escaped === 'r') return '\r';
    return escaped;
  });
}

/** A small, tolerant go.mod lexer. Depos reads manifests as text and never invokes Go. */
function goLines(text: string): GoLine[] {
  const out: GoLine[] = [];
  let offset = 0;
  while (offset <= text.length) {
    const newline = text.indexOf('\n', offset);
    const rawEnd = newline < 0 ? text.length : newline;
    const end = rawEnd > offset && text[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
    const tokens: GoToken[] = [];
    let comment = '';
    let cursor = offset;
    while (cursor < end) {
      const char = text[cursor]!;
      if (/\s/.test(char)) {
        cursor++;
        continue;
      }
      if (char === '/' && text[cursor + 1] === '/') {
        comment = text.slice(cursor + 2, end);
        break;
      }
      if (char === '(' || char === ')') {
        tokens.push({ value: char, range: { offset: cursor, length: 1 }, quoted: false });
        cursor++;
        continue;
      }
      if (char === '"' || char === '`') {
        const contentStart = ++cursor;
        while (cursor < end && text[cursor] !== char) {
          if (char === '"' && text[cursor] === '\\' && cursor + 1 < end) cursor++;
          cursor++;
        }
        const raw = text.slice(contentStart, cursor);
        tokens.push({
          value: char === '"' ? decodeInterpreted(raw) : raw,
          range: { offset: contentStart, length: cursor - contentStart },
          quoted: true,
        });
        if (cursor < end) cursor++;
        continue;
      }
      const start = cursor;
      while (
        cursor < end
        && !/\s/.test(text[cursor]!)
        && text[cursor] !== '('
        && text[cursor] !== ')'
        && !(text[cursor] === '/' && text[cursor + 1] === '/')
      ) cursor++;
      tokens.push({ value: text.slice(start, cursor), range: { offset: start, length: cursor - start }, quoted: false });
    }
    out.push({ tokens, comment });
    if (newline < 0) break;
    offset = newline + 1;
  }
  return out;
}

function isPath(token: GoToken | undefined): token is GoToken {
  return token !== undefined && token.value !== '' && (token.quoted || (token.value !== '(' && token.value !== ')'));
}

/** Matches Go's own rule: the comment is `indirect`, optionally followed by `;` and more text. */
function isIndirect(comment: string): boolean {
  return /^indirect(?:;|$)/.test(comment.trim());
}

/**
 * Extracts `require` and `tool` dependencies from go.mod. `// indirect`
 * requirements are kept with their own scope. A tool names a package, so it is
 * attached to the required module whose path is its longest prefix.
 */
export function extractGoDependencies(text: string): DependencyEntry[] {
  const modules: GoModule[] = [];
  const byPath = new Map<string, GoModule>();
  const tools: GoToken[] = [];
  const addRequire = (token: GoToken, comment: string): void => {
    if (byPath.has(token.value)) return;
    const module = { path: token.value, scope: isIndirect(comment) ? 'indirect' : 'require', range: token.range, toolRanges: [] };
    byPath.set(token.value, module);
    modules.push(module);
  };

  let block: string | undefined;
  for (const { tokens, comment } of goLines(text)) {
    if (tokens.length === 0) continue;
    if (block !== undefined) {
      if (tokens[0]!.value === ')' && !tokens[0]!.quoted) {
        block = undefined;
        continue;
      }
      if (block === 'require' && isPath(tokens[0])) addRequire(tokens[0], comment);
      else if (block === 'tool' && isPath(tokens[0])) tools.push(tokens[0]);
      continue;
    }
    const verb = tokens[0]!.value;
    const argument = tokens[1];
    if (argument?.value === '(' && !argument.quoted) {
      // `require (` opens a block; `require ()` on one line is empty.
      if (!(tokens[2]?.value === ')' && !tokens[2].quoted)) block = verb;
      continue;
    }
    if (verb === 'require' && isPath(argument)) addRequire(argument, comment);
    else if (verb === 'tool' && isPath(argument)) tools.push(argument);
  }

  const standalone: GoModule[] = [];
  for (const tool of tools) {
    let owner: GoModule | undefined;
    for (const module of modules) {
      if ((tool.value === module.path || tool.value.startsWith(`${module.path}/`))
        && (!owner || module.path.length > owner.path.length)) owner = module;
    }
    if (owner) {
      owner.toolRanges.push(tool.range);
    } else if (!byPath.has(tool.value)) {
      const module = { path: tool.value, scope: 'tool', range: tool.range, toolRanges: [] };
      byPath.set(tool.value, module);
      standalone.push(module);
    }
  }

  return [...modules, ...standalone]
    .sort((a, b) => a.range.offset - b.range.offset)
    .map((module) => dependencyEntry(module.path, module.scope, module.range, [module.range, ...module.toolRanges]));
}
