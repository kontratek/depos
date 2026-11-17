/**
 * The quote-aware scanning every TOML reader here needs: where a line's comment
 * starts, where its `=` is, and how far a value nests. Shared by the manifest
 * reader (`python-manifest.ts`), which wants source ranges, and the lockfile
 * reader (`python-lockfile.ts`), which wants whole lines.
 *
 * Neither is a general TOML parser, and this is not one either: it reads the
 * shapes those two files use, not the format.
 */

export function lineRecords(text: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  while (offset <= text.length) {
    const newline = text.indexOf('\n', offset);
    const rawEnd = newline < 0 ? text.length : newline;
    const end = rawEnd > offset && text[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
    out.push({ text: text.slice(offset, end), offset });
    if (newline < 0) break;
    offset = newline + 1;
  }
  return out;
}

/** Where the line's comment begins, or its length: a `#` inside a string is not one. */
export function commentStart(value: string): number {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quote === '"' && escaped) escaped = false;
    else if (quote === '"' && char === '\\') escaped = true;
    else if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#') return i;
  }
  return value.length;
}

/** The index of the `=` that separates key from value, or -1: one inside a string is not it. */
export function unquotedEquals(raw: string): number {
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (quote === '"' && escaped) escaped = false;
    else if (quote === '"' && char === '\\') escaped = true;
    else if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '=') return i;
  }
  return -1;
}

/** How much the text opens or closes arrays and inline tables, ignoring brackets inside strings. */
export function nestingDelta(raw: string): number {
  let delta = 0;
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (const char of raw) {
    if (quote === '"' && escaped) escaped = false;
    else if (quote === '"' && char === '\\') escaped = true;
    else if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') delta++;
    else if (char === ']' || char === '}') delta--;
  }
  return delta;
}
