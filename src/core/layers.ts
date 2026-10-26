import type { NoteSection, NotesFileModel } from './model';

/**
 * A package section has up to three layers, split by reserved sub-headings:
 *
 *   ## name
 *   <human>            free text, written by people, never parsed
 *   ### Agent notes
 *   <agent>            `- key: value` lines, written by AI agents
 *   ### Generated      reserved for a future version, preserved verbatim
 *
 * Line ranges are 0-based, end-exclusive, and refer to model.lines.
 */
export interface LayerRanges {
  humanStart: number;
  humanEnd: number;
  agentStart?: number;
  agentEnd?: number;
  /** Starts AT the `### Generated` heading line — the heading belongs to the block. */
  generatedStart?: number;
  generatedEnd?: number;
}

export function layerRanges(s: NoteSection): LayerRanges {
  const humanEnd = s.agentHeadingLine ?? s.generatedHeadingLine ?? s.bodyEnd;
  const ranges: LayerRanges = { humanStart: s.bodyStart, humanEnd };
  if (s.agentHeadingLine !== undefined) {
    ranges.agentStart = s.agentHeadingLine + 1;
    ranges.agentEnd = s.generatedHeadingLine ?? s.bodyEnd;
  }
  if (s.generatedHeadingLine !== undefined) {
    ranges.generatedStart = s.generatedHeadingLine;
    ranges.generatedEnd = s.bodyEnd;
  }
  return ranges;
}

/** Lines [start, end) with outer blank lines trimmed, joined with '\n'. */
function slice(model: NotesFileModel, start: number | undefined, end: number | undefined): string {
  if (start === undefined || end === undefined) return '';
  let a = start;
  let b = end;
  while (a < b && (model.lines[a] ?? '').trim() === '') a++;
  while (b > a && (model.lines[b - 1] ?? '').trim() === '') b--;
  return model.lines.slice(a, b).join('\n');
}

export interface SectionLayers {
  human: string;
  agent: string;
  generated: string;
}

export function sectionLayers(model: NotesFileModel, s: NoteSection): SectionLayers {
  const r = layerRanges(s);
  return {
    human: slice(model, r.humanStart, r.humanEnd),
    agent: slice(model, r.agentStart, r.agentEnd),
    generated: slice(model, r.generatedStart, r.generatedEnd),
  };
}

/** A heading and nothing else: no human text, no agent block, no generated block. */
export function isEmptySection(model: NotesFileModel, s: NoteSection): boolean {
  const l = sectionLayers(model, s);
  return l.human === '' && l.agent === '' && l.generated === '';
}

export interface AgentField {
  /** Lower-cased key. */
  key: string;
  value: string;
}

/** One `- key: value` line of the agent layer. Shared with the lint and the quick
 *  fixes. Underscores are accepted here so `bump_with` is seen as a (wrong) key
 *  rather than prose. */
export const AGENT_FIELD_RE = /^\s*[-*]\s+([a-z][a-z0-9_-]*)\s*:\s*(.*)$/i;

/**
 * `- key: value` lines of the agent layer, in order, repeats kept. Lines that
 * are not fields (prose, sub-lists, code) are skipped, never rejected.
 */
export function parseAgentFields(agent: string): AgentField[] {
  const out: AgentField[] = [];
  for (const line of agent.split('\n')) {
    const m = AGENT_FIELD_RE.exec(line);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      out.push({ key: m[1].toLowerCase(), value: m[2].trim() });
    }
  }
  return out;
}

/** First value for a key, or undefined. */
export function agentField(fields: readonly AgentField[], key: string): string | undefined {
  const k = key.toLowerCase();
  return fields.find((f) => f.key === k)?.value;
}

/**
 * A section kept on purpose for a package that left package.json:
 * `- status: removed <YYYY-MM> — <reason>` under `### Agent notes`.
 * Such sections are not orphans.
 */
export function isRemovedSection(model: NotesFileModel, s: NoteSection): boolean {
  const status = agentField(parseAgentFields(sectionLayers(model, s).agent), 'status');
  return status !== undefined && /^removed\b/i.test(status);
}

/** Which layer the end-of-line preview leads with (setting `depos.inlineSource`). */
export type InlineSource = 'human-first' | 'ai-first' | 'human-only' | 'ai-only';
export const INLINE_SOURCES: readonly InlineSource[] = ['human-first', 'ai-first', 'human-only', 'ai-only'];

/**
 * Both layers for display (hover), non-empty ones only, ordered by the setting.
 * The `-only` variants restrict the one-line preview, not the hover — the
 * hover always shows everything that is there.
 */
export function orderedLayers(
  l: SectionLayers,
  source: InlineSource,
): { kind: 'human' | 'agent'; text: string }[] {
  const human = { kind: 'human' as const, text: l.human };
  const agent = { kind: 'agent' as const, text: l.agent };
  const ordered = source === 'ai-first' || source === 'ai-only' ? [agent, human] : [human, agent];
  return ordered.filter((p) => p.text !== '');
}

/** First non-empty human line; a leading list marker is dropped for display only. */
export function humanPreviewLine(human: string): string {
  const line = human.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.trim().replace(/^[-*]\s+/, '');
}

/** The agent's `purpose:` value, or ''. */
export function agentPreviewLine(agent: string): string {
  return agentField(parseAgentFields(agent), 'purpose') ?? '';
}

/**
 * The one-line preview shown at the end of a package.json line. Never parses
 * the human text beyond taking its first line.
 */
export function notePreview(l: SectionLayers, source: InlineSource = 'human-first', maxLen = 90): string {
  const human = humanPreviewLine(l.human);
  const agent = agentPreviewLine(l.agent);
  let text: string;
  switch (source) {
    case 'human-first':
      text = human || agent;
      break;
    case 'ai-first':
      text = agent || human;
      break;
    case 'human-only':
      text = human;
      break;
    case 'ai-only':
      text = agent;
      break;
  }
  if (text === '') return 'note';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}
