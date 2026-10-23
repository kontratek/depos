import { S } from './strings';
import { esc, nonce } from './webviewCommon';

/**
 * Webview markup for the note panel. Pure string building — no vscode
 * import — so it is unit-testable and provably free of external loads.
 *
 * Static markup only — the dependency name, the two layers and their rendered
 * HTML arrive by postMessage. Text is set as value/textContent; the rendered
 * HTML goes through `sanitize` before it touches the page, and the CSP blocks
 * scripts, styles and network loads on top of that.
 */
export function renderHtml(): string {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<title>${esc(S.panelTitle(''))}</title>
<style nonce="${n}">
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    /* One height for both boxes of a layer: see the .view comment below.
       Nine lines of the UI font, resolved here rather than as an em on each
       box — the editor has a font size of its own, and 9em would come out
       taller on the textarea than on the view it replaces. */
    --note-min: calc(var(--vscode-font-size, 13px) * 9);
    margin: 0; padding: 12px 14px 18px;
    display: flex; flex-direction: column; gap: 10px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  header { display: flex; flex-direction: column; gap: 4px; }
  .dep {
    font-size: 1.25em; font-weight: 600; line-height: 1.2;
    font-family: var(--vscode-editor-font-family);
    color: var(--vscode-foreground);
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    font-size: .9em; color: var(--vscode-descriptionForeground);
  }
  .meta button { margin-left: auto; }
  .pill {
    padding: 1px 6px; border-radius: 3px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    font-size: .85em;
  }
  button {
    font-family: inherit; font-size: .9em;
    padding: 3px 9px; border-radius: 2px; cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button:focus-visible, summary:focus-visible {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
  }

  /* Both layers get a quiet label over the text; the human one also gets the
     pen, which is the one cue that does not wait for the mouse — the fill,
     the frame and the caret all arrive too late to say the text can be
     written in. The agent block needs none: its own summary line says who
     writes there, and it is not where people are invited to type. */
  .caption, summary {
    font-size: .9em; font-weight: 600; color: var(--vscode-descriptionForeground);
  }
  .caption {
    display: flex; align-items: center; gap: 6px; width: fit-content;
    margin-bottom: 3px; cursor: pointer; user-select: none;
  }
  .pen { flex: none; opacity: .5; transition: opacity .12s ease; }
  .layer:hover .pen, .layer:focus-within .pen { opacity: 1; }

  /* A layer is either its rendered view or its editor, never both. At rest it
     is text on the page — no frame, no fill; the frame belongs to writing.
     The two boxes are otherwise one box: the same --note-min floor however
     little the note says, and their text at the same x, so clicking into a
     layer draws a frame around the words without moving anything. The
     negative margin is what lets that frame sit outside the text column. */
  .view {
    margin: 0 -9px; padding: 6px 8px; min-height: var(--note-min); line-height: 1.5;
    border: 1px solid transparent; border-radius: 3px;
    cursor: text; overflow-wrap: anywhere;
  }
  .view:hover { background: var(--vscode-list-hoverBackground); }
  .view:focus-visible {
    outline: none;
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-focusBorder);
  }
  .view.empty { color: var(--vscode-input-placeholderForeground); font-style: italic; }
  .view > :first-child { margin-top: 0; }
  .view > :last-child { margin-bottom: 0; }
  .view p { margin: 0 0 .6em; }
  .view ul, .view ol { margin: 0 0 .6em; padding-left: 1.5em; }
  .view li { margin: .15em 0; }
  .view h1, .view h2, .view h3, .view h4 { font-size: 1em; margin: .8em 0 .3em; }
  .view code {
    font-family: var(--vscode-editor-font-family); font-size: .92em;
    background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 2px;
  }
  .view pre { overflow-x: auto; padding: 6px 8px; border-radius: 2px; background: var(--vscode-textCodeBlock-background); }
  .view pre code { background: none; padding: 0; }
  .view a { color: var(--vscode-textLink-foreground); }
  .view blockquote {
    margin: 0 0 .6em; padding-left: .8em;
    border-left: 3px solid var(--vscode-textBlockQuote-border, rgba(128,128,128,.4));
    color: var(--vscode-descriptionForeground);
  }
  .view img { display: none; }
  textarea {
    display: block; width: calc(100% + 18px); margin: 0 -9px;
    min-height: var(--note-min); max-height: 40vh;
    resize: none; overflow-y: auto;
    padding: 6px 8px;
    font-family: var(--vscode-editor-font-family);
    font-size: var(--vscode-editor-font-size);
    line-height: 1.5;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-focusBorder);
    border-radius: 2px; outline: none;
  }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground); }

  /* The agent layer: folded by default, a line count on the fold. */
  details { flex: none; }
  summary {
    display: flex; align-items: center; gap: 7px;
    cursor: pointer; user-select: none; list-style: none;
  }
  summary::-webkit-details-marker { display: none; }
  summary::before {
    content: ''; width: 0; height: 0; flex: none;
    border-left: 5px solid currentColor; border-top: 4px solid transparent; border-bottom: 4px solid transparent;
    transition: transform .12s ease;
  }
  details[open] summary::before { transform: rotate(90deg); }
  .count {
    padding: 0 6px; border-radius: 8px; font-size: .85em; font-weight: 400;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .help { margin: 6px 0 0 12px; font-size: .86em; line-height: 1.4; color: var(--vscode-descriptionForeground); }
  #agentLayer { margin-top: 6px; }
  /* Problems in the agent block, listed right under it. */
  .problems {
    display: flex; align-items: flex-start; gap: 10px; margin-top: 6px;
    padding: 6px 9px; border-radius: 2px; font-size: .88em; line-height: 1.45;
    color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
    background: rgba(255, 200, 0, 0.08);
    border-left: 3px solid var(--vscode-editorWarning-foreground, rgba(255, 200, 0, .6));
  }
  .problems span { flex: 1; overflow-wrap: anywhere; }
  .problems button { flex: none; }

  footer {
    display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap;
    font-size: .9em; color: var(--vscode-descriptionForeground); min-height: 1.2em;
  }
  .status.dirty { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); }
  /* The organization layer: read-only, from Depos, never merged with the note. */
  .org {
    display: flex; flex-direction: column; gap: 6px;
    padding: 8px 10px; border-left: 3px solid var(--vscode-textLink-foreground);
    background: var(--vscode-textBlockQuote-background);
  }
  .org-head, .org-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .org-foot { font-size: .9em; color: var(--vscode-descriptionForeground); }
  .org-detail { font-size: .9em; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
  .pill.denied { background: var(--vscode-inputValidation-errorBackground, var(--vscode-badge-background)); }
  .pill.unlisted { background: var(--vscode-inputValidation-warningBackground, var(--vscode-badge-background)); }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
  <header>
    <div class="dep" id="dep"></div>
    <div class="meta">
      <span class="pill" id="depSection" hidden></span>
      <span id="fileHint"></span>
      <button type="button" id="openFile">${esc(S.panelOpenFile)}</button>
    </div>
  </header>

  <section class="org" id="orgLayer" hidden>
    <div class="org-head">
      <span class="pill" id="orgResult"></span>
    </div>
    <div class="org-detail" id="orgDetail" hidden></div>
    <div class="org-foot">
      <span id="orgReceived"></span>
    </div>
  </section>

  <section class="layer">
    <div class="caption"><span id="humanCaption">${esc(S.panelHumanNotes)}</span><svg class="pen" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2 14l1.4-4.2 7.2-7.2a2 2 0 0 1 2.8 2.8l-7.2 7.2L2 14z"/></svg></div>
    <div class="view" id="humanView" tabindex="0" role="button" aria-labelledby="humanCaption"></div>
    <textarea id="human" spellcheck="false" aria-labelledby="humanCaption" placeholder="${esc(S.panelPlaceholder)}" hidden></textarea>
  </section>

  <details id="agentBox">
    <summary><span id="agentCaption">${esc(S.panelAgentNotes)}</span><span class="count" id="agentCount" hidden></span></summary>
    <p class="help">${esc(S.panelAgentHelp)}</p>
    <section class="layer" id="agentLayer">
      <div class="view" id="agentView" tabindex="0" role="button" aria-labelledby="agentCaption"></div>
      <textarea id="agent" spellcheck="false" aria-labelledby="agentCaption" placeholder="${esc(S.panelAgentPlaceholder)}" hidden></textarea>
    </section>
    <div class="problems" id="agentProblems" hidden>
      <span id="problemsText"></span>
      <button type="button" id="fixAgent">${esc(S.panelFix)}</button>
    </div>
  </details>

  <footer>
    <span class="status" id="status"></span>
    <span id="editHint"></span>
  </footer>

<script nonce="${n}">
(function () {
  const vscode = acquireVsCodeApi();
  const el = (id) => document.getElementById(id);
  const dep = el('dep'), depSection = el('depSection'), fileHint = el('fileHint');
  const status = el('status'), editHint = el('editHint'), agentCount = el('agentCount');
  const agentBox = el('agentBox'), problems = el('agentProblems'), problemsText = el('problemsText'), fixBtn = el('fixAgent');

  const T = ${JSON.stringify({
    saving: S.panelSaving,
    emptyHuman: S.panelEmptyHuman,
    emptyAgent: S.panelEmptyAgent,
    editHint: S.panelEditHint,
  })};

  const layers = {
    human: { box: el('human'), view: el('humanView'), empty: T.emptyHuman },
    agent: { box: el('agent'), view: el('agentView'), empty: T.emptyAgent },
  };

  // Which dependency the boxes currently hold; every message carries it.
  let key = '';
  let baseline = { human: '', agent: '' };
  let timer;

  // The host renders Markdown with VS Code's own engine; this strips anything
  // that could act on its own before it goes into the page (the CSP already
  // blocks scripts and loads — this keeps the markup honest as well).
  function sanitize(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, iframe, object, embed, link, meta, form, base').forEach((n) => n.remove());
    doc.querySelectorAll('*').forEach((node) => {
      for (const attr of Array.from(node.attributes)) {
        const name = attr.name.toLowerCase();
        const bad = name.startsWith('on') ||
          ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\\s*(javascript|data|vbscript):/i.test(attr.value));
        if (bad) node.removeAttribute(attr.name);
      }
    });
    return doc.body.innerHTML;
  }

  function show(name, html) {
    const v = layers[name].view;
    if (html) {
      v.innerHTML = sanitize(html);
      v.classList.remove('empty');
    } else {
      v.textContent = layers[name].empty;
      v.classList.add('empty');
    }
  }
  function values() {
    return { human: layers.human.box.value, agent: layers.agent.box.value };
  }
  function dirty() {
    const v = values();
    return v.human.trim() !== baseline.human.trim() || v.agent.trim() !== baseline.agent.trim();
  }
  function autosize(box) {
    box.style.height = 'auto';
    box.style.height = (box.scrollHeight + 2) + 'px';
  }
  function countAgentLines() {
    const n = layers.agent.box.value.split('\\n').filter((l) => l.trim() !== '').length;
    agentCount.textContent = String(n);
    agentCount.hidden = n === 0;
  }
  // Problems in the agent block, listed under it; the box unfolds so they are seen.
  function showProblems(p) {
    if (!p || p.items.length === 0) {
      problems.hidden = true;
      return;
    }
    problemsText.textContent = p.header + ' ' + p.items.join(' · ');
    fixBtn.hidden = p.fixable === 0;
    problems.hidden = false;
    agentBox.open = true;
  }
  function post(type) {
    vscode.postMessage(Object.assign({ type, key }, values()));
  }
  function save() {
    clearTimeout(timer);
    timer = undefined;
    if (!dirty()) return;
    baseline = values();
    status.textContent = T.saving;
    status.classList.add('dirty');
    post('save');
  }
  // Org mode for a member who cannot change org notes: the note is shown, never edited.
  let readOnly = false;
  let readOnlyHint = '';

  function edit(name) {
    if (readOnly) return;
    const l = layers[name];
    l.view.hidden = true;
    l.box.hidden = false;
    autosize(l.box);
    l.box.focus();
    l.box.setSelectionRange(l.box.value.length, l.box.value.length);
    editHint.textContent = T.editHint;
  }
  function finish(name) {
    const l = layers[name];
    if (l.box.hidden) return;
    l.box.hidden = true;
    l.view.hidden = false;
    editHint.textContent = '';
    save(); // the rendered view refreshes on 'saved'; unchanged text keeps its render
  }
  function readMode() {
    for (const name of Object.keys(layers)) {
      layers[name].box.hidden = true;
      layers[name].view.hidden = false;
    }
    editHint.textContent = readOnly ? readOnlyHint : '';
  }

  for (const name of Object.keys(layers)) {
    const l = layers[name];
    l.view.addEventListener('click', () => edit(name));
    l.view.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); edit(name); }
    });
    l.box.addEventListener('input', () => {
      autosize(l.box);
      if (name === 'agent') countAgentLines();
      post('input');
      clearTimeout(timer);
      timer = setTimeout(save, 600);
    });
    l.box.addEventListener('blur', () => finish(name));
    l.box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(name); }
    });
  }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'Enter')) {
      e.preventDefault();
      save();
    }
  });
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
  el('humanCaption').parentElement.addEventListener('click', () => edit('human'));
  // In org mode the notes file is not used: the header button opens the package in
  // Depos instead, where the note and the allowlist decision live.
  const openFileBtn = el('openFile');
  const openFileLabel = openFileBtn.textContent;
  let openInWeb = false;
  openFileBtn.addEventListener('click', () => {
    if (openInWeb) vscode.postMessage({ type: 'openWeb' });
    else vscode.postMessage({ type: 'openFile' });
  });

  // The allowlist result from Depos. Every string is set as text.
  function showOrg(o) {
    const box = el('orgLayer');
    box.hidden = !o;
    openInWeb = !!o;
    openFileBtn.textContent = o ? o.openWeb : openFileLabel;
    if (!o) return;
    const result = el('orgResult'), detail = el('orgDetail');
    result.className = 'pill ' + o.tone;
    result.textContent = o.text;
    detail.hidden = !o.detail;
    detail.textContent = o.detail;
    el('orgReceived').textContent = o.received;
  }
  fixBtn.addEventListener('click', () => post('fixAgent'));

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type === 'load') {
      // Text still pending for the previous dependency is saved under ITS key first.
      if (timer !== undefined) save();
      key = m.key;
      readOnly = !!m.readOnly;
      readOnlyHint = m.readOnlyHint || '';
      dep.textContent = m.name;
      depSection.textContent = m.depSection;
      depSection.hidden = !m.depSection;
      fileHint.textContent = m.hint;
      layers.human.box.value = m.human;
      layers.agent.box.value = m.agent;
      baseline = { human: m.human, agent: m.agent };
      show('human', m.humanHtml);
      show('agent', m.agentHtml);
      countAgentLines();
      status.textContent = '';
      status.classList.remove('dirty');
      readMode();
      showProblems(m.problems);
      showOrg(m.org);
      // A dependency without a note opens straight into writing.
      if (m.human === '' && !readOnly) edit('human');
    } else if (m.type === 'saved') {
      if (m.key !== key) return;
      baseline = { human: m.human, agent: m.agent };
      // Whatever is still being typed stays; only a box at rest takes the saved text.
      if (layers.human.box.hidden) layers.human.box.value = m.human;
      if (layers.agent.box.hidden) layers.agent.box.value = m.agent;
      show('human', m.humanHtml);
      show('agent', m.agentHtml);
      countAgentLines();
      showProblems(m.problems);
      status.textContent = m.status;
      status.classList.remove('dirty');
    } else if (m.type === 'problems') {
      if (m.key === key) showProblems(m.problems);
    } else if (m.type === 'org') {
      if (m.key === key) showOrg(m.org);
    }
  });

  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}
