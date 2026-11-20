import { dependencyEntry } from './dependency';
import type { DependencyEntry } from './model';
import { parseXml, xmlChild, xmlTextValue, type XmlNode } from './xml';

/** Rounds of `${…}` substitution: a property may name another, but a loop must end. */
const MAX_PROPERTY_ROUNDS = 10;

/** What the pom itself says about versions: its `<properties>` and its `<dependencyManagement>`. */
interface PomVersions {
  properties: ReadonlyMap<string, string>;
  /** `groupId:artifactId` → the version `<dependencyManagement>` gives it, as written. */
  managed: ReadonlyMap<string, string>;
}

function propertiesOf(text: string, project: XmlNode): Map<string, string> {
  const properties = new Map<string, string>();
  for (const node of xmlChild(project, 'properties')?.children ?? []) {
    const value = xmlTextValue(text, node)?.value;
    if (value !== undefined) properties.set(node.name, value);
  }
  return properties;
}

/**
 * Fills in `${name}` from the pom's own `<properties>`. A property defined anywhere
 * else (a parent pom, the command line, `project.version`) stays as written, so no
 * pin reads it: a sibling module at `${project.version}` is not a registry release.
 */
function interpolate(value: string, properties: ReadonlyMap<string, string>): string {
  let current = value;
  for (let round = 0; round < MAX_PROPERTY_ROUNDS && current.includes('${'); round++) {
    const next = current.replace(/\$\{([^}]+)\}/g, (match, name: string) => properties.get(name.trim()) ?? match);
    if (next === current) break;
    current = next;
  }
  return current;
}

function coordinateOf(text: string, dependency: XmlNode): { group: string; artifact: string } | undefined {
  const group = xmlTextValue(text, xmlChild(dependency, 'groupId'))?.value;
  const artifact = xmlTextValue(text, xmlChild(dependency, 'artifactId'))?.value;
  return group && artifact ? { group, artifact } : undefined;
}

function managedVersionsOf(text: string, project: XmlNode): Map<string, string> {
  const managed = new Map<string, string>();
  const management = xmlChild(project, 'dependencyManagement');
  const dependencies = management ? xmlChild(management, 'dependencies') : undefined;
  for (const dependency of dependencies?.children.filter((node) => node.name === 'dependency') ?? []) {
    const coordinate = coordinateOf(text, dependency);
    const version = xmlTextValue(text, xmlChild(dependency, 'version'))?.value;
    if (coordinate && version) managed.set(`${coordinate.group}:${coordinate.artifact}`, version);
  }
  return managed;
}

/**
 * The version as the pom gives it: the dependency's own `<version>`, else the one its
 * `<dependencyManagement>` names, with the pom's own properties filled in. A parent
 * pom or an imported BOM is not read, so a version that only they give is unknown.
 * A `system` dependency is a jar on disk: `file:<systemPath>`.
 */
function versionSpecOf(text: string, dependency: XmlNode, noteKey: string, pom: PomVersions): string | undefined {
  if (xmlTextValue(text, xmlChild(dependency, 'scope'))?.value === 'system') {
    const path = xmlTextValue(text, xmlChild(dependency, 'systemPath'))?.value;
    return `file:${path ? interpolate(path, pom.properties) : ''}`;
  }
  const written = xmlTextValue(text, xmlChild(dependency, 'version'))?.value ?? pom.managed.get(noteKey);
  return written ? interpolate(written, pom.properties) : undefined;
}

function dependenciesFrom(
  text: string,
  dependencies: XmlNode | undefined,
  pom: PomVersions,
  scopePrefix?: string,
): DependencyEntry[] {
  if (!dependencies) return [];
  const out: DependencyEntry[] = [];
  for (const dependency of dependencies.children.filter((node) => node.name === 'dependency')) {
    const group = xmlTextValue(text, xmlChild(dependency, 'groupId'));
    const artifact = xmlTextValue(text, xmlChild(dependency, 'artifactId'));
    if (!group || !artifact) continue;
    const declaredScope = xmlTextValue(text, xmlChild(dependency, 'scope'))?.value ?? 'compile';
    const scope = scopePrefix ? `${scopePrefix}/${declaredScope}` : declaredScope;
    const noteKey = `${group.value}:${artifact.value}`;
    const iconRange = { offset: dependency.openStart, length: 1 };
    const entry = dependencyEntry(noteKey, scope, artifact.range, [group.range, artifact.range], noteKey, iconRange);
    const versionSpec = versionSpecOf(text, dependency, noteKey, pom);
    out.push(versionSpec ? { ...entry, versionSpec } : entry);
  }
  return out;
}

/** Extracts direct Maven dependencies without resolving parents or invoking Maven. */
export function extractMavenDependencies(text: string): DependencyEntry[] {
  const project = parseXml(text).find((node) => node.name === 'project');
  if (!project) return [];
  const pom: PomVersions = { properties: propertiesOf(text, project), managed: managedVersionsOf(text, project) };
  const out = dependenciesFrom(text, xmlChild(project, 'dependencies'), pom);
  const profiles = xmlChild(project, 'profiles');
  for (const profile of profiles?.children.filter((node) => node.name === 'profile') ?? []) {
    const id = xmlTextValue(text, xmlChild(profile, 'id'))?.value ?? 'unnamed';
    out.push(...dependenciesFrom(text, xmlChild(profile, 'dependencies'), pom, `profile:${id}`));
  }
  return out;
}

/**
 * The one release a version names, or undefined. Maven has no lock file and needs
 * none for a direct dependency: the nearest declaration wins, and nothing is nearer
 * than the project's own, so a plain `2.17.0` is the version the build uses (a
 * parent's `<dependencyManagement>` does not override it). `[2.17.0]` is that version
 * too. A range, a property that was not filled in, a `-SNAPSHOT` (a build that
 * changes, not a release) and the old `LATEST` / `RELEASE` name more than one.
 */
export function mavenPinnedVersion(versionSpec: string | undefined): string | undefined {
  const match = /^(?:\[\s*([0-9A-Za-z][\w.+-]*)\s*\]|([0-9A-Za-z][\w.+-]*))$/.exec(versionSpec?.trim() ?? '');
  const version = match?.[1] ?? match?.[2];
  if (!version || /SNAPSHOT$/i.test(version) || /^(?:LATEST|RELEASE)$/.test(version)) return undefined;
  return version;
}
