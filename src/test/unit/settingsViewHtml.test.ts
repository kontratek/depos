import { describe, expect, it } from 'vitest';
import { ALL_NOTE_BUTTONS } from '../../ext/noteButtonIds';
import { renderHtml } from '../../ext/settingsViewHtml';

function scriptOf(html: string): string {
  const m = /<script nonce="[A-Za-z0-9]+">([\s\S]*?)<\/script>/.exec(html);
  expect(m, 'settings view should contain exactly one nonced script block').toBeTruthy();
  return m![1]!;
}

describe('settings view html', () => {
  it('is offline by construction: locked-down CSP, no external references', () => {
    const html = renderHtml();
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/<link\b/);
    expect(html).not.toMatch(/\bsrc=/);
  });

  it('allowlists exactly the nonce it puts on the style and script blocks', () => {
    const html = renderHtml();
    const allowed = [...html.matchAll(/'nonce-([A-Za-z0-9]+)'/g)].map((m) => m[1]);
    const used = [...html.matchAll(/nonce="([A-Za-z0-9]+)"/g)].map((m) => m[1]);
    expect(allowed).toHaveLength(2);
    expect(used).toHaveLength(2);
    expect(new Set([...allowed, ...used]).size).toBe(1);
  });

  it('emits syntactically valid webview JavaScript', () => {
    expect(() => new Function(scriptOf(renderHtml()))).not.toThrow();
  });

  it('renders a toggle and a preview for every click target', () => {
    const html = renderHtml();
    for (const id of ALL_NOTE_BUTTONS) {
      expect(html, `no toggle for ${id}`).toContain(`data-button="${id}"`);
    }
    // One preview block per target — the reason this is a webview at all.
    expect([...html.matchAll(/class="pv"/g)]).toHaveLength(ALL_NOTE_BUTTONS.length);
  });

  it('offers only the two first-class note editors, and every marker style', () => {
    const html = renderHtml();
    for (const v of ['panel', 'peek']) {
      expect(html).toContain(`name="noteEntry" value="${v}"`);
    }
    // Still valid settings values, deliberately not offered here.
    for (const v of ['input', 'inputBeside', 'comments']) {
      expect(html).not.toContain(`name="noteEntry" value="${v}"`);
    }
    // A value set outside the view must not leave the section looking empty.
    expect(html).toContain('id="otherEntry"');
    for (const v of ['preview', 'badge', 'off']) {
      expect(html).toContain(`name="decorations" value="${v}"`);
    }
  });

  it('offers the four inline note sources', () => {
    const html = renderHtml();
    for (const v of ['human-first', 'ai-first', 'human-only', 'ai-only']) {
      expect(html).toContain(`name="inlineSource" value="${v}"`);
    }
    expect([...html.matchAll(/name="inlineSource"/g)]).toHaveLength(4);
  });

  it('names every switch, and lets its words click it', () => {
    const html = renderHtml();
    for (const id of ALL_NOTE_BUTTONS) {
      // The label around the track carries no text, so the name must be a
      // label of its own — otherwise the switch has no accessible name.
      expect(html, `switch ${id} needs an id`).toContain(`<input type="checkbox" id="btn-${id}"`);
      expect(html, `switch ${id} needs its name as a label`).toContain(`<label class="name" for="btn-${id}">`);
      expect(html, `switch ${id} needs its help as a description`).toContain(
        `aria-describedby="btn-${id}-help"`,
      );
      expect(html, `switch ${id} needs the described element`).toContain(`id="btn-${id}-help"`);
    }
  });

  it('gives every action an inline icon, so nothing is loaded from disk', () => {
    const html = renderHtml();
    const buttons = [...html.matchAll(/<button[^>]*class="act"[\s\S]*?<\/button>/g)];
    expect(buttons).toHaveLength(8);
    for (const [b] of buttons) expect(b).toMatch(/<svg[\s\S]*<path/);
  });

  it('only wires the commands the host allows (ALLOWED_COMMANDS in settingsView.ts)', () => {
    const html = renderHtml();
    const commands = [...html.matchAll(/data-command="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(commands).toEqual([
      'depos.normalizeNotesFile',
      'depos.openManifest',
      'depos.openNotesFile',
      'depos.setupAiInstructions',
      'depos.showConnection',
      'depos.showCoverage',
      'depos.signIn',
      'depos.signOut',
    ]);
  });

  it('shows coverage as statistics only', () => {
    const html = renderHtml();
    for (const id of ['ratio', 'pkgLabel', 'barFill', 'covStatus']) {
      expect(html, `coverage needs #${id}`).toContain(`id="${id}"`);
    }
    // Which dependencies have notes is visible on the manifest itself; the
    // view must not grow a second list of them.
    expect(html).not.toContain('class="dep"');
    expect(html).not.toContain('id="undoc"');
    expect(html).not.toContain('id="doc"');
  });

  it('labels the notes-file action from state, not from a hardcoded name', () => {
    const html = renderHtml();
    expect(html).toContain('id="openNotesLabel"');
    expect(scriptOf(html)).toContain('openNotesLabel');
  });

  it('posts the messages the host expects', () => {
    const script = scriptOf(renderHtml());
    for (const type of ['ready', 'setButtons', 'setChoice', 'command']) {
      expect(script, `should post "${type}"`).toContain(`type: '${type}'`);
    }
    // No per-dependency message: the view no longer lists them.
    expect(script).not.toContain("type: 'note'");
  });

  it('offers the Depos sign-in, and draws both states from the posted state', () => {
    const html = renderHtml();
    for (const id of ['depos.signIn', 'depos.showConnection', 'depos.signOut']) {
      expect(html, `no button for ${id}`).toContain(`data-command="${id}"`);
    }
    // Both groups start hidden: the server address and the sign-in state arrive by
    // postMessage, so the markup itself never holds an address.
    expect(html).toMatch(/id="webSignedOut" hidden/);
    expect(html).toMatch(/id="webSignedIn" hidden/);
    expect(scriptOf(html)).toContain('m.web.signedIn');
  });
});
