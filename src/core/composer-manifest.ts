import { parseTree, type Node as JsonNode } from 'jsonc-parser';
import { dependencyEntry } from './dependency';
import type { DependencyEntry, SourceRange } from './model';

const DEPENDENCY_SECTIONS = ['require', 'require-dev'] as const;
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const PLATFORM_PACKAGE = /^(?:php(?:-[A-Za-z0-9_.-]+)?|hhvm|ext-[A-Za-z0-9_.-]+|lib-[A-Za-z0-9_.-]+|composer(?:-(?:plugin|runtime)-api)?)$/i;

function property(node: JsonNode, name: string): JsonNode | undefined {
  if (node.type !== 'object') return undefined;
  for (const child of node.children ?? []) {
    if (child.type !== 'property') continue;
    const key = child.children?.[0];
    if (key?.value === name) return child.children?.[1];
  }
  return undefined;
}

function stringContentRange(node: JsonNode): SourceRange {
  return node.type === 'string' && node.length >= 2
    ? { offset: node.offset + 1, length: node.length - 2 }
    : { offset: node.offset, length: node.length };
}

function isDependencyName(value: string): boolean {
  return PACKAGE_NAME.test(value) || PLATFORM_PACKAGE.test(value);
}

function dependenciesFrom(node: JsonNode | undefined, scope: string): DependencyEntry[] {
  if (node?.type !== 'object') return [];
  const out: DependencyEntry[] = [];
  for (const child of node.children ?? []) {
    if (child.type !== 'property') continue;
    const key = child.children?.[0];
    const value = child.children?.[1];
    if (key?.type !== 'string' || typeof key.value !== 'string' || value?.type !== 'string') continue;
    if (!isDependencyName(key.value)) continue;
    const range = stringContentRange(key);
    const entry = dependencyEntry(
      key.value.toLowerCase(),
      scope,
      range,
      [range],
      key.value,
      { offset: key.offset, length: 1 },
    );
    // The constraint as written (`^3.0`, `dev-main`): a branch is no release, and no pin reads it as one.
    const versionSpec = typeof value.value === 'string' ? value.value.trim() : '';
    out.push(versionSpec ? { ...entry, versionSpec } : entry);
  }
  return out;
}

/**
 * The one release an exact constraint names, or undefined. Composer reads a bare
 * version (`1.2.3`, `v1.2.3`) as that version exactly, as it does `=` and `==`.
 * A range, a wildcard, a branch (`dev-main`) or a stability flag (`@dev`) can name
 * more than one.
 */
export function composerPinnedVersion(versionSpec: string | undefined): string | undefined {
  return /^(?:==?\s*)?(v?\d+(?:\.\d+){1,3}(?:-(?:alpha|beta|RC|rc|patch|pl|p)\.?\d*)?)$/.exec(versionSpec?.trim() ?? '')?.[1];
}

/** Reads direct Composer requirements without invoking PHP or Composer. */
export function extractComposerDependencies(text: string): DependencyEntry[] {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (!root || root.type !== 'object') return [];
  return DEPENDENCY_SECTIONS.flatMap((section) => dependenciesFrom(property(root, section), section));
}
