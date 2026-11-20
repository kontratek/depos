import { dependencyEntry } from './dependency';
import type { DependencyEntry, SourceRange } from './model';
import { parseXml, xmlChild, xmlTextValue, type XmlNode } from './xml';

/** Rounds of `${…}` substitution: a property may name another, but a loop must end. */
const MAX_PROPERTY_ROUNDS = 10;

/** Where Maven looks for a parent pom when `<relativePath>` is not written. */
const DEFAULT_PARENT_PATH = '../pom.xml';

/** One `<dependencyManagement>` entry, as written. */
interface ManagedEntry {
  group: string;
  artifact: string;
  version?: string;
  /** `<scope>import</scope>` with `<type>pom</type>`: a BOM whose management is merged in. */
  import: boolean;
}

interface ParentRef {
  group: string;
  artifact: string;
  version?: string;
  /** As written; undefined when not written (Maven's default), '' for `<relativePath/>`. */
  relativePath?: string;
  groupRange: SourceRange;
  artifactRange: SourceRange;
  iconRange: SourceRange;
}

/** What one pom.xml says about itself, as written. */
interface PomModel {
  path: string;
  text: string;
  project: XmlNode;
  /** `groupId:artifactId`, the group inherited from the parent when not written. */
  coordinate?: string;
  parent?: ParentRef;
  properties: Map<string, string>;
  managed: ManagedEntry[];
}

/** A pom with its parents merged in, before interpolation (Maven's inheritance step). */
interface InheritedPom {
  properties: Map<string, string>;
  /** Keyed by the entry as written, so a child's entry replaces its parent's. */
  managed: Map<string, ManagedEntry>;
}

/** What versions a pom's own dependencies get. */
interface PomVersions {
  properties: ReadonlyMap<string, string>;
  /** `groupId:artifactId` → the version `<dependencyManagement>` gives it, filled in. */
  managed: ReadonlyMap<string, string>;
}

function text(source: string, node: XmlNode | undefined, name: string): string | undefined {
  return node ? xmlTextValue(source, xmlChild(node, name))?.value : undefined;
}

function propertiesOf(source: string, project: XmlNode): Map<string, string> {
  const properties = new Map<string, string>();
  for (const node of xmlChild(project, 'properties')?.children ?? []) {
    const value = xmlTextValue(source, node)?.value;
    if (value !== undefined) properties.set(node.name, value);
  }
  return properties;
}

function managedEntriesOf(source: string, project: XmlNode): ManagedEntry[] {
  const management = xmlChild(project, 'dependencyManagement');
  const dependencies = management ? xmlChild(management, 'dependencies') : undefined;
  const entries: ManagedEntry[] = [];
  for (const dependency of dependencies?.children.filter((node) => node.name === 'dependency') ?? []) {
    const group = text(source, dependency, 'groupId');
    const artifact = text(source, dependency, 'artifactId');
    if (!group || !artifact) continue;
    const version = text(source, dependency, 'version');
    const isImport = text(source, dependency, 'scope') === 'import' && text(source, dependency, 'type') === 'pom';
    entries.push({ group, artifact, ...(version ? { version } : {}), import: isImport });
  }
  return entries;
}

function parentOf(source: string, project: XmlNode): ParentRef | undefined {
  const parent = xmlChild(project, 'parent');
  if (!parent) return undefined;
  const group = xmlTextValue(source, xmlChild(parent, 'groupId'));
  const artifact = xmlTextValue(source, xmlChild(parent, 'artifactId'));
  if (!group || !artifact) return undefined;
  const version = text(source, parent, 'version');
  const relativeNode = xmlChild(parent, 'relativePath');
  const relativePath = relativeNode ? xmlTextValue(source, relativeNode)?.value ?? '' : undefined;
  return {
    group: group.value,
    artifact: artifact.value,
    ...(version ? { version } : {}),
    ...(relativePath !== undefined ? { relativePath } : {}),
    groupRange: group.range,
    artifactRange: artifact.range,
    iconRange: { offset: parent.openStart, length: 1 },
  };
}

function readPom(path: string, source: string): PomModel | undefined {
  const project = parseXml(source).find((node) => node.name === 'project');
  if (!project) return undefined;
  const parent = parentOf(source, project);
  const group = text(source, project, 'groupId') ?? parent?.group;
  const artifact = text(source, project, 'artifactId');
  return {
    path,
    text: source,
    project,
    ...(group && artifact ? { coordinate: `${group}:${artifact}` } : {}),
    ...(parent ? { parent } : {}),
    properties: propertiesOf(source, project),
    managed: managedEntriesOf(source, project),
  };
}

/**
 * Fills in `${name}` from the pom's properties, its parents' included. A property
 * defined anywhere else (the command line, `project.version`) stays as written, so
 * no pin reads it: a sibling module at `${project.version}` is not a registry release.
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

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** `a/b` + `../c/pom.xml` → `a/c/pom.xml`; undefined when it leaves the repository. */
function joinPath(directory: string, relative: string): string | undefined {
  const parts = directory ? directory.split('/') : [];
  for (const part of relative.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

/**
 * The poms of one repository, read together: a module inherits its parent's
 * properties and `<dependencyManagement>`, and a BOM it imports adds that BOM's
 * management. Only poms in the repository are read; a parent or a BOM from a
 * registry (`spring-boot-starter-parent`) is not, so a version only it gives is
 * unknown.
 *
 * As Maven does: inheritance first (a child's property or managed entry replaces
 * its parent's), then `${…}` is filled in from the merged properties, so a child can
 * change the version its parent manages. Imports come last: an imported BOM is read
 * with its own properties, and never replaces an entry the pom or its parents
 * manage; of two BOMs, the first imported wins.
 */
export class MavenBuild {
  private readonly models = new Map<string, PomModel | null>();
  private readonly inherited = new Map<string, InheritedPom>();
  private readonly versions = new Map<string, PomVersions>();
  private byCoordinate?: Map<string, string | null>;

  constructor(private readonly poms: ReadonlyMap<string, string>) {}

  private model(path: string): PomModel | undefined {
    if (!this.models.has(path)) {
      const source = this.poms.get(path);
      this.models.set(path, source === undefined ? null : readPom(path, source) ?? null);
    }
    return this.models.get(path) ?? undefined;
  }

  /** The repository's pom for a `groupId:artifactId`, when exactly one has it. */
  private pathOf(coordinate: string): string | undefined {
    if (!this.byCoordinate) {
      this.byCoordinate = new Map();
      for (const path of this.poms.keys()) {
        const own = this.model(path)?.coordinate;
        if (own) this.byCoordinate.set(own, this.byCoordinate.has(own) ? null : path);
      }
    }
    return this.byCoordinate.get(coordinate) ?? undefined;
  }

  /** The parent pom in the repository: at `<relativePath>` (by default `../pom.xml`) when it is that module, else the one module that is. */
  private parentModel(model: PomModel): PomModel | undefined {
    const parent = model.parent;
    if (!parent) return undefined;
    const coordinate = `${parent.group}:${parent.artifact}`;
    const relative = parent.relativePath ?? DEFAULT_PARENT_PATH;
    if (relative) {
      const joined = joinPath(directoryOf(model.path), relative);
      const path = joined === undefined ? undefined : /\.xml$/i.test(joined) ? joined : joined ? `${joined}/pom.xml` : 'pom.xml';
      const candidate = path && path !== model.path ? this.model(path) : undefined;
      if (candidate?.coordinate === coordinate) return candidate;
    }
    const path = this.pathOf(coordinate);
    return path && path !== model.path ? this.model(path) : undefined;
  }

  private inherit(model: PomModel, visiting: Set<string>): InheritedPom {
    const cached = this.inherited.get(model.path);
    if (cached) return cached;
    visiting.add(model.path);
    const parent = this.parentModel(model);
    const base: InheritedPom = parent && !visiting.has(parent.path)
      ? this.inherit(parent, visiting)
      : { properties: new Map(), managed: new Map() };
    visiting.delete(model.path);
    const managed = new Map(base.managed);
    for (const entry of model.managed) managed.set(`${entry.group}:${entry.artifact}:${entry.import ? 'import' : ''}`, entry);
    const merged: InheritedPom = { properties: new Map([...base.properties, ...model.properties]), managed };
    this.inherited.set(model.path, merged);
    return merged;
  }

  private pomVersions(model: PomModel, visiting = new Set<string>()): PomVersions {
    const cached = this.versions.get(model.path);
    if (cached) return cached;
    visiting.add(model.path);
    const inherited = this.inherit(model, new Set());
    const properties = new Map(inherited.properties);
    // Coordinates only: a version stays `${project.version}` (see interpolate).
    const [group, artifact] = model.coordinate?.split(':') ?? [];
    if (group && !properties.has('project.groupId')) properties.set('project.groupId', group);
    if (artifact && !properties.has('project.artifactId')) properties.set('project.artifactId', artifact);
    const managed = new Map<string, string>();
    const imports: ManagedEntry[] = [];
    for (const entry of inherited.managed.values()) {
      if (entry.import) {
        imports.push(entry);
        continue;
      }
      if (entry.version) {
        managed.set(`${interpolate(entry.group, properties)}:${interpolate(entry.artifact, properties)}`, interpolate(entry.version, properties));
      }
    }
    for (const entry of imports) {
      const path = this.pathOf(`${interpolate(entry.group, properties)}:${interpolate(entry.artifact, properties)}`);
      const bom = path ? this.model(path) : undefined;
      if (!bom || visiting.has(bom.path)) continue;
      for (const [key, version] of this.pomVersions(bom, visiting).managed) {
        if (!managed.has(key)) managed.set(key, version);
      }
    }
    visiting.delete(model.path);
    const versions: PomVersions = { properties, managed };
    this.versions.set(model.path, versions);
    return versions;
  }

  /**
   * The pom's direct dependencies with their versions. With `parent`, a parent pom
   * that is not in the repository is one too (scope `parent`): its version decides
   * what everything it manages gets, as `spring-boot-starter-parent` does.
   */
  dependencies(path: string, options: { parent?: boolean } = {}): DependencyEntry[] {
    const model = this.model(path);
    if (!model) return [];
    const versions = this.pomVersions(model);
    const out: DependencyEntry[] = [];
    if (options.parent && model.parent && !this.parentModel(model)) {
      const { group, artifact, version, groupRange, artifactRange, iconRange } = model.parent;
      const noteKey = `${group}:${artifact}`;
      const entry = dependencyEntry(noteKey, 'parent', artifactRange, [groupRange, artifactRange], noteKey, iconRange);
      out.push(version ? { ...entry, versionSpec: version } : entry);
    }
    out.push(...dependenciesFrom(model.text, xmlChild(model.project, 'dependencies'), versions));
    const profiles = xmlChild(model.project, 'profiles');
    for (const profile of profiles?.children.filter((node) => node.name === 'profile') ?? []) {
      const id = text(model.text, profile, 'id') ?? 'unnamed';
      out.push(...dependenciesFrom(model.text, xmlChild(profile, 'dependencies'), versions, `profile:${id}`));
    }
    return out;
  }
}

/** Reads a repository's poms together, by path. */
export function readMavenBuild(poms: ReadonlyArray<{ path: string; text: string }>): MavenBuild {
  return new MavenBuild(new Map(poms.map((pom) => [pom.path.replace(/\\/g, '/'), pom.text])));
}

/**
 * The version as the pom gives it: the dependency's own `<version>`, else the one
 * `<dependencyManagement>` names (its own, a parent's, or an imported BOM's), with
 * the properties filled in. A `system` dependency is a jar on disk: `file:<systemPath>`.
 */
function versionSpecOf(source: string, dependency: XmlNode, noteKey: string, pom: PomVersions): string | undefined {
  if (text(source, dependency, 'scope') === 'system') {
    const path = text(source, dependency, 'systemPath');
    return `file:${path ? interpolate(path, pom.properties) : ''}`;
  }
  const own = text(source, dependency, 'version');
  if (own) return interpolate(own, pom.properties);
  return pom.managed.get(noteKey) ?? pom.managed.get(interpolate(noteKey, pom.properties));
}

function dependenciesFrom(
  source: string,
  dependencies: XmlNode | undefined,
  pom: PomVersions,
  scopePrefix?: string,
): DependencyEntry[] {
  if (!dependencies) return [];
  const out: DependencyEntry[] = [];
  for (const dependency of dependencies.children.filter((node) => node.name === 'dependency')) {
    const group = xmlTextValue(source, xmlChild(dependency, 'groupId'));
    const artifact = xmlTextValue(source, xmlChild(dependency, 'artifactId'));
    if (!group || !artifact) continue;
    const declaredScope = text(source, dependency, 'scope') ?? 'compile';
    const scope = scopePrefix ? `${scopePrefix}/${declaredScope}` : declaredScope;
    const noteKey = `${group.value}:${artifact.value}`;
    const iconRange = { offset: dependency.openStart, length: 1 };
    const entry = dependencyEntry(noteKey, scope, artifact.range, [group.range, artifact.range], noteKey, iconRange);
    const versionSpec = versionSpecOf(source, dependency, noteKey, pom);
    out.push(versionSpec ? { ...entry, versionSpec } : entry);
  }
  return out;
}

/**
 * Extracts one pom's direct Maven dependencies without invoking Maven. Read alone,
 * its parent pom and the BOMs it imports are unknown; readMavenBuild reads a
 * repository's poms together.
 */
export function extractMavenDependencies(text: string): DependencyEntry[] {
  return readMavenBuild([{ path: 'pom.xml', text }]).dependencies('pom.xml');
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
