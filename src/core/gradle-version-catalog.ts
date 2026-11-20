import type { DependencyEntry } from './model';
import { lockfileForIn } from './lockfile';
import { commentStart, lineRecords, nestingDelta, unquotedEquals } from './toml-scan';

/**
 * Gradle's version catalog, `gradle/libs.versions.toml`: what a build script's
 * `libs.jackson.databind` names. The reader of a build file sees only the alias;
 * the catalog gives the module (`com.fasterxml.jackson.core:jackson-databind`) and
 * its version, so the alias can be checked like a coordinate written out.
 *
 * Gradle reads the catalog from the root of the build, so the one that covers a
 * build file is the closest `gradle/libs.versions.toml` at or above its directory.
 * Only the default `libs` catalog is read: another name is declared in
 * settings.gradle, which is a program.
 *
 * An alias is its dash, underscore or dot separated parts, so `groovy-core`,
 * `groovy_core` and `groovy.core` are all `libs.groovy.core`. A library's version
 * is written inline (`version = "1.0"`), as a reference into `[versions]`
 * (`version.ref = "jackson"`), or in the rich form (`{ strictly = "1.0" }`), which
 * is given in Gradle's short notation (`1.0!!`). A bundle is the libraries it lists;
 * plugins are not read.
 *
 * Not a TOML parser: it reads the shapes a catalog uses.
 */

export const GRADLE_CATALOG_PATH = 'gradle/libs.versions.toml';

export interface GradleCatalogLibrary {
  /** `group:artifact`. */
  module: string;
  /** The version as the catalog gives it; none when a platform manages it. */
  versionSpec?: string;
}

export interface GradleCatalog {
  /** The library a build script's accessor (`libs.jackson.databind`) names. */
  library(accessor: string): GradleCatalogLibrary | undefined;
  /** The libraries a bundle's accessor (`libs.bundles.jackson`) names, in the catalog's order. */
  bundle(accessor: string): GradleCatalogLibrary[] | undefined;
}

type TomlValue = string | string[] | TomlTable;
interface TomlTable { [key: string]: TomlValue | undefined }

const table = (): TomlTable => Object.create(null) as TomlTable;

export function isGradleCatalogPath(path: string): boolean {
  return path === GRADLE_CATALOG_PATH || path.endsWith(`/${GRADLE_CATALOG_PATH}`);
}

/** The catalog of the build a build file belongs to: the closest one at or above its directory. */
export function gradleCatalogFor(manifestPath: string, paths: ReadonlySet<string>): string | undefined {
  return lockfileForIn([GRADLE_CATALOG_PATH], manifestPath, paths);
}

/** A key's parts: `version.ref` is two, `"a.b"` one. */
function keyParts(raw: string): string[] | undefined {
  const parts: string[] = [];
  let rest = raw.trim();
  while (rest) {
    let part: string;
    if (rest[0] === '"' || rest[0] === "'") {
      const close = rest.indexOf(rest[0], 1);
      if (close === -1) return undefined;
      part = rest.slice(1, close);
      rest = rest.slice(close + 1).trim();
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(rest);
      if (!match) return undefined;
      part = match[0];
      rest = rest.slice(part.length).trim();
    }
    parts.push(part);
    if (!rest) break;
    if (rest[0] !== '.') return undefined;
    rest = rest.slice(1).trim();
  }
  return parts.length ? parts : undefined;
}

function assign(target: TomlTable, path: readonly string[], value: TomlValue): void {
  let node = target;
  for (const part of path.slice(0, -1)) {
    const next = node[part];
    if (typeof next === 'string' || Array.isArray(next)) return;
    node = next ?? (node[part] = table());
  }
  node[path.at(-1)!] = value;
}

/** Reads one value at `text[at]`: a string, an inline table, or anything else skipped. */
function readValue(text: string, at: number): { value?: TomlValue; end: number } {
  let i = at;
  while (text[i] === ' ' || text[i] === '\t') i++;
  const ch = text[i];
  if (ch === '"') {
    let out = '';
    for (i++; i < text.length && text[i] !== '"'; i++) {
      if (text[i] === '\\' && i + 1 < text.length) {
        const escaped = text[++i]!;
        out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
      } else {
        out += text[i];
      }
    }
    return { value: out, end: i + 1 };
  }
  if (ch === "'") {
    const close = text.indexOf("'", i + 1);
    return close === -1 ? { end: text.length } : { value: text.slice(i + 1, close), end: close + 1 };
  }
  if (ch === '{') {
    const inline = table();
    i++;
    for (;;) {
      while (/[\s,]/.test(text[i] ?? '')) i++;
      if (i >= text.length || text[i] === '}') return { value: inline, end: i + 1 };
      const equals = unquotedEquals(text.slice(i));
      if (equals === -1) return { value: inline, end: text.length };
      const key = keyParts(text.slice(i, i + equals));
      const read = readValue(text, i + equals + 1);
      if (key && read.value !== undefined) assign(inline, key, read.value);
      i = read.end;
    }
  }
  if (ch === '[') {
    // An array: a bundle's aliases. Only its strings are kept.
    const items: string[] = [];
    i++;
    for (;;) {
      while (/[\s,]/.test(text[i] ?? '')) i++;
      if (i >= text.length || text[i] === ']') return { value: items, end: i + 1 };
      const read = readValue(text, i);
      if (typeof read.value === 'string') items.push(read.value);
      i = Math.max(read.end, i + 1);
    }
  }
  // A number or boolean: skipped to the end of its nesting.
  let depth = 0;
  for (; i < text.length; i++) {
    const c = text[i];
    if (c === '[' || c === '{') depth++;
    else if ((c === ']' || c === '}') && --depth < 0) break;
    else if (c === ',' && depth === 0) break;
    else if ((c === '"' || c === "'") && depth > 0) i = readValue(text, i).end - 1;
  }
  return { end: i };
}

function readToml(text: string): TomlTable {
  const root = table();
  let current: string[] | undefined = [];
  let pending = '';
  for (const record of lineRecords(text)) {
    const line = `${pending}${pending ? '\n' : ''}${record.text.slice(0, commentStart(record.text))}`;
    // An array (a bundle) can run over several lines.
    if (nestingDelta(line) > 0) {
      pending = line;
      continue;
    }
    pending = '';
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('[[')) {
      current = undefined;
      continue;
    }
    if (trimmed.startsWith('[')) {
      current = keyParts(trimmed.slice(1, trimmed.lastIndexOf(']')));
      continue;
    }
    const equals = unquotedEquals(trimmed);
    if (!current || equals === -1) continue;
    const key = keyParts(trimmed.slice(0, equals));
    const { value } = readValue(trimmed, equals + 1);
    if (key && value !== undefined) assign(root, [...current, ...key], value);
  }
  return root;
}

/** A rich version in Gradle's short notation: `strictly!!prefer`, else `require`, else `prefer`. */
function richVersion(value: TomlTable): string | undefined {
  const text = (key: string) => {
    const v = value[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const strictly = text('strictly');
  if (strictly) return `${strictly}!!${text('prefer') ?? ''}`;
  return text('require') ?? text('prefer');
}

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === 'object' && !Array.isArray(value);
}

function versionOf(value: TomlValue | undefined, versions: TomlTable): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!isTable(value)) return undefined;
  const ref = value.ref;
  if (typeof ref === 'string') {
    const target = versions[ref];
    return typeof target === 'string' ? target.trim() || undefined : isTable(target) ? richVersion(target) : undefined;
  }
  return richVersion(value);
}

const MODULE_PART_RE = /^[^\s:]+$/;

function libraryOf(value: TomlValue, versions: TomlTable): GradleCatalogLibrary | undefined {
  let group: unknown;
  let name: unknown;
  let versionSpec: string | undefined;
  if (typeof value === 'string') {
    // `group:artifact:version`
    const parts = value.split(':').map((part) => part.trim());
    [group, name] = parts;
    versionSpec = parts[2] || undefined;
  } else if (isTable(value)) {
    const module = value.module;
    if (typeof module === 'string') [group, name] = module.split(':').map((part) => part.trim());
    else ({ group, name } = value);
    versionSpec = versionOf(value.version, versions);
  } else {
    return undefined;
  }
  if (typeof group !== 'string' || typeof name !== 'string' || !MODULE_PART_RE.test(group) || !MODULE_PART_RE.test(name)) return undefined;
  return { module: `${group}:${name}`, ...(versionSpec ? { versionSpec } : {}) };
}

/** The accessor Gradle generates for an alias: `groovy-core` is `libs.groovy.core`. */
export function gradleCatalogAccessor(alias: string): string {
  return `libs.${alias.split(/[-_.]/).join('.')}`;
}

/** Never throws: a line it cannot read gives no library, and its aliases stay unresolved. */
export function parseGradleVersionCatalog(text: string): GradleCatalog {
  const root = readToml(text);
  const versions = isTable(root.versions) ? root.versions : table();
  const libraries = new Map<string, GradleCatalogLibrary>();
  const declared = root.libraries;
  if (isTable(declared)) {
    for (const [alias, value] of Object.entries(declared)) {
      const library = value === undefined ? undefined : libraryOf(value, versions);
      if (library) libraries.set(gradleCatalogAccessor(alias), library);
    }
  }
  const bundles = new Map<string, GradleCatalogLibrary[]>();
  if (isTable(root.bundles)) {
    for (const [name, members] of Object.entries(root.bundles)) {
      if (!Array.isArray(members)) continue;
      const seen = new Set<string>();
      const resolved = members
        .map((alias) => libraries.get(gradleCatalogAccessor(alias)))
        .filter((library): library is GradleCatalogLibrary => !!library && !seen.has(library.module) && !!seen.add(library.module));
      bundles.set(gradleCatalogAccessor(`bundles.${name}`), resolved);
    }
  }
  return { library: (accessor) => libraries.get(accessor), bundle: (accessor) => bundles.get(accessor) };
}

function asLibrary(entry: DependencyEntry, library: GradleCatalogLibrary): DependencyEntry {
  const rest: DependencyEntry = { ...entry };
  delete rest.versionSpec;
  return {
    ...rest,
    noteKey: library.module,
    name: library.module,
    displayName: library.module,
    ...(library.versionSpec ? { versionSpec: library.versionSpec } : {}),
  };
}

/**
 * The build file's dependencies with each catalog alias the catalog names replaced
 * by its module and version. A bundle (`libs.bundles.x`, from
 * extractGradleDependenciesWithBundles) is each library in it; a bundle the catalog
 * does not name is left out, as it is no package. The source ranges stay on the
 * alias in the build file. A library alias the catalog does not name is kept as
 * written.
 */
export function resolveGradleCatalogAliases(entries: readonly DependencyEntry[], catalog: GradleCatalog): DependencyEntry[] {
  return entries.flatMap((entry) => {
    if (entry.noteKey.startsWith('libs.bundles.')) {
      return (catalog.bundle(entry.noteKey) ?? []).map((library) => asLibrary(entry, library));
    }
    const library = entry.noteKey.startsWith('libs.') ? catalog.library(entry.noteKey) : undefined;
    return library ? [asLibrary(entry, library)] : [entry];
  });
}
