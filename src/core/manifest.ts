import type { DependencyEntry, ManifestKind } from './model';
import { extractCargoDependencies } from './cargoManifest';
import { extractMavenDependencies } from './mavenManifest';
import { extractNpmDependencies } from './packageJson';
import { extractGradleDependencies } from './gradleManifest';
import { extractMixDependencies } from './mixManifest';
import { extractGleamDependencies } from './gleam-manifest';
import { extractZigDependencies } from './zig-manifest';
import {
  extractPyprojectDependencies,
  extractRequirementsDependencies,
  normalizePythonPackageName,
  pythonRequirementsScope,
} from './python-manifest';
import { extractNugetDependencies, isNugetManifestPath } from './nuget-manifest';
import { extractGoDependencies } from './go-manifest';
import { extractVcpkgDependencies } from './vcpkg-manifest';
import { extractConanDependencies } from './conan-manifest';
import { extractComposerDependencies } from './composer-manifest';
import { extractRubyDependencies, isRubyManifestPath } from './ruby-manifest';
import { NOTES_DIR, NOTES_DIRS, type NotesDir } from './template';
export { dependencyAtOffset } from './dependency';

export interface ManifestAdapter {
  kind: ManifestKind;
  /** Supported names in default-selection order. */
  fileNames: readonly string[];
  /** Workspace globs used for discovery, selection, and file watching. */
  discoveryGlobs: readonly string[];
  notesRelativePath: string;
  matchesPath(path: string): boolean;
  extractDependencies(text: string, path?: string): DependencyEntry[];
  normalizeNoteKey(raw: string): string;
}

function tolerantKey(raw: string): string {
  let value = raw.trim();
  const quote = /^(`|"|')(.*)\1$/.exec(value);
  if (quote?.[2] !== undefined) value = quote[2].trim();
  return value;
}

function normalizedPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function pathBasename(path: string): string {
  return normalizedPath(path).split('/').at(-1) ?? '';
}

function exactPathMatcher(fileNames: readonly string[]): (path: string) => boolean {
  return (path) => fileNames.includes(pathBasename(path));
}

function exactDiscoveryGlobs(fileNames: readonly string[]): string[] {
  return fileNames.map((fileName) => `**/${fileName}`);
}

export const MANIFEST_ADAPTERS: readonly ManifestAdapter[] = [
  {
    kind: 'npm',
    fileNames: ['package.json'],
    discoveryGlobs: exactDiscoveryGlobs(['package.json']),
    notesRelativePath: '.depos/DEPENDENCY-NOTES.md',
    matchesPath: exactPathMatcher(['package.json']),
    extractDependencies: extractNpmDependencies,
    normalizeNoteKey: (raw) => tolerantKey(raw).toLowerCase(),
  },
  {
    kind: 'cargo',
    fileNames: ['Cargo.toml'],
    discoveryGlobs: exactDiscoveryGlobs(['Cargo.toml']),
    notesRelativePath: '.depos/cargo/DEPENDENCY-NOTES.md',
    matchesPath: exactPathMatcher(['Cargo.toml']),
    extractDependencies: extractCargoDependencies,
    normalizeNoteKey: tolerantKey,
  },
  {
    kind: 'maven',
    fileNames: ['pom.xml'],
    discoveryGlobs: exactDiscoveryGlobs(['pom.xml']),
    notesRelativePath: '.depos/maven/DEPENDENCY-NOTES.md',
    matchesPath: exactPathMatcher(['pom.xml']),
    extractDependencies: extractMavenDependencies,
    normalizeNoteKey: tolerantKey,
  },
  {
    kind: 'gradle',
    fileNames: ['build.gradle.kts', 'build.gradle'],
    discoveryGlobs: exactDiscoveryGlobs(['build.gradle.kts', 'build.gradle']),
    notesRelativePath: '.depos/gradle/DEPENDENCY-NOTES.md',
    matchesPath: exactPathMatcher(['build.gradle.kts', 'build.gradle']),
    extractDependencies: extractGradleDependencies,
    normalizeNoteKey: tolerantKey,
  },
  {
    kind: 'mix',
    fileNames: ['mix.exs'],
    discoveryGlobs: exactDiscoveryGlobs(['mix.exs']),
    notesRelativePath: '.depos/mix/DEPENDENCY-NOTES.md',
    matchesPath: exactPathMatcher(['mix.exs']),
    extractDependencies: extractMixDependencies,
    normalizeNoteKey: tolerantKey,
  },
  {
    kind: 'gleam',
    fileNames: ['gleam.toml'],
    discoveryGlobs: exactDiscoveryGlobs(['gleam.toml']),
    notesRelativePath: '.depos/gleam/DEPENDENCY-NOTES.md',
    matchesPath: exactPathMatcher(['gleam.toml']),
    extractDependencies: extractGleamDependencies,
    normalizeNoteKey: tolerantKey,
  },
  {
    kind: 'zig',
    fileNames: ['build.zig.zon'],
    discoveryGlobs: exactDiscoveryGlobs(['build.zig.zon']),
    notesRelativePath: '.depos/zig/DEPENDENCY-NOTES.md',
    matchesPath: exactPathMatcher(['build.zig.zon']),
    extractDependencies: extractZigDependencies,
    normalizeNoteKey: tolerantKey,
  },
  {
    kind: 'python',
    fileNames: ['pyproject.toml', 'requirements.txt'],
    discoveryGlobs: ['**/pyproject.toml', '**/requirements*.txt', '**/requirements/**/*.txt'],
    notesRelativePath: '.depos/python/DEPENDENCY-NOTES.md',
    matchesPath: (path) => {
      const normalized = normalizedPath(path);
      const basename = pathBasename(normalized);
      return basename === 'pyproject.toml'
        || /^requirements.*\.txt$/.test(basename)
        || (basename.endsWith('.txt') && normalized.split('/').includes('requirements'));
    },
    extractDependencies: (text, path = 'pyproject.toml') => pathBasename(path) === 'pyproject.toml'
      ? extractPyprojectDependencies(text)
      : extractRequirementsDependencies(text, pythonRequirementsScope(path)),
    normalizeNoteKey: (raw) => normalizePythonPackageName(tolerantKey(raw)),
  },
  {
    kind: 'ruby',
    fileNames: ['Gemfile', 'gems.rb'],
    discoveryGlobs: ['**/Gemfile', '**/gems.rb', '**/*.gemspec'],
    notesRelativePath: '.depos/ruby/DEPENDENCY-NOTES.md',
    matchesPath: isRubyManifestPath,
    extractDependencies: extractRubyDependencies,
    normalizeNoteKey: tolerantKey,
  },
  {
    kind: 'nuget',
    fileNames: ['Directory.Packages.props'],
    discoveryGlobs: ['**/*.csproj', '**/*.fsproj', '**/*.vbproj', '**/Directory.Packages.props'],
    notesRelativePath: '.depos/nuget/DEPENDENCY-NOTES.md',
    matchesPath: isNugetManifestPath,
    extractDependencies: extractNugetDependencies,
    normalizeNoteKey: (raw) => tolerantKey(raw).toLowerCase(),
  },
  {
    kind: 'go',
    fileNames: ['go.mod'],
    discoveryGlobs: exactDiscoveryGlobs(['go.mod']),
    notesRelativePath: '.depos/go/DEPENDENCY-NOTES.md',
    matchesPath: exactPathMatcher(['go.mod']),
    extractDependencies: extractGoDependencies,
    normalizeNoteKey: tolerantKey,
  },
  {
    kind: 'vcpkg',
    fileNames: ['vcpkg.json'],
    discoveryGlobs: exactDiscoveryGlobs(['vcpkg.json']),
    notesRelativePath: '.depos/vcpkg/DEPENDENCY-NOTES.md',
    matchesPath: exactPathMatcher(['vcpkg.json']),
    extractDependencies: extractVcpkgDependencies,
    normalizeNoteKey: (raw) => tolerantKey(raw).toLowerCase(),
  },
  {
    kind: 'conan',
    fileNames: ['conanfile.py', 'conanfile.txt'],
    discoveryGlobs: exactDiscoveryGlobs(['conanfile.py', 'conanfile.txt']),
    notesRelativePath: '.depos/conan/DEPENDENCY-NOTES.md',
    matchesPath: exactPathMatcher(['conanfile.py', 'conanfile.txt']),
    extractDependencies: extractConanDependencies,
    normalizeNoteKey: (raw) => tolerantKey(raw).toLowerCase(),
  },
  {
    kind: 'composer',
    fileNames: ['composer.json'],
    discoveryGlobs: exactDiscoveryGlobs(['composer.json']),
    notesRelativePath: '.depos/composer/DEPENDENCY-NOTES.md',
    matchesPath: exactPathMatcher(['composer.json']),
    extractDependencies: extractComposerDependencies,
    normalizeNoteKey: (raw) => tolerantKey(raw).toLowerCase(),
  },
];

export function manifestAdapterForFileName(fileName: string): ManifestAdapter | undefined {
  return manifestAdapterForPath(fileName);
}

export function manifestAdapterForPath(path: string): ManifestAdapter | undefined {
  return MANIFEST_ADAPTERS.find((adapter) => adapter.matchesPath(path));
}

export function manifestAdapterForKind(kind: ManifestKind): ManifestAdapter {
  return MANIFEST_ADAPTERS.find((adapter) => adapter.kind === kind)!;
}

/** The adapter's notes path under `dir`: `notesRelativePath` names the current directory. */
export function notesRelativePathIn(adapter: ManifestAdapter, dir: NotesDir): string {
  return dir === NOTES_DIR ? adapter.notesRelativePath : `${dir}/${adapter.notesRelativePath.slice(NOTES_DIR.length + 1)}`;
}

/** The ecosystem whose notes file the path is, under either notes directory. */
export function notesKindOfPath(path: string): ManifestKind | undefined {
  const normalized = path.replace(/\\/g, '/');
  return MANIFEST_ADAPTERS.find((adapter) =>
    NOTES_DIRS.some((dir) => normalized.endsWith(`/${notesRelativePathIn(adapter, dir)}`)))?.kind;
}
