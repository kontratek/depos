import { INLINE_SOURCES } from '../core/layers';

/**
 * The values the Depos view may write for each radio group. Shared by the
 * markup (which radios to draw) and the host (what to accept off the wire):
 * the webview is not trusted to pick setting values on its own.
 */
export const CHOICE_VALUES = {
  // Only the two first-class editors. Other values still work if set in
  // settings.json; the view says so rather than showing nothing selected.
  noteEntry: ['panel', 'peek'],
  decorations: ['preview', 'badge', 'off'],
  inlineSource: INLINE_SOURCES,
} as const satisfies Record<string, readonly string[]>;

export function choiceValues(key: string): readonly string[] | undefined {
  return (CHOICE_VALUES as Record<string, readonly string[]>)[key];
}

/**
 * Which settings target a write from the view must land in. The view renders
 * the EFFECTIVE value of a setting, so it has to update the target that already
 * defines it: a workspace value outranks a user one, and writing the user value
 * underneath changes nothing the view can show — the control just snaps back,
 * with nothing on screen to explain why. Not an exotic case: "Toggle Note
 * Markers" writes a workspace value, and a repository may ship any of these in
 * its own `.vscode/settings.json`.
 *
 * Folder values are not considered. Every Depos setting is `window`-scoped —
 * what VS Code gives a property that declares no scope — and a window-scoped
 * setting cannot be set per folder.
 */
export function writeScope(
  inspected: { workspaceValue?: unknown } | undefined,
): 'workspace' | 'global' {
  return inspected?.workspaceValue === undefined ? 'global' : 'workspace';
}
