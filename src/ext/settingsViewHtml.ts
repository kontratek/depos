import { NOTES_REL_PATH } from '../core/template';
import { ALL_NOTE_BUTTONS, type NoteButton } from './noteButtonIds';
import { CHOICE_VALUES } from './settingChoices';
import { S } from './strings';
import { esc, nonce } from './webviewCommon';

/**
 * A small preview of what each click target actually does to a package.json
 * line — the reason this view is a webview and not a tree. Rendered as markup
 * so the mark, the underline and the line-above can each look like the real
 * thing; `sample` never contains user data.
 */

/**
 * The documented state of the mark drawn in `markIcon.ts`, at the preview's
 * own scale. The same three bars, and the fill follows the theme the way the
 * editor's four baked images do.
 */
const MARK_SVG =
  '<svg class="mark" viewBox="0 0 8 8" aria-hidden="true">' +
  '<rect x="2" y="0" width="6" height="2"/>' +
  '<rect x="0" y="3" width="6" height="2"/>' +
  '<rect x="0" y="6" width="6" height="2"/>' +
  '</svg>';

function preview(id: NoteButton): string {
  const dep = `<span class="k">"express"</span><span class="p">: "^4.18.0",</span>`;
  switch (id) {
    case 'iconLeft':
      return `<code class="pv">${MARK_SVG}${dep}</code>`;
    case 'link':
      return `<code class="pv"><span class="k lnk">"express"</span><span class="p">: "^4.18.0",</span></code>`;
    case 'codelens':
      return `<code class="pv"><span class="lens">${esc(S.buttonEdit)}</span><br>${dep}</code>`;
    case 'inlayHint':
      return `<code class="pv">${dep} <span class="chip">${esc(S.buttonEdit)}</span></code>`;
    default:
      return `<code class="pv"><span class="bulb">&#128161;</span> ${dep}</code>`;
  }
}

/**
 * The switch and the words next to it are one control, so the words carry the
 * `<label>`: the label around the track holds no text of its own, which left the
 * checkbox with no accessible name at all and made the 30px track the only
 * place you could click. The help line becomes its description.
 */
function toggleRow(id: NoteButton): string {
  const box = `btn-${esc(id)}`;
  return `<div class="row">
      <label class="sw">
        <input type="checkbox" id="${box}" data-button="${esc(id)}" aria-describedby="${box}-help">
        <span class="track"><span class="knob"></span></span>
      </label>
      <div class="body">
        <div class="head"><label class="name" for="${box}">${esc(S.buttonLabel(id))}</label><span class="gesture">${esc(S.buttonGesture(id))}</span></div>
        ${preview(id)}
        <p class="help" id="${box}-help">${esc(S.buttonHelp(id).replace(/`/g, ''))}</p>
      </div>
    </div>`;
}

function radioRow(key: string, value: string, label: string): string {
  return `<label class="opt">
      <input type="radio" name="${esc(key)}" value="${esc(value)}" data-choice="${esc(key)}">
      <span class="dot"></span>
      <span class="opt-body"><span class="opt-name">${esc(label)}</span><span class="opt-help">${esc(S.settingChoiceHelp(key, value))}</span></span>
    </label>`;
}

/** 16px stroke icons, inline so nothing is loaded from disk. */
const ACTION_ICONS: Record<string, string> = {
  'pacmon.openNotesFile': '<path d="M4 2h6l3 3v9H4z"/><path d="M10 2v3h3"/><path d="M6 8h5M6 11h3"/>',
  'pacmon.openManifest': '<path d="M8 1.6l5.5 3v6.8L8 14.4 2.5 11.4V4.6z"/><path d="M2.6 4.7L8 7.6l5.4-2.9M8 7.6v6.8"/>',
  'pacmon.showCoverage': '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.3 3.3"/>',
  'pacmon.normalizeNotesFile': '<path d="M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7"/>',
  'pacmon.setupAiInstructions': '<path d="M8 2l1.4 3.6L13 7l-3.6 1.4L8 12l-1.4-3.6L3 7l3.6-1.4z"/><path d="M12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
  'pacmon.depos.signIn': '<path d="M9.5 2.5h3v11h-3"/><path d="M2.5 8h7M7 5.5L9.5 8 7 10.5"/>',
  'pacmon.depos.showConnection': '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5M8 2.5C6.4 4.1 5.7 5.9 5.7 8s.7 3.9 2.3 5.5"/>',
  'pacmon.depos.signOut': '<path d="M6.5 2.5h-3v11h3"/><path d="M6.5 8h7M11 5.5L13.5 8 11 10.5"/>',
};

function actionButton(command: string, label: string, help: string, nameId?: string): string {
  const id = nameId ? ` id="${esc(nameId)}"` : '';
  return `<button type="button" class="act" data-command="${esc(command)}">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ACTION_ICONS[command] ?? ''}</svg>
        <span class="act-body"><span class="act-name"${id}>${esc(label)}</span><span class="act-help">${esc(help)}</span></span>
      </button>`;
}

/** The whole settings view. Static markup; values arrive by postMessage. */
export function renderHtml(): string {
  const n = nonce();
  const { noteEntry: entries, decorations: markers, inlineSource: sources } = CHOICE_VALUES;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<title>${esc(S.viewTitle)}</title>
<style nonce="${n}">
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 4px 0 18px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }
  section { padding: 0 14px; }
  section + section { margin-top: 20px; }
  h2 {
    margin: 0 0 4px; font-size: 13.5px; font-weight: 600;
    letter-spacing: .045em; text-transform: uppercase;
    color: var(--vscode-foreground);
  }
  h2 .count {
    float: right; font-size: 11px; font-weight: 400; letter-spacing: 0;
    text-transform: none; color: var(--vscode-descriptionForeground);
    line-height: 1.5;
  }
  .other { margin-top: 8px; }
  .lede { margin: 0 0 10px; font-size: .92em; color: var(--vscode-descriptionForeground); line-height: 1.45; }

  .row { display: flex; gap: 10px; padding: 9px 0; }
  .row + .row { border-top: 1px solid var(--vscode-widget-border, rgba(128,128,128,.22)); }
  .body { min-width: 0; display: flex; flex-direction: column; gap: 5px; flex: 1; }
  .head { display: flex; align-items: baseline; gap: 8px; }
  .name { font-weight: 600; cursor: pointer; }
  .gesture {
    margin-left: auto; flex: none; font-size: 10.5px;
    padding: 1px 6px; border-radius: 9px; white-space: nowrap;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .help { margin: 0; font-size: .88em; line-height: 1.45; color: var(--vscode-descriptionForeground); }

  .pv {
    display: block; overflow-x: auto; white-space: pre;
    font-family: var(--vscode-editor-font-family); font-size: 11.5px; line-height: 1.7;
    padding: 5px 8px; border-radius: 3px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-widget-border, rgba(128,128,128,.22));
  }
  .pv .k { color: var(--vscode-symbolIcon-propertyForeground, var(--vscode-foreground)); }
  .pv .p { color: var(--vscode-descriptionForeground); }
  .pv .lnk { text-decoration: underline; color: var(--vscode-textLink-foreground); }
  .pv .mark { width: 10px; height: 10px; margin-right: .35em; fill: #00662f; }
  body.vscode-dark .pv .mark { fill: #00ff66; }
  body.vscode-high-contrast:not(.vscode-high-contrast-light) .pv .mark { fill: #00ff66; }
  .pv .lens { color: var(--vscode-textLink-foreground); font-size: 10.5px; }
  .pv .chip {
    color: var(--vscode-editorInlayHint-foreground, var(--vscode-descriptionForeground));
    background: var(--vscode-editorInlayHint-background, rgba(128,128,128,.18));
    border-radius: 3px; padding: 0 4px;
  }
  .pv .bulb { font-size: 10px; }

  /* switch */
  .sw { flex: none; position: relative; width: 30px; height: 18px; cursor: pointer; }
  .sw input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .track {
    display: block; width: 30px; height: 18px; border-radius: 9px;
    background: var(--vscode-checkbox-background);
    border: 1px solid var(--vscode-checkbox-border, var(--vscode-contrastBorder, rgba(128,128,128,.5)));
    transition: background .12s ease;
  }
  .knob {
    display: block; width: 12px; height: 12px; border-radius: 50%; margin: 2px;
    background: var(--vscode-checkbox-foreground, var(--vscode-foreground));
    transition: transform .12s ease;
  }
  .sw input:checked + .track { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  .sw input:checked + .track .knob { transform: translateX(12px); background: var(--vscode-button-foreground); }
  .sw input:focus-visible + .track { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

  /* radios */
  .opt { display: flex; gap: 9px; align-items: flex-start; padding: 6px 0; cursor: pointer; }
  .opt input { position: absolute; opacity: 0; width: 0; height: 0; }
  .dot {
    flex: none; width: 13px; height: 13px; margin-top: 2px; border-radius: 50%;
    border: 1px solid var(--vscode-checkbox-border, rgba(128,128,128,.6));
    background: var(--vscode-checkbox-background);
  }
  .opt input:checked + .dot {
    border-color: var(--vscode-button-background);
    background: radial-gradient(circle, var(--vscode-button-background) 0 45%, transparent 46%);
  }
  .opt input:focus-visible + .dot { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .opt-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .opt-name { font-family: var(--vscode-editor-font-family); font-size: .92em; }
  .opt-help { font-size: .86em; color: var(--vscode-descriptionForeground); line-height: 1.4; }

  .bar {
    height: 4px; border-radius: 2px; margin: 2px 0 4px; overflow: hidden;
    background: var(--vscode-widget-border, rgba(128,128,128,.25));
  }
  .bar span { display: block; height: 100%; width: 0; background: var(--vscode-button-background); }
  .status { margin: 6px 0 0; }
  .actions { display: flex; flex-direction: column; }
  .act {
    display: flex; align-items: flex-start; gap: 10px; width: 100%;
    font-family: inherit; font-size: 1em; text-align: left;
    padding: 8px 8px; margin: 0 -8px; border: 0; border-radius: 4px;
    background: none; color: var(--vscode-foreground); cursor: pointer;
  }
  .act:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.14)); }
  .act:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .act svg { flex: none; width: 16px; height: 16px; margin-top: 1px; color: var(--vscode-textLink-foreground); }
  .act .act-body { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .act .act-name { font-weight: 500; }
  .act .act-help { font-size: .86em; line-height: 1.4; color: var(--vscode-descriptionForeground); }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
  <section id="web">
    <h2>${esc(S.viewGroupWeb)}</h2>
    <p class="lede" id="webText"></p>
    <div class="actions" id="webSignedOut" hidden>
      ${actionButton('pacmon.depos.signIn', S.viewWebSignIn, S.viewWebSignInHelp)}
    </div>
    <div class="actions" id="webSignedIn" hidden>
      ${actionButton('pacmon.depos.showConnection', S.viewWebShow, S.viewWebShowHelp)}
      ${actionButton('pacmon.depos.signOut', S.viewWebSignOut, S.viewWebSignOutHelp)}
    </div>
  </section>

  <section id="coverage">
    <h2>${esc(S.viewGroupCoverage)}<span class="count" id="ratio"></span></h2>
    <p class="lede" id="pkgLabel"></p>
    <div class="bar" id="bar" hidden><span id="barFill"></span></div>
    <p class="lede status" id="covStatus"></p>
  </section>

  <section>
    <h2>${esc(S.viewGroupTargets)}<span class="count" id="count"></span></h2>
    <p class="lede">${esc(S.viewTargetsLede)}</p>
    ${ALL_NOTE_BUTTONS.map(toggleRow).join('\n    ')}
  </section>

  <section>
    <h2>${esc(S.viewNoteEntry)}</h2>
    <p class="lede">${esc(S.viewNoteEntryHelp)}</p>
    ${entries.map((v) => radioRow('noteEntry', v, v)).join('\n    ')}
    <p class="lede other" id="otherEntry" hidden></p>
  </section>

  <section>
    <h2>${esc(S.viewMarkers)}</h2>
    <p class="lede" id="markersLede"></p>
    ${markers.map((v) => radioRow('decorations', v, v)).join('\n    ')}
  </section>

  <section>
    <h2>${esc(S.viewInlineSource)}</h2>
    <p class="lede">${esc(S.viewInlineSourceHelp)}</p>
    ${sources.map((v) => radioRow('inlineSource', v, v)).join('\n    ')}
  </section>

  <section>
    <h2>${esc(S.viewGroupActions)}</h2>
    <div class="actions">
      ${actionButton('pacmon.openNotesFile', S.viewOpenNotes(NOTES_REL_PATH), S.viewOpenNotesHelp, 'openNotesLabel')}
      ${actionButton('pacmon.openManifest', S.viewOpenPackage, S.viewOpenPackageHelp)}
      ${actionButton('pacmon.showCoverage', S.viewSearch, S.viewSearchHelp)}
      ${actionButton('pacmon.normalizeNotesFile', S.viewFormat, S.viewFormatHelp)}
      ${actionButton('pacmon.setupAiInstructions', S.viewAiSetup, S.viewAiSetupHelp)}
    </div>
  </section>

<script nonce="${n}">
(function () {
  const vscode = acquireVsCodeApi();
  const toggles = Array.from(document.querySelectorAll('input[data-button]'));
  const radios = Array.from(document.querySelectorAll('input[data-choice]'));

  function pushButtons() {
    vscode.postMessage({
      type: 'setButtons',
      value: toggles.filter((t) => t.checked).map((t) => t.dataset.button),
    });
  }

  toggles.forEach((t) => t.addEventListener('change', pushButtons));
  radios.forEach((r) =>
    r.addEventListener('change', () => {
      if (r.checked) vscode.postMessage({ type: 'setChoice', key: r.dataset.choice, value: r.value });
    }),
  );
  document.querySelectorAll('button[data-command]').forEach((b) =>
    b.addEventListener('click', () => vscode.postMessage({ type: 'command', id: b.dataset.command })),
  );

  function renderCoverage(c) {
    document.getElementById('ratio').textContent = c.ratio;
    document.getElementById('pkgLabel').textContent = c.pkgLabel;
    document.getElementById('barFill').style.width = c.percent + '%';
    document.getElementById('bar').hidden = !c.ratio;
    document.getElementById('covStatus').textContent = c.status;
  }

  window.addEventListener('message', (event) => {
    const m = event.data;
    if (m.type !== 'state') return;
    renderCoverage(m.coverage);
    document.getElementById('webText').textContent = m.web.text;
    document.getElementById('webSignedOut').hidden = m.web.signedIn;
    document.getElementById('webSignedIn').hidden = !m.web.signedIn;
    document.getElementById('openNotesLabel').textContent = m.openNotesLabel;
    const on = new Set(m.noteButtons);
    toggles.forEach((t) => { t.checked = on.has(t.dataset.button); });
    radios.forEach((r) => { r.checked = m[r.dataset.choice] === r.value; });
    document.getElementById('count').textContent = m.count;
    document.getElementById('markersLede').textContent = m.markersLede;
    const other = document.getElementById('otherEntry');
    const known = radios.some((r) => r.dataset.choice === 'noteEntry' && r.value === m.noteEntry);
    other.hidden = known;
    other.textContent = known ? '' : m.otherEntry;
  });

  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}
