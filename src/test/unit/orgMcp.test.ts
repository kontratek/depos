import { describe, expect, it } from 'vitest';
import { mcpServersFor } from '../../ext/web/orgMcpServers';

/** Org mode, "Agents" (docs/format.md): one MCP server of Depos per repository. */

const REPO = 'R'.repeat(26);

describe('mcpServersFor', () => {
  it('gives each folder in org mode the server of its repository', () => {
    expect(mcpServersFor([{ name: 'api', origin: 'https://depos.example.com', repoUlid: REPO, canEdit: false }])).toEqual([
      {
        label: 'Depos org notes (api)',
        url: `https://depos.example.com/api/extension/repositories/${REPO}/mcp`,
        version: 'read',
      },
    ]);
  });

  it('changes the version with the right to write, so the editor refreshes the tools', () => {
    expect(mcpServersFor([{ name: 'api', origin: 'http://localhost:3000', repoUlid: REPO, canEdit: true }])[0]?.version).toBe('edit');
  });

  it('gives two folders of one repository one server, and none without folders', () => {
    const folder = { origin: 'http://localhost:3000', repoUlid: REPO, canEdit: true };
    expect(mcpServersFor([{ ...folder, name: 'a' }, { ...folder, name: 'b' }])).toHaveLength(1);
    expect(mcpServersFor([])).toEqual([]);
  });
});
