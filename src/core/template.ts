import type { ManifestKind } from './model';

export const FORMAT_VERSION = 'dependency-notes/1';
export const FORMAT_VERSION_V2 = 'dependency-notes/2';
export const SUPPORTED_FORMAT_VERSIONS = [FORMAT_VERSION, FORMAT_VERSION_V2] as const;
export const DEFAULT_LANG = 'en';

/** Everything Depos owns lives beside the dependency manifest under this directory. */
export const NOTES_DIR = '.depos';
/**
 * The directory's name from before Pacmon became Depos. Still read, and still
 * written in a repository that keeps its notes there: the whole repository
 * moves at once, with the move command, never one file at a time.
 */
export const LEGACY_NOTES_DIR = '.pacmon';
/** Where notes may live, in the order they are looked for at each directory level. */
export const NOTES_DIRS = [NOTES_DIR, LEGACY_NOTES_DIR] as const;
export type NotesDir = (typeof NOTES_DIRS)[number];

export const NOTES_FILE_NAME = 'DEPENDENCY-NOTES.md';
export const AGENT_RULES_FILE_NAME = 'AGENT-RULES.md';
export const NOTES_REL_PATH = `${NOTES_DIR}/${NOTES_FILE_NAME}`;
export const AGENT_RULES_REL_PATH = `${NOTES_DIR}/${AGENT_RULES_FILE_NAME}`;

export function agentRulesRelPath(dir: NotesDir = NOTES_DIR): string {
  return `${dir}/${AGENT_RULES_FILE_NAME}`;
}

/** The notes directory a path sits in: the legacy name under `.pacmon/`, the current one otherwise. */
export function notesDirOf(path: string): NotesDir {
  return /(^|\/)\.pacmon\//.test(path.replace(/\\/g, '/')) ? LEGACY_NOTES_DIR : NOTES_DIR;
}

/**
 * Text written for the current directory (AGENT-RULES.md, the pointer block),
 * as it reads in a repository that keeps its notes under `dir`.
 */
export function inNotesDir(text: string, dir: NotesDir): string {
  return dir === NOTES_DIR ? text : text.replaceAll(`${NOTES_DIR}/`, `${dir}/`);
}

/** Reserved sub-headings inside a package section. Matched case-insensitively. */
export const AGENT_NOTES_HEADING = '### Agent notes';
export const GENERATED_HEADING = '### Generated';

/** Frontmatter keys the format defines, in canonical order. The normalizer adds missing ones. */
export const FRONTMATTER_DEFAULTS: ReadonlyArray<readonly [key: string, value: string]> = [
  ['format', FORMAT_VERSION],
  ['lang', DEFAULT_LANG],
];

export const DEFAULT_FRONTMATTER_LINES = [
  '---',
  ...FRONTMATTER_DEFAULTS.map(([key, value]) => `${key}: ${value}`),
  '---',
];

export function frontmatterLinesFor(ecosystem?: ManifestKind): string[] {
  if (!ecosystem || ecosystem === 'npm') return [...DEFAULT_FRONTMATTER_LINES];
  return ['---', `format: ${FORMAT_VERSION_V2}`, `ecosystem: ${ecosystem}`, `lang: ${DEFAULT_LANG}`, '---'];
}

export const DEFAULT_TITLE = '# Dependency Notes';

/**
 * The header comment is owned by the format: the normalizer rewrites it from
 * here, so it stays three lines that say only what cannot be inferred from the
 * file itself. The rules and the field list live in AGENT-RULES.md.
 */
export const AI_FORMAT_COMMENT_LINES = [
  '<!-- Each "## name" below is a package from package.json. The text right under the',
  `  heading is written by people. "${AGENT_NOTES_HEADING}" and everything below it is written`,
  `  by AI agents — rules in ${AGENT_RULES_REL_PATH}. -->`,
];

/**
 * `dir` is the directory the notes file sits in, so that the comment names the
 * AGENT-RULES.md beside it. Derived from the file's path, never from a setting:
 * the normalizer rewrites this comment on every format, and two versions of the
 * extension in one team must not take turns changing it.
 */
export function formatCommentLines(ecosystem?: ManifestKind, dir: NotesDir = NOTES_DIR): string[] {
  if (!ecosystem || ecosystem === 'npm') return AI_FORMAT_COMMENT_LINES.map((line) => inNotesDir(line, dir));
  return [
    `<!-- Each "## name" below is a package from the ${ecosystem} dependency manifest.`,
    `  The text under it is written by people. "${AGENT_NOTES_HEADING}" and everything below`,
    `  it is written by AI agents — rules in ${agentRulesRelPath(dir)}. -->`,
  ];
}

/** Full content of a freshly created notes file. */
export function newNotesFileContent(
  eol: string,
  firstSectionName?: string,
  body?: string,
  ecosystem?: ManifestKind,
  dir: NotesDir = NOTES_DIR,
): string {
  const lines = [
    ...frontmatterLinesFor(ecosystem),
    '',
    ...formatCommentLines(ecosystem, dir),
    '',
    DEFAULT_TITLE,
  ];
  if (firstSectionName) {
    lines.push('', `## ${firstSectionName.trim()}`, '');
    if (body && body.trim() !== '') {
      lines.push(...body.trim().split(/\r?\n/));
    }
  }
  return lines.join(eol) + eol;
}

const AI_BLOCK_START = '<!-- depos:start -->';
const AI_BLOCK_END = '<!-- depos:end -->';
/**
 * Markers written by earlier versions: Pacmon's, and before them the ones from
 * before the format was named `dependency-notes/1`. Still found, never written.
 */
const LEGACY_AI_BLOCKS = [
  ['<!-- pacmon:start -->', '<!-- pacmon:end -->'],
  ['<!-- pacmon:deps-notes:start -->', '<!-- pacmon:deps-notes:end -->'],
] as const;

/**
 * Pointer block for the user's own agent files (AGENTS.md, CLAUDE.md, rules).
 * Deliberately three lines: the rules themselves live in `.depos/AGENT-RULES.md`,
 * which Depos owns; these files it does not. `dir` is the repository's notes
 * directory.
 */
export function aiInstructionsBlock(dir: NotesDir = NOTES_DIR): string {
  return [
    AI_BLOCK_START,
    `Dependency notes live in \`${dir}/${NOTES_FILE_NAME}\` for npm, \`${dir}/cargo/${NOTES_FILE_NAME}\` for Rust, \`${dir}/maven/${NOTES_FILE_NAME}\` for Maven, \`${dir}/gradle/${NOTES_FILE_NAME}\` for Gradle, \`${dir}/mix/${NOTES_FILE_NAME}\` for Mix, \`${dir}/gleam/${NOTES_FILE_NAME}\` for Gleam, \`${dir}/zig/${NOTES_FILE_NAME}\` for Zig, \`${dir}/python/${NOTES_FILE_NAME}\` for Python, \`${dir}/ruby/${NOTES_FILE_NAME}\` for Ruby, \`${dir}/go/${NOTES_FILE_NAME}\` for Go, \`${dir}/nuget/${NOTES_FILE_NAME}\` for .NET/NuGet, \`${dir}/vcpkg/${NOTES_FILE_NAME}\` for vcpkg, \`${dir}/conan/${NOTES_FILE_NAME}\` for Conan, and \`${dir}/composer/${NOTES_FILE_NAME}\` for PHP/Composer; people write below \`## <package>\`, agents under \`${AGENT_NOTES_HEADING}\`.`,
    `Rules and the field list are in \`${agentRulesRelPath(dir)}\`; read a package's section before adding, bumping or removing it.`,
    `Update the notes in the same commit as the dependency manifest; a removed package keeps its section with \`- status: removed …\`.`,
    AI_BLOCK_END,
  ].join('\n');
}

interface BlockRange {
  start: number;
  end: number;
}

/** Every marked block in the text, current and legacy, in the order they appear. */
function markedBlocks(text: string): BlockRange[] {
  const ranges: BlockRange[] = [];
  for (const [startMark, endMark] of [[AI_BLOCK_START, AI_BLOCK_END], ...LEGACY_AI_BLOCKS] as const) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(startMark, from);
      if (start === -1) break;
      const end = text.indexOf(endMark, start + startMark.length);
      if (end === -1) break;
      ranges.push({ start, end: end + endMark.length });
      from = end + endMark.length;
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  // A block inside another (a hand-edited file) is the outer block's business.
  return ranges.filter((range, i) => ranges.slice(0, i).every((other) => range.start >= other.end));
}

/** The text without the block, and without the blank lines it leaves behind. */
function withoutBlock(text: string, range: BlockRange): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const before = text.slice(0, range.start).replace(/(?:\r?\n)+$/, '');
  const after = text.slice(range.end).replace(/^(?:\r?\n)+/, '');
  if (before === '') return after;
  if (after === '') return before + eol;
  return before + eol + eol + after;
}

/**
 * Insert or replace the marked block in an existing instructions file. The
 * first block found, current or legacy, becomes the new one; any other is
 * removed. A teammate on an older version adds a `pacmon:` block of their own,
 * so the file comes back to one block the next time this runs.
 */
export function upsertAiInstructions(existing: string, dir: NotesDir = NOTES_DIR): string {
  const block = aiInstructionsBlock(dir);
  const [first, ...rest] = markedBlocks(existing);
  if (first) {
    let text = existing;
    for (const range of rest.reverse()) text = withoutBlock(text, range);
    return text.slice(0, first.start) + block + text.slice(first.end);
  }
  const sep = existing.length === 0 ? '' : existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + block + '\n';
}
