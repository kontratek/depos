import { parseTree, type Node as JsonNode } from 'jsonc-parser';
import { dependencyEntry } from './dependency';
import type { DependencyEntry, SourceRange } from './model';

const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const BASELINE_RE = /^[0-9a-f]{40}$/;
/** The key of a baseline in the registry's files a caller fetches: `vcpkg-baseline:<commit>`. */
export const VCPKG_BASELINE_PREFIX = 'vcpkg-baseline:';
/** A version vcpkg can name: no spaces, no `>=`. */
const VERSION_RE = /^[0-9A-Za-z][\w.+~-]*(?:#\d+)?$/;
/** The fields an override or a port writes its version in, by scheme. */
const VERSION_FIELDS = ['version', 'version-semver', 'version-date', 'version-string'];

function property(node: JsonNode | undefined, name: string): JsonNode | undefined {
  if (node?.type !== 'object') return undefined;
  for (const child of node.children ?? []) {
    if (child.type !== 'property') continue;
    const key = child.children?.[0];
    if (key?.value === name) return child.children?.[1];
  }
  return undefined;
}

function stringValue(node: JsonNode | undefined): string | undefined {
  return node?.type === 'string' && typeof node.value === 'string' ? node.value.trim() || undefined : undefined;
}

function stringContentRange(node: JsonNode): SourceRange {
  return node.type === 'string' && node.length >= 2
    ? { offset: node.offset + 1, length: node.length - 2 }
    : { offset: node.offset, length: node.length };
}

/** `1.2.3`, with `#2` when the port itself changed: vcpkg's own notation. */
function withPortVersion(version: string, portVersion: unknown): string {
  return typeof portVersion === 'number' && Number.isInteger(portVersion) && portVersion > 0 && !version.includes('#')
    ? `${version}#${portVersion}`
    : version;
}

function versionOf(node: JsonNode | undefined): string | undefined {
  for (const field of VERSION_FIELDS) {
    const version = stringValue(property(node, field));
    if (version) return withPortVersion(version, property(node, 'port-version')?.value);
  }
  return undefined;
}

/** `overrides`: the version a port is held to, whatever the baseline says. */
function overridesOf(root: JsonNode): Map<string, string> {
  const overrides = new Map<string, string>();
  const list = property(root, 'overrides');
  for (const item of list?.type === 'array' ? list.children ?? [] : []) {
    const name = stringValue(property(item, 'name'));
    const version = versionOf(item);
    if (name && version && VERSION_RE.test(version)) overrides.set(name.toLowerCase(), version);
  }
  return overrides;
}

function dependencyFrom(node: JsonNode, scope: string, overrides: ReadonlyMap<string, string>): DependencyEntry | undefined {
  let nameNode: JsonNode | undefined;
  let host = false;
  let minimum: string | undefined;
  if (node.type === 'string') nameNode = node;
  else if (node.type === 'object') {
    nameNode = property(node, 'name');
    host = property(node, 'host')?.value === true;
    minimum = stringValue(property(node, 'version>='));
  }
  if (nameNode?.type !== 'string' || typeof nameNode.value !== 'string' || !PACKAGE_NAME.test(nameNode.value)) {
    return undefined;
  }
  const range = stringContentRange(nameNode);
  const iconRange = { offset: node.offset, length: 1 };
  const displayName = nameNode.value;
  const entry = dependencyEntry(
    displayName.toLowerCase(),
    host ? `${scope}:host` : scope,
    range,
    [range],
    displayName,
    iconRange,
  );
  const override = overrides.get(entry.noteKey);
  const versionSpec = override ?? (minimum && VERSION_RE.test(minimum) ? `>=${minimum}` : undefined);
  return versionSpec ? { ...entry, versionSpec } : entry;
}

function dependenciesFrom(node: JsonNode | undefined, scope: string, overrides: ReadonlyMap<string, string>): DependencyEntry[] {
  if (node?.type !== 'array') return [];
  return (node.children ?? []).flatMap((child) => {
    const dependency = dependencyFrom(child, scope, overrides);
    return dependency ? [dependency] : [];
  });
}

function rootOf(text: string): JsonNode | undefined {
  const root = parseTree(text, [], { allowTrailingComma: true });
  return root?.type === 'object' ? root : undefined;
}

/**
 * Reads direct dependency declarations from vcpkg.json without invoking vcpkg. A
 * dependency's version is its override (`overrides`, exact), else its minimum
 * (`"version>=": "1.2"`, written `>=1.2`), else none: the baseline decides it.
 */
export function extractVcpkgDependencies(text: string): DependencyEntry[] {
  const root = rootOf(text);
  if (!root) return [];
  const overrides = overridesOf(root);
  const out = dependenciesFrom(property(root, 'dependencies'), 'dependencies', overrides);
  const features = property(root, 'features');
  if (features?.type !== 'object') return out;
  for (const featureProperty of features.children ?? []) {
    if (featureProperty.type !== 'property') continue;
    const key = featureProperty.children?.[0];
    const feature = featureProperty.children?.[1];
    if (key?.type !== 'string' || typeof key.value !== 'string' || feature?.type !== 'object') continue;
    out.push(...dependenciesFrom(property(feature, 'dependencies'), `feature:${key.value}`, overrides));
  }
  return out;
}

/**
 * The commit of microsoft/vcpkg whose `versions/baseline.json` gives the ports their
 * versions, as `vcpkg-baseline:<commit>`: `builtin-baseline`, else the baseline of an
 * embedded `vcpkg-configuration` whose default registry is vcpkg's own. None in
 * classic mode, where the local vcpkg checkout decides; a separate
 * vcpkg-configuration.json is not read.
 */
export function vcpkgBaselineKey(text: string): string | undefined {
  const root = rootOf(text);
  if (!root) return undefined;
  let commit = stringValue(property(root, 'builtin-baseline'));
  if (!commit) {
    const registry = property(property(root, 'vcpkg-configuration'), 'default-registry');
    const kind = stringValue(property(registry, 'kind'));
    const repository = stringValue(property(registry, 'repository')) ?? '';
    if (kind === 'builtin' || (kind === 'git' && /github\.com[/:]microsoft\/vcpkg(?:\.git)?\/?$/i.test(repository))) {
      commit = stringValue(property(registry, 'baseline'));
    }
  }
  return commit && BASELINE_RE.test(commit) ? `${VCPKG_BASELINE_PREFIX}${commit}` : undefined;
}

function baselineVersionIn(ports: JsonNode | undefined, name: string): string | undefined {
  const entry = property(ports, name.toLowerCase());
  const version = stringValue(property(entry, 'baseline'));
  return version && VERSION_RE.test(version) ? withPortVersion(version, property(entry, 'port-version')?.value) : undefined;
}

/** A port's version in a `versions/baseline.json`, or undefined. */
export function vcpkgBaselineVersion(baseline: string, name: string): string | undefined {
  return baselineVersionIn(property(rootOf(baseline), 'default'), name);
}

/** Numbers by value, words after them: `1.10` after `1.9`, `2024-01-02` after `2023-12-31`. */
function compareVcpkg(a: string, b: string): number {
  const [aVersion = '', aPort = '0'] = a.split('#');
  const [bVersion = '', bPort = '0'] = b.split('#');
  const aParts = aVersion.split(/[.-]/);
  const bParts = bVersion.split(/[.-]/);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const x = aParts[i] ?? '0';
    const y = bParts[i] ?? '0';
    const xNumber = /^\d+$/.test(x);
    const yNumber = /^\d+$/.test(y);
    const order = xNumber && yNumber ? Number(x) - Number(y) : xNumber !== yNumber ? (xNumber ? -1 : 1) : x.localeCompare(y);
    if (order) return order;
  }
  return Number(aPort) - Number(bPort);
}

/**
 * The dependencies with the version vcpkg installs, from the baseline's text: an
 * override, else the baseline's version, raised to a higher minimum. A minimum a
 * transitive dependency asks for is not read. Without the baseline (none, or not
 * fetched), only an override is known.
 */
export function readVcpkgManifest(text: string, baseline: string | null | undefined): DependencyEntry[] {
  const ports = baseline ? property(rootOf(baseline), 'default') : undefined;
  return extractVcpkgDependencies(text).map((entry) => {
    const spec = entry.versionSpec;
    if (spec && !spec.startsWith('>=')) return { ...entry, installedVersion: spec };
    const fromBaseline = baselineVersionIn(ports, entry.noteKey);
    const minimum = spec?.slice(2);
    const installed = fromBaseline && minimum && compareVcpkg(minimum, fromBaseline) > 0 ? minimum : fromBaseline;
    return installed ? { ...entry, installedVersion: installed } : entry;
  });
}

/** An override is the one version vcpkg installs; a minimum is not. */
export function vcpkgPinnedVersion(versionSpec: string | undefined): string | undefined {
  return versionSpec && !versionSpec.startsWith('>=') && VERSION_RE.test(versionSpec) ? versionSpec : undefined;
}
