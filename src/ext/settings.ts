import * as vscode from 'vscode';

/**
 * Settings are under `depos.` since Pacmon became Depos. The `pacmon.` names
 * are still read and never written: nothing is copied, so a team's committed
 * .vscode/settings.json stays as it is, and a teammate still on Pacmon who
 * changes `pacmon.x` is still heard.
 */
export const SETTINGS_SECTION = 'depos';
export const LEGACY_SETTINGS_SECTION = 'pacmon';

/** Old names that differ by more than the section. */
const LEGACY_KEYS: Readonly<Record<string, string>> = { url: 'depos.url' };

function legacyKey(key: string): string {
  return LEGACY_KEYS[key] ?? key;
}

const LEVELS = ['workspaceFolderValue', 'workspaceValue', 'globalValue'] as const;

export interface SettingInspection<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

/** Both names of a setting, level by level: at each level the `depos.` value wins. */
export function inspectSetting<T>(key: string, scope?: vscode.ConfigurationScope): SettingInspection<T> {
  const current = vscode.workspace.getConfiguration(SETTINGS_SECTION, scope).inspect<T>(key);
  const legacy = vscode.workspace.getConfiguration(LEGACY_SETTINGS_SECTION, scope).inspect<T>(legacyKey(key));
  const merged: SettingInspection<T> = { defaultValue: current?.defaultValue };
  for (const level of LEVELS) merged[level] = current?.[level] ?? legacy?.[level];
  return merged;
}

/** The value in effect: the most specific level that sets either name. */
export function setting<T>(key: string, fallback: T, scope?: vscode.ConfigurationScope): T {
  const inspected = inspectSetting<T>(key, scope);
  for (const level of LEVELS) {
    const value = inspected[level];
    if (value !== undefined) return value;
  }
  return inspected.defaultValue ?? fallback;
}

/** Writes the `depos.` name only; at the same level it outranks the old one. */
export function updateSetting(key: string, value: unknown, target: vscode.ConfigurationTarget): Thenable<void> {
  return vscode.workspace.getConfiguration(SETTINGS_SECTION).update(key, value, target);
}

/** Clears a setting under both names at one level. */
export async function clearSetting(key: string, target: vscode.ConfigurationTarget): Promise<void> {
  await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(key, undefined, target);
  await vscode.workspace.getConfiguration(LEGACY_SETTINGS_SECTION).update(legacyKey(key), undefined, target);
}

/** Whether a change touches the setting under either name — any of ours without a key. */
export function affectsSetting(e: vscode.ConfigurationChangeEvent, key?: string): boolean {
  if (key === undefined) {
    return e.affectsConfiguration(SETTINGS_SECTION) || e.affectsConfiguration(LEGACY_SETTINGS_SECTION);
  }
  return e.affectsConfiguration(`${SETTINGS_SECTION}.${key}`)
    || e.affectsConfiguration(`${LEGACY_SETTINGS_SECTION}.${legacyKey(key)}`);
}
