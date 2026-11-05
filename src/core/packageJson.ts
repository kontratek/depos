import { parseTree } from 'jsonc-parser';
import type { DependencyEntry, DepEntry } from './model';
import { dependencyAtOffset, dependencyEntry } from './dependency';

const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

function isDepSection(v: unknown): v is (typeof DEP_SECTIONS)[number] {
  return typeof v === 'string' && (DEP_SECTIONS as readonly string[]).includes(v);
}

/** Extract dependency names + key positions from a package.json text (jsonc tolerant). */
export function extractNpmDependencies(text: string): DependencyEntry[] {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (!root || root.type !== 'object') return [];
  const out: DependencyEntry[] = [];
  for (const prop of root.children ?? []) {
    if (prop.type !== 'property') continue;
    const keyNode = prop.children?.[0];
    const valNode = prop.children?.[1];
    if (!keyNode || !isDepSection(keyNode.value)) continue;
    if (!valNode || valNode.type !== 'object') continue;
    const section = keyNode.value;
    for (const entry of valNode.children ?? []) {
      const k = entry.children?.[0];
      if (k && typeof k.value === 'string') {
        const dependency = dependencyEntry(k.value, section, { offset: k.offset, length: k.length });
        const spec = entry.children?.[1]?.value;
        out.push(typeof spec === 'string' ? { ...dependency, versionSpec: spec } : dependency);
      }
    }
  }
  return out;
}

/** Backward-compatible name used by the original npm-only core tests. */
export const extractDeps = extractNpmDependencies;

/** The dependency whose key range contains the given offset (quotes included). */
export function depAtOffset(deps: readonly DepEntry[], offset: number): DepEntry | undefined {
  return dependencyAtOffset(deps, offset);
}
