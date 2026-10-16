import * as vscode from 'vscode';
import { MANIFEST_ADAPTERS, manifestAdapterForKind, manifestAdapterForPath } from '../core/manifest';
import type { DependencyEntry, ManifestKind } from '../core/model';
import { uniqueNugetDependencies } from '../core/nuget-manifest';
import { uniqueRubyDependencies } from '../core/ruby-manifest';
import { AGENT_RULES_REL_PATH } from '../core/template';
import { monorepoMode, uriBasename } from './config';

const DISCOVERY_EXCLUDE = '**/{node_modules,target,.gradle,_build,deps,zig-pkg,.zig-cache,zig-cache,zig-out,.venv,venv,.tox,.nox,site-packages,dist,build,bin,obj,vendor,testdata,.bundle,.conan,.conan2,vcpkg_installed,.git}/**';

const existsCache = new Map<string, boolean>();
const manifestsForNotesCache = new Map<string, Promise<vscode.Uri[]>>();

export function clearResolverCache(): void {
  existsCache.clear();
  manifestsForNotesCache.clear();
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  const key = uri.toString();
  const hit = existsCache.get(key);
  if (hit !== undefined) return hit;
  try {
    await vscode.workspace.fs.stat(uri);
    existsCache.set(key, true);
    return true;
  } catch {
    existsCache.set(key, false);
    return false;
  }
}

function parentDir(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, '..');
}

/** Python files in requirements/ belong to the project directory above it. */
export function manifestOwnerDirectory(uri: vscode.Uri): vscode.Uri {
  const adapter = manifestAdapterForPath(uri.path);
  let directory = parentDir(uri);
  if (adapter?.kind !== 'python' || uriBasename(uri) === 'pyproject.toml') return directory;
  for (let i = 0; i < 64; i++) {
    if (uriBasename(directory) === 'requirements') return parentDir(directory);
    const parent = parentDir(directory);
    if (parent.path === directory.path) break;
    directory = parent;
  }
  return parentDir(uri);
}

/** NuGet projects using central package management belong to the closest
 * Directory.Packages.props. Other manifests retain their ordinary directory. */
async function manifestOwnerDirectoryForResolution(uri: vscode.Uri): Promise<vscode.Uri> {
  const adapter = manifestAdapterForPath(uri.path);
  const directOwner = manifestOwnerDirectory(uri);
  if (adapter?.kind !== 'nuget' || uriBasename(uri) === 'Directory.Packages.props') return directOwner;
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return directOwner;
  let directory = directOwner;
  const rootPath = folder.uri.path.replace(/\/+$/, '');
  for (let i = 0; i < 64; i++) {
    if (await exists(vscode.Uri.joinPath(directory, 'Directory.Packages.props'))) return directory;
    const directoryPath = directory.path.replace(/\/+$/, '');
    if (directoryPath === rootPath || directoryPath.length <= rootPath.length) break;
    directory = parentDir(directory);
  }
  return directOwner;
}

export function notesUriIn(dir: vscode.Uri, kind: ManifestKind = 'npm'): vscode.Uri {
  return vscode.Uri.joinPath(dir, ...manifestAdapterForKind(kind).notesRelativePath.split('/'));
}

export function notesKind(uri: vscode.Uri): ManifestKind | undefined {
  const normalized = uri.path.replace(/\\/g, '/');
  return MANIFEST_ADAPTERS.find((adapter) => normalized.endsWith(`/${adapter.notesRelativePath}`))?.kind;
}

/** The manifest beside the directory that owns a notes file. */
export function manifestsBesideNotes(notesUri: vscode.Uri): vscode.Uri[] {
  const kind = notesKind(notesUri);
  if (!kind) return [];
  const levels = kind === 'npm' ? ['..', '..'] : ['..', '..', '..'];
  return manifestAdapterForKind(kind).fileNames.map((fileName) => vscode.Uri.joinPath(notesUri, ...levels, fileName));
}

export function manifestForNotes(notesUri: vscode.Uri): vscode.Uri | undefined {
  return manifestsBesideNotes(notesUri)[0];
}

/** Backward-compatible npm-only name. */
export function packageJsonFor(notesUri: vscode.Uri): vscode.Uri {
  return manifestForNotes(notesUri) ?? vscode.Uri.joinPath(notesUri, '..', '..', 'package.json');
}

export function agentRulesUriFor(anyUri: vscode.Uri): vscode.Uri | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(anyUri) ?? vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, ...AGENT_RULES_REL_PATH.split('/')) : undefined;
}

/**
 * Org mode (web/orgContext.ts): the notes of a manifest are the org notes, through a
 * read-only notes "file" that is not on disk. Undefined in file mode.
 */
let notesOverride: ((manifestUri: vscode.Uri) => vscode.Uri | undefined) | undefined;

export function setNotesOverride(fn: (manifestUri: vscode.Uri) => vscode.Uri | undefined): void {
  notesOverride = fn;
}

/** The org mode notes of a manifest, or undefined in file mode. */
export function orgModeNotesUri(manifestUri: vscode.Uri): vscode.Uri | undefined {
  return notesOverride?.(manifestUri);
}

export async function resolveNotesFileFor(manifestUri: vscode.Uri): Promise<vscode.Uri | undefined> {
  const orgNotes = orgModeNotesUri(manifestUri);
  if (orgNotes) return orgNotes;
  const adapter = manifestAdapterForPath(manifestUri.path);
  const folder = vscode.workspace.getWorkspaceFolder(manifestUri);
  if (!adapter || !folder) return undefined;
  if (monorepoMode() === 'rootOnly') {
    const candidate = notesUriIn(folder.uri, adapter.kind);
    return (await exists(candidate)) ? candidate : undefined;
  }
  let dir = await manifestOwnerDirectoryForResolution(manifestUri);
  const rootPath = folder.uri.path.replace(/\/+$/, '');
  for (let i = 0; i < 64; i++) {
    const candidate = notesUriIn(dir, adapter.kind);
    if (await exists(candidate)) return candidate;
    const dirPath = dir.path.replace(/\/+$/, '');
    if (dirPath === rootPath || dirPath.length <= rootPath.length) break;
    dir = parentDir(dir);
  }
  return undefined;
}

export async function creationTargetFor(manifestUri: vscode.Uri): Promise<vscode.Uri> {
  const adapter = manifestAdapterForPath(manifestUri.path);
  return notesUriIn(await manifestOwnerDirectoryForResolution(manifestUri), adapter?.kind ?? 'npm');
}

export async function defaultManifest(store: {
  getText(uri: vscode.Uri): Promise<string | undefined>;
  getLastManifest?(): vscode.Uri | undefined;
}): Promise<vscode.Uri | undefined> {
  const last = store.getLastManifest?.();
  if (last && (await store.getText(last)) !== undefined) return last;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  for (const adapter of MANIFEST_ADAPTERS) {
    for (const fileName of adapter.fileNames) {
      const candidate = vscode.Uri.joinPath(folder.uri, fileName);
      if ((await store.getText(candidate)) !== undefined) return candidate;
    }
  }
  for (const adapter of MANIFEST_ADAPTERS) {
    const groups = await Promise.all(adapter.discoveryGlobs.map((glob) => vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, glob),
      DISCOVERY_EXCLUDE,
    )));
    const first = groups.flat().sort((a, b) => a.path.localeCompare(b.path))[0];
    if (first) return first;
  }
  return undefined;
}

/** Backward-compatible name; now returns the default supported manifest. */
export const defaultPackageJson = defaultManifest;

function manifestPriority(uri: vscode.Uri): string {
  const basename = uriBasename(uri);
  const adapter = manifestAdapterForPath(uri.path);
  const rank = adapter?.kind === 'python'
    ? basename === 'pyproject.toml' ? 0 : basename === 'requirements.txt' ? 1 : 2
    : adapter?.kind === 'nuget'
      ? basename === 'Directory.Packages.props' ? 0 : 1
      : adapter?.kind === 'ruby'
        ? basename === 'Gemfile' ? 0 : basename === 'gems.rb' ? 1 : 2
      : Math.max(0, adapter?.fileNames.indexOf(basename) ?? 99);
  return `${rank.toString().padStart(2, '0')}:${uri.path}`;
}

export async function manifestsForNotes(notesUri: vscode.Uri): Promise<vscode.Uri[]> {
  const key = notesUri.toString();
  const cached = manifestsForNotesCache.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const kind = notesKind(notesUri);
    const folder = vscode.workspace.getWorkspaceFolder(notesUri);
    if (!kind || !folder) return [];
    const adapter = manifestAdapterForKind(kind);
    const groups = await Promise.all(adapter.discoveryGlobs.map((glob) => vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, glob),
      DISCOVERY_EXCLUDE,
    )));
    const found = groups.flat();
    const matching: vscode.Uri[] = [];
    for (const uri of found) {
      const resolved = await resolveNotesFileFor(uri);
      const target = resolved ?? await creationTargetFor(uri);
      if (target.toString() === key) matching.push(uri);
    }
    if (matching.length === 0) {
      for (const sibling of manifestsBesideNotes(notesUri)) {
        if (await exists(sibling)) matching.push(sibling);
      }
    }
    return matching.sort((a, b) => manifestPriority(a).localeCompare(manifestPriority(b)));
  })();
  manifestsForNotesCache.set(key, pending);
  return pending;
}

export async function dependenciesForNotes(
  store: { getDeps(uri: vscode.Uri): Promise<DependencyEntry[]> },
  notesUri: vscode.Uri,
): Promise<DependencyEntry[]> {
  const groups = await Promise.all((await manifestsForNotes(notesUri)).map((uri) => store.getDeps(uri)));
  const dependencies = groups.flat();
  const kind = notesKind(notesUri);
  if (kind === 'nuget') return uniqueNugetDependencies(dependencies);
  if (kind === 'ruby') return uniqueRubyDependencies(dependencies);
  return dependencies;
}
