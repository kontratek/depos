import * as vscode from 'vscode';
import type { OrgContext } from './orgContext';
import { mcpServersFor } from './orgMcpServers';
import type { WebConnection } from './webConnection';

/** `contributes.mcpServerDefinitionProviders` in package.json. */
export const ORG_MCP_PROVIDER_ID = 'pacmon.orgNotes';

/**
 * Gives the agents of VS Code the org notes of each folder in org mode, through the
 * Depos MCP server (docs/format.md, "The organization layer", "Agents").
 *
 * The definitions carry no token. The token is added when VS Code starts a server, and
 * only for the server the user is signed in to, so it never lands in MCP settings.
 */
export function registerOrgMcp(org: OrgContext, web: WebConnection): vscode.Disposable {
  // Editors built on an older VS Code API have no MCP providers: the agents there keep the files.
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function') return new vscode.Disposable(() => undefined);
  const changed = new vscode.EventEmitter<void>();
  let last = '';
  const servers = () => mcpServersFor(org.orgFolders());
  const update = () => {
    const now = JSON.stringify(servers());
    if (now === last) return;
    last = now;
    changed.fire();
  };

  const provider: vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () =>
      servers().map((s) => new vscode.McpHttpServerDefinition(s.label, vscode.Uri.parse(s.url), {}, s.version)),
    resolveMcpServerDefinition: async (server) => {
      const creds = await web.credentials();
      // Signed out, or signed in to another server since: do not start it.
      if (!creds || `${server.uri.scheme}://${server.uri.authority}` !== creds.origin) return undefined;
      server.headers = { ...server.headers, Authorization: `Bearer ${creds.token}` };
      return server;
    },
  };

  return vscode.Disposable.from(
    changed,
    org.onDidChange(update),
    web.onDidChange(update),
    vscode.lm.registerMcpServerDefinitionProvider(ORG_MCP_PROVIDER_ID, provider),
  );
}
