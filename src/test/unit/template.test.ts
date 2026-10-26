import { describe, expect, it } from 'vitest';
import { normalizeText } from '../../core/serialize';
import {
  AGENT_RULES_REL_PATH,
  AI_FORMAT_COMMENT_LINES,
  DEFAULT_FRONTMATTER_LINES,
  LEGACY_NOTES_DIR,
  NOTES_DIR,
  NOTES_DIRS,
  NOTES_REL_PATH,
  agentRulesRelPath,
  aiInstructionsBlock,
  formatCommentLines,
  inNotesDir,
  newNotesFileContent,
  notesDirOf,
  upsertAiInstructions,
} from '../../core/template';

describe('template: frontmatter and header', () => {
  it('declares the two format keys, in order, between the dashes', () => {
    expect(DEFAULT_FRONTMATTER_LINES[0]).toBe('---');
    expect(DEFAULT_FRONTMATTER_LINES[DEFAULT_FRONTMATTER_LINES.length - 1]).toBe('---');
    expect(DEFAULT_FRONTMATTER_LINES.slice(1, -1)).toEqual([
      'format: dependency-notes/1',
      'lang: en',
    ]);
  });

  it('keeps the header to three lines that only say who writes where', () => {
    expect(AI_FORMAT_COMMENT_LINES).toHaveLength(3);
    expect(AI_FORMAT_COMMENT_LINES[0]?.startsWith('<!--')).toBe(true);
    expect(AI_FORMAT_COMMENT_LINES[2]?.endsWith('-->')).toBe(true);
    const text = AI_FORMAT_COMMENT_LINES.join('\n');
    expect(text).toContain('package.json');
    expect(text).toContain('### Agent notes');
    expect(text).toContain(AGENT_RULES_REL_PATH);
    // The old recognized bullets are gone from the format entirely.
    expect(text).not.toMatch(/\bwhy:|\bcaution:/);
  });

  it('produces a fresh file that is already canonical', () => {
    const fresh = newNotesFileContent('\n', 'a', 'x');
    expect(fresh).toContain('## a');
    expect(fresh).toContain('\nx\n');
    expect(normalizeText(fresh)).toBe(fresh);
  });

  it('creates v2 ecosystem notes without changing the npm v1 default', () => {
    const cargo = newNotesFileContent('\n', 'serde', 'Serialization.', 'cargo');
    expect(cargo).toContain('format: dependency-notes/2');
    expect(cargo).toContain('ecosystem: cargo');
    expect(cargo).toContain('cargo dependency manifest');
    expect(normalizeText(cargo)).toBe(cargo);
    expect(newNotesFileContent('\n', 'express')).toContain('format: dependency-notes/1');
    const gradle = newNotesFileContent('\n', 'org.slf4j:slf4j-api', 'Logging.', 'gradle');
    expect(gradle).toContain('ecosystem: gradle');
    expect(gradle).toContain('gradle dependency manifest');
    expect(normalizeText(gradle)).toBe(gradle);
    const mix = newNotesFileContent('\n', 'phoenix', 'Framework.', 'mix');
    expect(mix).toContain('ecosystem: mix');
    const gleam = newNotesFileContent('\n', 'gleam_stdlib', 'Standard library.', 'gleam');
    expect(gleam).toContain('ecosystem: gleam');
    expect(mix).toContain('mix dependency manifest');
    expect(normalizeText(mix)).toBe(mix);
    const zig = newNotesFileContent('\n', 'known_folders', 'Platform directories.', 'zig');
    expect(zig).toContain('ecosystem: zig');
    const python = newNotesFileContent('\n', 'requests', 'HTTP client', 'python');
    expect(python).toContain('ecosystem: python');
    const ruby = newNotesFileContent('\n', 'rack', 'Web server interface.', 'ruby');
    expect(ruby).toContain('ecosystem: ruby');
    expect(ruby).toContain('ruby dependency manifest');
    expect(normalizeText(ruby)).toBe(ruby);
    const nuget = newNotesFileContent('\n', 'Newtonsoft.Json', 'JSON serialization', 'nuget');
    expect(nuget).toContain('ecosystem: nuget');
    expect(nuget).toContain('nuget dependency manifest');
    expect(normalizeText(nuget)).toBe(nuget);
    const go = newNotesFileContent('\n', 'github.com/spf13/cobra', 'CLI framework.', 'go');
    expect(go).toContain('ecosystem: go');
    expect(go).toContain('go dependency manifest');
    expect(normalizeText(go)).toBe(go);
    const vcpkg = newNotesFileContent('\n', 'fmt', 'Formatting.', 'vcpkg');
    expect(vcpkg).toContain('ecosystem: vcpkg');
    expect(vcpkg).toContain('vcpkg dependency manifest');
    const conan = newNotesFileContent('\n', 'zlib', 'Compression.', 'conan');
    expect(conan).toContain('ecosystem: conan');
    expect(conan).toContain('conan dependency manifest');
    const composer = newNotesFileContent('\n', 'monolog/monolog', 'Logging.', 'composer');
    expect(composer).toContain('ecosystem: composer');
    expect(composer).toContain('composer dependency manifest');
    expect(normalizeText(composer)).toBe(composer);
    expect(zig).toContain('zig dependency manifest');
    expect(normalizeText(zig)).toBe(zig);
  });
});

describe('template: pointer block for the user’s agent files', () => {
  const between = (text: string): string[] => {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.includes('depos:start'));
    const end = lines.findIndex((l) => l.includes('depos:end'));
    return lines.slice(start + 1, end);
  };

  it('is exactly three lines and points at both files', () => {
    const inner = between(aiInstructionsBlock());
    expect(inner).toHaveLength(3);
    const text = inner.join('\n');
    expect(text).toContain(NOTES_REL_PATH);
    expect(text).toContain(AGENT_RULES_REL_PATH);
    expect(text).toContain('### Agent notes');
    expect(text).toContain('status: removed');
    expect(text).toContain('.depos/mix/DEPENDENCY-NOTES.md');
    expect(text).toContain('.depos/zig/DEPENDENCY-NOTES.md');
    expect(text).toContain('.depos/nuget/DEPENDENCY-NOTES.md');
    expect(text).toContain('.depos/ruby/DEPENDENCY-NOTES.md');
    expect(text).toContain('.depos/composer/DEPENDENCY-NOTES.md');
    expect(text).not.toContain('.pacmon/');
  });

  it('names the repository’s own directory when it still keeps its notes in .pacmon/', () => {
    const text = between(aiInstructionsBlock('.pacmon')).join('\n');
    expect(text).toContain('.pacmon/DEPENDENCY-NOTES.md');
    expect(text).toContain('.pacmon/cargo/DEPENDENCY-NOTES.md');
    expect(text).toContain('.pacmon/AGENT-RULES.md');
    expect(text).not.toContain('.depos/');
  });

  it('appends the block once and replaces it on re-run', () => {
    const first = upsertAiInstructions('# AGENTS\n\nexisting\n');
    expect(first).toContain('depos:start');
    const second = upsertAiInstructions(first);
    expect(second.match(/depos:start/g)).toHaveLength(1);
    expect(second).toContain('existing');
    expect(between(second)).toHaveLength(3);
  });

  it('works on empty files', () => {
    const out = upsertAiInstructions('');
    expect(out.startsWith('<!-- depos:start -->')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
  });

  it('replaces a block left by the old markers', () => {
    const old = '# AGENTS\n\n<!-- pacmon:deps-notes:start -->\nold\n<!-- pacmon:deps-notes:end -->\n';
    const out = upsertAiInstructions(old);
    expect(out).not.toContain('deps-notes');
    expect(out).not.toContain('\nold\n');
    expect(between(out)).toHaveLength(3);
  });

  it('replaces the block Pacmon wrote, in place', () => {
    const old = '# AGENTS\n\nbefore\n\n<!-- pacmon:start -->\nold\n<!-- pacmon:end -->\n\nafter\n';
    const out = upsertAiInstructions(old);
    expect(out).not.toContain('pacmon:');
    expect(out).not.toContain('\nold\n');
    expect(out.indexOf('before')).toBeLessThan(out.indexOf('depos:start'));
    expect(out.indexOf('depos:end')).toBeLessThan(out.indexOf('after'));
    expect(between(out)).toHaveLength(3);
  });

  it('comes back to one block when an older version added its own', () => {
    // A teammate on Pacmon ran the setup after this file got the Depos block:
    // Pacmon did not know the new markers and appended a block of its own.
    const mixed = `# AGENTS\n\nintro\n\n${aiInstructionsBlock()}\n\nmiddle\n\n<!-- pacmon:start -->\nold\n<!-- pacmon:end -->\n`;
    const out = upsertAiInstructions(mixed);
    expect(out.match(/depos:start/g)).toHaveLength(1);
    expect(out).not.toContain('pacmon:');
    expect(out).toBe(`# AGENTS\n\nintro\n\n${aiInstructionsBlock()}\n\nmiddle\n`);
  });

  it('keeps CRLF files CRLF around a removed block', () => {
    const mixed = `intro\r\n\r\n<!-- depos:start -->\r\nx\r\n<!-- depos:end -->\r\n\r\nmiddle\r\n\r\n<!-- pacmon:start -->\r\nold\r\n<!-- pacmon:end -->\r\n\r\nend\r\n`;
    const out = upsertAiInstructions(mixed);
    expect(out).toContain('\r\n\r\nmiddle\r\n\r\nend\r\n');
    expect(out).not.toContain('pacmon:');
  });
});

describe('template: the notes directory', () => {
  it('is .depos/, with .pacmon/ from before the rename still known', () => {
    expect(NOTES_DIR).toBe('.depos');
    expect(LEGACY_NOTES_DIR).toBe('.pacmon');
    expect(NOTES_DIRS).toEqual(['.depos', '.pacmon']);
    expect(NOTES_REL_PATH).toBe('.depos/DEPENDENCY-NOTES.md');
    expect(AGENT_RULES_REL_PATH).toBe('.depos/AGENT-RULES.md');
    expect(agentRulesRelPath('.pacmon')).toBe('.pacmon/AGENT-RULES.md');
  });

  it('reads the directory off a path', () => {
    expect(notesDirOf('/repo/.depos/DEPENDENCY-NOTES.md')).toBe('.depos');
    expect(notesDirOf('/repo/apps/web/.pacmon/cargo/DEPENDENCY-NOTES.md')).toBe('.pacmon');
    expect(notesDirOf('C:\\repo\\.pacmon\\DEPENDENCY-NOTES.md')).toBe('.pacmon');
    expect(notesDirOf('.pacmon/AGENT-RULES.md')).toBe('.pacmon');
    expect(notesDirOf('/repo/not.pacmon/DEPENDENCY-NOTES.md')).toBe('.depos');
  });

  it('rewrites text written for .depos/ for a repository on .pacmon/', () => {
    const text = 'Notes in `.depos/DEPENDENCY-NOTES.md`; see https://depos.dev/format/.';
    expect(inNotesDir(text, '.depos')).toBe(text);
    expect(inNotesDir(text, '.pacmon')).toBe('Notes in `.pacmon/DEPENDENCY-NOTES.md`; see https://depos.dev/format/.');
  });

  it('names the AGENT-RULES.md beside the notes file in its header, and keeps it there', () => {
    const fresh = newNotesFileContent('\n', 'a', 'x', undefined, '.pacmon');
    expect(fresh).toContain('rules in .pacmon/AGENT-RULES.md');
    // Formatting a .pacmon/ file never moves its header to .depos/: two
    // versions in one team would otherwise rewrite it in turn on every save.
    expect(normalizeText(fresh, '.pacmon')).toBe(fresh);
    expect(normalizeText(fresh)).toContain('rules in .depos/AGENT-RULES.md');
    const cargo = newNotesFileContent('\n', 'serde', 'Serialization.', 'cargo', '.pacmon');
    expect(cargo).toContain('rules in .pacmon/AGENT-RULES.md');
    expect(normalizeText(cargo, '.pacmon')).toBe(cargo);
    expect(formatCommentLines('cargo').join('\n')).toContain('rules in .depos/AGENT-RULES.md');
  });
});
