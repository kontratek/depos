import * as vscode from 'vscode';
import { affectsSetting } from './settings';
import { AgentBlockLenses } from './agentBlockLenses';
import { setExtensionRoot } from './agentRules';
import { fixAgentNotes, registerFixProviders } from './codeActions';
import { NoteComments } from './comments';
import { NOTES_GLOB, isManifest, isNotesFile } from './config';
import { DecorationController } from './decorations';
import { NotesDiagnostics } from './diagnostics';
import { OrgDiagnostics } from './orgDiagnostics';
import { registerHover } from './hover';
import { logError, logInfo } from './log';
import { NoteButtons } from './noteButtons';
import { NotePanel } from './notePanel';
import { OrphanMarkers } from './orphanMarkers';
import { ProblemDecorations } from './problemDecorations';
import { SettingsView, openSettings, resetView } from './settingsView';
import { clearResolverCache, setNotesOverride } from './resolveNotesFile';
import { Store } from './state';
import { StatusBarController } from './statusBar';
import { addOrEditNote } from './commands/addOrEditNote';
import { setupAiInstructions } from './commands/aiSetup';
import { showCoverage } from './commands/coverage';
import { normalizeNotesFile, openManifest, openNotesFile, toggleDecorations } from './commands/simple';
import { setOrgWriter } from './commands/writeNote';
import { MANIFEST_ADAPTERS } from '../core/manifest';
import { OrgContext, OrgNoteError, ORG_NOTES_SCHEME } from './web/orgContext';
import { registerOrgMcp } from './web/orgMcp';
import { S } from './strings';
import { WebConnection } from './web/webConnection';
import { MOVE_NOTES_COMMAND, moveNotesToDepos, setMoveNotesState } from './commands/moveNotes';

export function activate(context: vscode.ExtensionContext): void {
  setExtensionRoot(context.extensionUri);
  setMoveNotesState(context.workspaceState);
  // activate() does no IO: providers are registered, state is built lazily
  // when a relevant editor first appears.
  logInfo(`Depos ${context.extension.packageJSON.version as string} activated (${vscode.env.appName})`);
  const store = new Store();
  const rememberActiveManifest = (): void => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri) store.rememberManifest(uri);
  };
  rememberActiveManifest();
  context.subscriptions.push(store);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(rememberActiveManifest));
  const statusBar = new StatusBarController(store);
  context.subscriptions.push(statusBar);
  const noteComments = new NoteComments(store);
  context.subscriptions.push(noteComments);
  const web = new WebConnection(context.secrets);
  context.subscriptions.push(web);
  // Org notes from Depos: requests only while signed in. A folder whose repository is
  // added to one of the user's organizations is in org mode: its notes are the org notes
  // (docs/format.md, "The organization layer"). Every other folder stays in file mode.
  const orgContext = new OrgContext(web, context.globalState, context.globalStorageUri);
  context.subscriptions.push(orgContext);
  // AI agents in VS Code get the org notes of each folder in org mode over MCP.
  context.subscriptions.push(registerOrgMcp(orgContext, web));
  store.setVirtualNotes(ORG_NOTES_SCHEME, orgContext);
  setNotesOverride((manifestUri) => orgContext.notesUriFor(manifestUri));
  setOrgWriter(async (pkgUri, name, human, agent) => {
    const notesUri = orgContext.notesUriFor(pkgUri);
    if (!notesUri) return undefined;
    if (human === undefined) return notesUri;
    try {
      const { dropped } = await orgContext.saveNote(pkgUri, name, human, agent);
      if (dropped > 0) void vscode.window.showWarningMessage(S.orgNoteDropped(dropped));
    } catch (e) {
      if (e instanceof OrgNoteError) void vscode.window.showErrorMessage(e.message);
      throw e;
    }
    return notesUri;
  });
  // The org notes "file" of a folder opens as a read-only document.
  const orgNotesDocs = new vscode.EventEmitter<vscode.Uri>();
  context.subscriptions.push(
    orgNotesDocs,
    vscode.workspace.registerTextDocumentContentProvider(ORG_NOTES_SCHEME, {
      onDidChange: orgNotesDocs.event,
      provideTextDocumentContent: (uri) => orgContext.readNotes(uri)?.text ?? S.orgNotesGone,
    }),
    orgContext.onDidChange(() => {
      clearResolverCache();
      store.invalidateAll();
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme === ORG_NOTES_SCHEME) orgNotesDocs.fire(doc.uri);
      }
    }),
  );
  const notePanel = new NotePanel(store, orgContext);
  context.subscriptions.push(notePanel);
  context.subscriptions.push(new NoteButtons(store));
  context.subscriptions.push(new SettingsView(store, web));

  context.subscriptions.push(registerHover(store, orgContext));
  context.subscriptions.push(new OrgDiagnostics(store, orgContext));

  const decorations = new DecorationController(store);
  context.subscriptions.push(decorations);

  context.subscriptions.push(new NotesDiagnostics(store));
  context.subscriptions.push(...registerFixProviders());
  // Problems in the notes file are made hard to miss: the message at the end
  // of the line, a lens above the block, a count in the status bar.
  context.subscriptions.push(new ProblemDecorations());
  context.subscriptions.push(new AgentBlockLenses(store));
  // Sections whose package is not in package.json: a marker, not a problem.
  context.subscriptions.push(new OrphanMarkers(store));

  // Invalidate caches when relevant documents change (debounced inside Store).
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isManifest(e.document.uri) || isNotesFile(e.document.uri)) {
        store.invalidate(e.document.uri);
      }
    }),
  );

  // Watch for external changes (git pull, agents editing files on disk).
  const registerWatcher = (glob: string): void => {
    const w = vscode.workspace.createFileSystemWatcher(glob);
    const onAny = (uri: vscode.Uri): void => {
      clearResolverCache();
      store.invalidate(uri);
    };
    w.onDidCreate(onAny);
    w.onDidChange(onAny);
    w.onDidDelete(onAny);
    context.subscriptions.push(w);
  };
  for (const adapter of MANIFEST_ADAPTERS) {
    for (const glob of adapter.discoveryGlobs) registerWatcher(glob);
  }
  registerWatcher(NOTES_GLOB);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (affectsSetting(e)) {
        clearResolverCache();
        store.invalidateAll();
      }
    }),
  );

  // Every command is wrapped: a failing command must never die silently
  // (errors land in Output → Depos plus a brief status bar note).
  const command = (id: string, fn: (...args: unknown[]) => Promise<void> | void): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (e) {
        logError(`command.${id}`, e);
        vscode.window.setStatusBarMessage('Depos: command failed — see Output → Depos', 5000);
      }
    });

  context.subscriptions.push(
    command('depos.addOrEditNote', (nameArg, bodyArg) => {
      // Editor context menus invoke commands with a Uri argument — only accept
      // real strings as the package name / body.
      const name = typeof nameArg === 'string' ? nameArg : undefined;
      const body = typeof bodyArg === 'string' ? bodyArg : undefined;
      return addOrEditNote(store, notePanel, name, body);
    }),
    command('depos.resetView', () => resetView()),
    command('depos.openSettings', () => openSettings(context.extension.id)),
    command('depos.openNotesFile', () => openNotesFile(store)),
    command('depos.openManifest', () => openManifest(store)),
    command('depos.openPackageJson', () => openManifest(store)),
    command('depos.normalizeNotesFile', () => normalizeNotesFile(store)),
    command('depos.showCoverage', () => showCoverage(store, notePanel)),
    command('depos.setupAiInstructions', (targets) =>
      // Programmatic callers (tests, scripts) may name the files to write.
      setupAiInstructions(
        store,
        Array.isArray(targets) ? targets.filter((t): t is string => typeof t === 'string') : undefined,
      ),
    ),
    command('depos.toggleDecorations', () =>
      toggleDecorations(context, () => {
        decorations.refreshVisible();
        statusBar.refreshNow();
      }),
    ),
    command('depos.saveNoteComment', (reply) => noteComments.saveFromReply(reply as vscode.CommentReply)),
    // Behind the code lens above an agent block; not in the palette.
    command('depos.fixAgentNotes', (uri) => fixAgentNotes(uri)),
    // The notes' move from .pacmon/ (before Pacmon became Depos) to .depos/.
    command(MOVE_NOTES_COMMAND, (opts) =>
      moveNotesToDepos(store, typeof opts === 'object' && opts !== null && (opts as { confirmed?: unknown }).confirmed === true),
    ),
  );

  // Optional Depos connection (depos.url). Network only while signed in.
  context.subscriptions.push(
    command('depos.signIn', () => web.signIn()),
    command('depos.signOut', () => web.signOut()),
    command('depos.showConnection', () => web.showConnection()),
    command('depos.refresh', () => orgContext.refresh()),
  );

  // The ids from before Pacmon became Depos, for keybindings that name them.
  // Not contributed, so the palette shows each command once.
  for (const [legacy, current] of LEGACY_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(legacy, (...args: unknown[]) => vscode.commands.executeCommand(current, ...args)),
    );
  }
}

const LEGACY_COMMANDS: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ['pacmon.addOrEditNote', 'depos.addOrEditNote'],
  ['pacmon.openNotesFile', 'depos.openNotesFile'],
  ['pacmon.openManifest', 'depos.openManifest'],
  ['pacmon.openPackageJson', 'depos.openPackageJson'],
  ['pacmon.normalizeNotesFile', 'depos.normalizeNotesFile'],
  ['pacmon.showCoverage', 'depos.showCoverage'],
  ['pacmon.setupAiInstructions', 'depos.setupAiInstructions'],
  ['pacmon.toggleDecorations', 'depos.toggleDecorations'],
  ['pacmon.resetView', 'depos.resetView'],
  ['pacmon.openSettings', 'depos.openSettings'],
  ['pacmon.depos.signIn', 'depos.signIn'],
  ['pacmon.depos.signOut', 'depos.signOut'],
  ['pacmon.depos.showConnection', 'depos.showConnection'],
  ['pacmon.depos.refresh', 'depos.refresh'],
];

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
