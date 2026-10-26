import { defineConfig } from '@vscode/test-cli';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each run gets its own copy of a fixture. A developer's F5 session on the
// fixture writes there (the extension saves notes as you type), and the tests
// write there too; on a shared directory the two corrupt each other. The copy
// also keeps the checked-in fixtures exactly as committed.
function copyOf(fixture) {
  const dir = mkdtempSync(join(tmpdir(), `depos-${fixture}-`));
  cpSync(join('fixtures', fixture), dir, { recursive: true });
  return dir;
}

const mocha = { ui: 'tdd', timeout: 30000 };

export default defineConfig([
  {
    label: 'single',
    files: 'dist-test/test/integration/*.test.js',
    workspaceFolder: copyOf('single'),
    mocha,
  },
  {
    label: 'monorepo',
    files: 'dist-test/test/integration/monorepo/*.test.js',
    workspaceFolder: copyOf('monorepo'),
    mocha,
  },
]);
