import { dependencyEntry } from './dependency';
import type { DependencyEntry } from './model';
import { parseXml, xmlAttribute, xmlChild, xmlTextValue, type XmlNode } from './xml';

const PROJECT_EXTENSIONS = ['.csproj', '.fsproj', '.vbproj'] as const;
const NUGET_PACKAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').at(-1) ?? '';
}

export function isNugetManifestPath(path: string): boolean {
  const name = basename(path);
  const lower = name.toLowerCase();
  return name === 'Directory.Packages.props'
    || PROJECT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function descendants(nodes: readonly XmlNode[]): XmlNode[] {
  const result: XmlNode[] = [];
  const visit = (node: XmlNode): void => {
    result.push(node);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return result;
}

/**
 * The version as the declaration writes it: `VersionOverride` (a project's own
 * version under central package management) before `Version`, as an attribute or
 * a child element. A `PackageReference` under central management names none; its
 * version is the `PackageVersion` in `Directory.Packages.props`. An MSBuild property
 * (`$(JsonVersion)`) is kept as written: it is not evaluated, so no pin reads it.
 */
function versionSpecOf(text: string, node: XmlNode): string | undefined {
  for (const name of ['VersionOverride', 'Version']) {
    const value = xmlAttribute(node, name)?.value ?? xmlTextValue(text, xmlChild(node, name))?.value;
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function entry(text: string, node: XmlNode, attributeName: 'Include' | 'Update', scope: string): DependencyEntry | undefined {
  if (xmlAttribute(node, 'Remove')) return undefined;
  const attribute = xmlAttribute(node, attributeName);
  if (!attribute || !NUGET_PACKAGE_ID.test(attribute.value)) return undefined;
  const iconRange = { offset: node.openStart, length: 1 };
  const dependency = dependencyEntry(
    attribute.value,
    scope,
    attribute.range,
    [attribute.range],
    attribute.value,
    iconRange,
  );
  const versionSpec = versionSpecOf(text, node);
  return versionSpec ? { ...dependency, versionSpec } : dependency;
}

/** Reads literal NuGet declarations without evaluating MSBuild or following imports. */
export function extractNugetDependencies(text: string, path = 'project.csproj'): DependencyEntry[] {
  const nodes = descendants(parseXml(text));
  if (basename(path) === 'Directory.Packages.props') {
    return nodes.flatMap((node) => {
      if (node.name === 'PackageVersion') {
        const attributeName = xmlAttribute(node, 'Include') ? 'Include' : 'Update';
        const dependency = entry(text, node, attributeName, 'centralVersion');
        return dependency ? [dependency] : [];
      }
      if (node.name === 'GlobalPackageReference') {
        const dependency = entry(text, node, 'Include', 'globalPackageReference');
        return dependency ? [dependency] : [];
      }
      return [];
    });
  }

  return nodes.flatMap((node) => {
    if (node.name !== 'PackageReference' || !xmlAttribute(node, 'Include')) return [];
    const dependency = entry(text, node, 'Include', 'packageReference');
    return dependency ? [dependency] : [];
  });
}

/**
 * The one release a version names, or undefined. NuGet reads a bare version
 * (`13.0.3`) as "13.0.3 or higher" but restores the lowest release that matches,
 * so it installs 13.0.3 whenever 13.0.3 is published; `[13.0.3]` is that version
 * exactly. A range (`[1.0,2.0)`), a floating version (`13.*`) or an MSBuild
 * property can name more than one.
 *
 * The release is named as nuget.org and lock files write it (NuGet's normalized
 * form): three parts at least, a fourth only when it is not 0, no leading zeros
 * and no build metadata. So `13.0` is `13.0.0`.
 */
export function nugetPinnedVersion(versionSpec: string | undefined): string | undefined {
  const match = /^(?:\[\s*(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?)\s*\]|(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.-]+)?))$/.exec(versionSpec?.trim() ?? '');
  const version = match?.[1] ?? match?.[2];
  if (!version) return undefined;
  const dash = version.indexOf('-');
  const numbers = (dash < 0 ? version : version.slice(0, dash)).split('.').map(Number);
  while (numbers.length < 3) numbers.push(0);
  if (numbers.length === 4 && numbers[3] === 0) numbers.pop();
  return numbers.join('.') + (dash < 0 ? '' : version.slice(dash));
}

/** Coverage uses one row per case-insensitive NuGet package ID; callers pass
 * central manifests first so their declaration represents duplicates. */
export function uniqueNugetDependencies(dependencies: readonly DependencyEntry[]): DependencyEntry[] {
  const unique = new Map<string, DependencyEntry>();
  for (const dependency of dependencies) {
    const key = dependency.noteKey.trim().toLowerCase();
    if (!unique.has(key)) unique.set(key, dependency);
  }
  return [...unique.values()];
}
