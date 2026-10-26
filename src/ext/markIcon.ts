import * as vscode from 'vscode';

/**
 * The Depos mark, as the four images the editor draws before a dependency key.
 *
 * THE SHAPE is `media/pacmon-mark.svg`: three bars on an 8x8 grid, each bar
 * 6 wide and 2 tall, 1-unit gaps, the top bar 2 in from the left. Every edge
 * lands on a whole unit, so the mark is pixel-crisp at any multiple of 8 px.
 * At the 12 px it is drawn at, a bar is 3 px and a gap 1.5 px.
 *
 * FILLED means the dependency has a note; HOLLOW means it does not. The state
 * is carried by the shape, not by the colour — the one encoding that survives
 * colour blindness, and what keeps this out of WCAG 1.4.1's way. Colour is the
 * second channel: the two marks are also two stops apart in lightness (2.0:1
 * on Dark+, 2.1:1 on Light+), so they stay apart under full achromatopsia too.
 *
 * FOUR IMAGES because `contentIconPath` bakes the colour in — unlike
 * `contentText`, an image takes no ThemeColor. So each state is drawn twice,
 * and the decoration type's `light`/`dark` blocks pick between them. The light
 * greens are darker than the brand: #00ff66 on white is 1.4:1, unreadable.
 *
 * BASE64 rather than a plain UTF-8 data URI, because the fills are hex colours
 * and a bare `#` would start the URI's fragment and cut the image in half.
 * `btoa` (not `Buffer`) so this also runs in the web extension host; the SVG
 * is ASCII, which is all `btoa` accepts.
 */

/** Rendered size in CSS pixels — the intrinsic size, since `content: url()`
 *  draws an image at its own dimensions. 12 px sits just above the cap height
 *  of the 14 px editor font. */
const SIZE = 12;

const COLORS = {
  documented: { dark: '#00ff66', light: '#00662f' },
  undocumented: { dark: '#9d9d9d', light: '#8c8c8c' },
} as const;

/** The three bars, filled. */
const FILLED =
  '<rect x="2" y="0" width="6" height="2"/>' +
  '<rect x="0" y="3" width="6" height="2"/>' +
  '<rect x="0" y="6" width="6" height="2"/>';

/** The same three bars, hollow. The stroke is centred on the path, so each
 *  rect is inset by half its width to keep the outer edge on the 8x8 grid. */
const HOLLOW =
  '<rect x="2.25" y="0.25" width="5.5" height="1.5"/>' +
  '<rect x="0.25" y="3.25" width="5.5" height="1.5"/>' +
  '<rect x="0.25" y="6.25" width="5.5" height="1.5"/>';

function markUri(bars: string, color: string, hollow: boolean): vscode.Uri {
  const paint = hollow
    ? `fill="none" stroke="${color}" stroke-width="0.5"`
    : `fill="${color}"`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 8 8" ${paint}>` +
    `${bars}</svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${btoa(svg)}`);
}

/**
 * One entry per state, each with the image for either editor theme. Built
 * once at module load: there are exactly two decoration types, whatever the
 * dependency count, so nothing here is per-dependency work.
 */
export const MARK = {
  documented: {
    dark: markUri(FILLED, COLORS.documented.dark, false),
    light: markUri(FILLED, COLORS.documented.light, false),
  },
  undocumented: {
    dark: markUri(HOLLOW, COLORS.undocumented.dark, true),
    light: markUri(HOLLOW, COLORS.undocumented.light, true),
  },
} as const;
