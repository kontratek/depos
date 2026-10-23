import { S } from '../strings';

/** A workspace folder in org mode, as the MCP provider needs it. */
export interface OrgMcpFolder {
  name: string;
  origin: string;
  repoUlid: string;
  /** An org admin: the server offers the write tool too. */
  canEdit: boolean;
}

/** One MCP server of Depos: the org notes of one repository, for AI agents. */
export interface OrgMcpServer {
  label: string;
  url: string;
  /** Changes when the tool list changes, so the editor offers to refresh the tools. */
  version: string;
}

/**
 * The MCP servers for the folders in org mode (docs/format.md, "Agents"): one per
 * repository, so the tools need no repository argument. Two folders of the same
 * repository share one server.
 */
export function mcpServersFor(folders: readonly OrgMcpFolder[]): OrgMcpServer[] {
  const byUrl = new Map<string, OrgMcpServer>();
  for (const folder of folders) {
    const url = `${folder.origin}/api/extension/repositories/${encodeURIComponent(folder.repoUlid)}/mcp`;
    if (!byUrl.has(url)) byUrl.set(url, { label: S.orgMcpLabel(folder.name), url, version: folder.canEdit ? 'edit' : 'read' });
  }
  return [...byUrl.values()];
}
