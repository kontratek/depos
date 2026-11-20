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
  /** The path in the repository, or `registry:` and `group:artifact:version` for a registry's pom. */
  path: string;
  text: string;
  project: XmlNode;
  /** `groupId:artifactId`, the group inherited from the parent when not written. */
  coordinate?: string;
  /** The pom's version, inherited from the parent when not written. */
  version?: string;
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
  const version = text(source, project, 'version') ?? parent?.version;
  return {
    path,
    text: source,
    project,
    ...(group && artifact ? { coordinate: `${group}:${artifact}` } : {}),
    ...(version ? { version } : {}),
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

const REGISTRY_PREFIX = 'registry:';
const COORDINATE_PART_RE = /^[A-Za-z0-9_][\w.-]*$/;

/**
 * The registry key of a released pom, `group:artifact:version`, or undefined when
 * it names none: a property not filled in, a `-SNAPSHOT` (never on Maven Central),
 * a range, or anything that is not a plain coordinate.
 */
export function mavenRegistryKey(group: string, artifact: string, version: string | undefined): string | undefined {
  if (!version || /SNAPSHOT$/i.test(version)) return undefined;
  if (![group, artifact, version].every((part) => COORDINATE_PART_RE.test(part) && !part.includes('..'))) return undefined;
  return `${group}:${artifact}:${version}`;
}

/**
 * The poms of one repository, read together: a module inherits its parent's
 * properties and `<dependencyManagement>`, and a BOM it imports adds that BOM's
 * management.
 *
 * A parent or a BOM the repository does not hold (`spring-boot-starter-parent`) is
 * read from `registry`, the released poms the caller fetched by their
 * `group:artifact:version`. `registryPomsNeeded` names the ones still missing: the
 * caller fetches them and reads the build again, until nothing is missing. A pom
 * `registry` maps to null is not there to read. Without it, a version only a
 * registry's pom gives is unknown.
 *
 * As Maven does: inheritance first (a child's property or managed entry replaces
 * its parent's), then `${…}` is filled in from the merged properties, so a child can
 * change the version its parent manages, even a BOM's version (Spring Boot's
 * `jackson-bom.version`). Imports come last: an imported BOM is read with its own
 * properties, and never replaces an entry the pom or its parents manage; of two
 * BOMs, the first imported wins.
 */
export class MavenBuild {
  private readonly models = new Map<string, PomModel | null>();
  private readonly inherited = new Map<string, InheritedPom>();
  private readonly versions = new Map<string, PomVersions>();
  private readonly needed = new Set<string>();
  private byCoordinate?: Map<string, string | null>;

  constructor(
    private readonly poms: ReadonlyMap<string, string>,
    private readonly registry: ReadonlyMap<string, string | null> = new Map(),
  ) {}

  private model(path: string): PomModel | undefined {
    if (!this.models.has(path)) {
      const source = this.poms.get(path);
      this.models.set(path, source === undefined ? null : readPom(path, source) ?? null);
    }
    return this.models.get(path) ?? undefined;
  }

  /** A registry's pom by its key; a key `registry` does not hold yet is needed. */
  private registryModel(key: string | undefined): PomModel | undefined {
    if (!key) return undefined;
    const path = `${REGISTRY_PREFIX}${key}`;
    if (!this.models.has(path)) {
      if (!this.registry.has(key)) {
        this.needed.add(key);
        return undefined;
      }
      const source = this.registry.get(key);
      this.models.set(path, source == null ? null : readPom(path, source) ?? null);
    }
    return this.models.get(path) ?? undefined;
  }

  private static fromRegistry(model: PomModel): boolean {
    return model.path.startsWith(REGISTRY_PREFIX);
  }

  /** The released poms the repository's poms need that `registry` does not hold, by `group:artifact:version`. */
  registryPomsNeeded(): string[] {
    for (const path of this.poms.keys()) {
      const model = this.model(path);
      if (model) this.pomVersions(model);
    }
    return [...this.needed];
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

  /** The parent pom: the repository's, else the registry's. A registry's pom has only a registry parent. */
  private parentModel(model: PomModel): PomModel | undefined {
    const parent = model.parent;
    if (!parent) return undefined;
    const inRepository = MavenBuild.fromRegistry(model) ? undefined : this.repositoryParent(model);
    return inRepository ?? this.registryModel(mavenRegistryKey(parent.group, parent.artifact, parent.version));
  }

  /** The parent pom in the repository: at `<relativePath>` (by default `../pom.xml`) when it is that module, else the one module that is. */
  private repositoryParent(model: PomModel): PomModel | undefined {
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
    const builtIn = (name: string, value: string | undefined) => {
      if (value && !properties.has(name)) properties.set(name, value);
    };
    const [group, artifact] = model.coordinate?.split(':') ?? [];
    builtIn('project.groupId', group);
    builtIn('project.artifactId', artifact);
    // A repository's own version stays `${project.version}` (see interpolate); a
    // released pom's is a release, and its BOM entries often name it.
    if (MavenBuild.fromRegistry(model)) {
      builtIn('project.version', model.version);
      builtIn('project.parent.version', model.parent?.version);
    }
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
      const bomGroup = interpolate(entry.group, properties);
      const bomArtifact = interpolate(entry.artifact, properties);
      const path = MavenBuild.fromRegistry(model) ? undefined : this.pathOf(`${bomGroup}:${bomArtifact}`);
      const bom = (path ? this.model(path) : undefined)
        ?? this.registryModel(mavenRegistryKey(bomGroup, bomArtifact, entry.version && interpolate(entry.version, properties)));
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
    if (options.parent && model.parent && !this.repositoryParent(model)) {
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

/**
 * Reads a repository's poms together, by path, with the released poms fetched so
 * far by `group:artifact:version` (null: not in the registry).
 */
export function readMavenBuild(
  poms: ReadonlyArray<{ path: string; text: string }>,
  registry: ReadonlyMap<string, string | null> = new Map(),
): MavenBuild {
  return new MavenBuild(new Map(poms.map((pom) => [pom.path.replace(/\\/g, '/'), pom.text])), registry);
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
