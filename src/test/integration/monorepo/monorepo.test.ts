import * as assert from 'assert';
import * as vscode from 'vscode';

// Runs in a copy of fixtures/monorepo: npm, Mix, Gleam, Zig, Python, Ruby and Composer manifests with
// nested notes files, plus downloaded/cache manifests discovery must ignore.

function at(...parts: string[]): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders![0]!;
  return vscode.Uri.joinPath(folder.uri, ...parts);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function poll<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 8000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() - start > timeoutMs) throw new Error('poll timeout');
    await sleep(100);
  }
}

async function readText(uri: vscode.Uri): Promise<string> {
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Depos' hover text for one dependency of one package.json ('' when silent). */
async function hoverText(pkg: vscode.Uri, dep: string): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(pkg);
  await vscode.window.showTextDocument(doc);
  const offset = doc.getText().indexOf(`"${dep}"`);
  assert.ok(offset > 0, `${dep} is not in ${pkg.path}`);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    pkg,
    doc.positionAt(offset + 2),
  );
  return (hovers ?? [])
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : c.value))
    .join('\n');
}

async function mixHoverText(manifest: vscode.Uri, dep: string): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(manifest);
  await vscode.window.showTextDocument(doc);
  const offset = doc.getText().indexOf(`:${dep}`);
  assert.ok(offset > 0, `${dep} is not in ${manifest.path}`);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    manifest,
    doc.positionAt(offset + 2),
  );
  return (hovers ?? [])
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : c.value))
    .join('\n');
}

async function gleamHoverText(manifest: vscode.Uri, dep: string): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(manifest);
  await vscode.window.showTextDocument(doc);
  const offset = doc.getText().indexOf(dep);
  assert.ok(offset >= 0, `${dep} is not in ${manifest.path}`);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    manifest,
    doc.positionAt(offset + 2),
  );
  return (hovers ?? []).flatMap((hover) => hover.contents)
    .map((content) => typeof content === 'string' ? content : content.value).join('\n');
}

async function zigHoverText(manifest: vscode.Uri, dep: string): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(manifest);
  await vscode.window.showTextDocument(doc);
  const offset = doc.getText().indexOf(`.${dep}`);
  assert.ok(offset > 0, `${dep} is not in ${manifest.path}`);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    manifest,
    doc.positionAt(offset + 2),
  );
  return (hovers ?? [])
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : c.value))
    .join('\n');
}

async function pythonHoverText(manifest: vscode.Uri, dep: string): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(manifest);
  await vscode.window.showTextDocument(doc);
  const offset = doc.getText().indexOf(dep);
  assert.ok(offset >= 0, `${dep} is not in ${manifest.path}`);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    manifest,
    doc.positionAt(offset + 2),
  );
  return (hovers ?? []).flatMap((hover) => hover.contents)
    .map((content) => typeof content === 'string' ? content : content.value).join('\n');
}

async function nugetHoverText(manifest: vscode.Uri, dep: string): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(manifest);
  await vscode.window.showTextDocument(doc);
  const offset = doc.getText().indexOf(`"${dep}"`);
  assert.ok(offset >= 0, `${dep} is not in ${manifest.path}`);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    manifest,
    doc.positionAt(offset + 2),
  );
  return (hovers ?? []).flatMap((hover) => hover.contents)
    .map((content) => typeof content === 'string' ? content : content.value).join('\n');
}

async function goHoverText(manifest: vscode.Uri, dep: string): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(manifest);
  await vscode.window.showTextDocument(doc);
  const offset = doc.getText().indexOf(dep);
  assert.ok(offset >= 0, `${dep} is not in ${manifest.path}`);
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    manifest,
    doc.positionAt(offset + 2),
  );
  return (hovers ?? []).flatMap((hover) => hover.contents)
    .map((content) => typeof content === 'string' ? content : content.value).join('\n');
}

const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('depos');

suite('depos monorepo', () => {
  suiteSetup(async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension('kontra.pacmon');
    assert.ok(ext, 'extension not found');
    await ext.activate();
    await cfg().update('noteEntry', 'input', vscode.ConfigurationTarget.Global);
    await cfg().update('monorepo', undefined, vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    await cfg().update('monorepo', undefined, vscode.ConfigurationTarget.Global);
    try {
      await vscode.workspace.fs.delete(at('.pacmon', 'AGENT-RULES.md'));
    } catch {
      // not there
    }
  });

  test('the nearest .pacmon/DEPENDENCY-NOTES.md wins for a nested package.json', async function () {
    this.timeout(15000);
    const text = await poll(async () => {
      const t = await hoverText(at('packages', 'app', 'package.json'), 'express');
      return t.includes('App-level note') ? t : undefined;
    });
    assert.ok(text.includes('App-level note: nearest file wins.'), text);
    assert.ok(!text.includes('Root-level'), 'the root file must not leak into the nested package');
  });

  test('the root package.json reads the root notes', async function () {
    this.timeout(15000);
    const text = await poll(async () => {
      const t = await hoverText(at('package.json'), 'turbo-fake');
      return t.includes('Root-level') ? t : undefined;
    });
    assert.ok(text.includes('Root-level tooling note.'), text);
  });

  test('Mix umbrella children resolve their nearest shared or child notes', async function () {
    this.timeout(20000);
    const accounts = await poll(async () => {
      const text = await mixHoverText(at('apps', 'accounts', 'mix.exs'), 'ecto_sql');
      return text.includes('Root umbrella database note') ? text : undefined;
    });
    assert.ok(accounts.includes('.pacmon/mix/DEPENDENCY-NOTES.md'), accounts);

    const web = await poll(async () => {
      const text = await mixHoverText(at('apps', 'web', 'mix.exs'), 'phoenix');
      return text.includes('Web child note') ? text : undefined;
    });
    assert.ok(web.includes('Web child note: nearest Mix file wins.'), web);
    assert.ok(!web.includes('Root umbrella web note'), 'the root Mix note must not leak into the web child');
  });

  test('a nested Gleam manifest uses its nearest Gleam notes', async function () {
    this.timeout(20000);
    const text = await poll(async () => {
      const value = await gleamHoverText(at('apps', 'gleam-app', 'gleam.toml'), 'shared_gleam');
      return value.includes('Nested Gleam note') ? value : undefined;
    });
    assert.ok(text.includes('.pacmon/gleam/DEPENDENCY-NOTES.md'), text);
    assert.ok(!text.includes('Root Gleam note'), 'the root Gleam note must not leak into the nested project');
  });

  test('a nested Zig manifest uses its nearest Zig notes', async function () {
    this.timeout(20000);
    const text = await poll(async () => {
      const value = await zigHoverText(at('apps', 'zig-app', 'build.zig.zon'), 'shared_zig');
      return value.includes('Nested Zig note') ? value : undefined;
    });
    assert.ok(text.includes('.pacmon/zig/DEPENDENCY-NOTES.md'), text);
    assert.ok(!text.includes('Root Zig note'), 'the root Zig note must not leak into the nested project');
  });

  test('Python pyproject and split requirements use their nearest shared notes', async function () {
    this.timeout(20000);
    const pyproject = await pythonHoverText(at('apps', 'python-app', 'pyproject.toml'), 'shared_python');
    assert.ok(pyproject.includes('Nested Python note'), pyproject);
    const requirements = await pythonHoverText(at('apps', 'python-app', 'requirements', 'dev.txt'), 'ruff');
    assert.ok(requirements.includes('Python linting and formatting'), requirements);
  });

  test('.NET projects and central manifests use their nearest NuGet notes', async function () {
    this.timeout(20000);
    for (const manifest of [
      at('apps', 'dotnet-app', 'App.csproj'),
      at('apps', 'dotnet-app', 'Directory.Packages.props'),
    ]) {
      const text = await poll(async () => {
        const value = await nugetHoverText(manifest, 'Nested.Package');
        return value.includes('Nested central NuGet note') ? value : undefined;
      });
      assert.ok(text.includes('.pacmon/nuget/DEPENDENCY-NOTES.md'), text);
      assert.ok(!text.includes('Root-level NuGet note'), 'root NuGet notes must not leak into the nested project');
    }
  });

  test('a first nested .NET note is created beside the nearest Directory.Packages.props', async function () {
    this.timeout(20000);
    const nestedNotes = at('apps', 'dotnet-app', '.pacmon', 'nuget', 'DEPENDENCY-NOTES.md');
    const rootNotes = at('.pacmon', 'nuget', 'DEPENDENCY-NOTES.md');
    const originalNested = await vscode.workspace.fs.readFile(nestedNotes);
    const originalRoot = await vscode.workspace.fs.readFile(rootNotes);
    try {
      await vscode.workspace.fs.delete(nestedNotes);
      await vscode.workspace.fs.delete(rootNotes);
      await sleep(500);
      const manifest = at('apps', 'dotnet-app', 'App.csproj');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manifest));
      await vscode.commands.executeCommand('depos.addOrEditNote', 'New.Package', 'Nested package note.');
      const text = await poll(async () => {
        try {
          const value = await readText(nestedNotes);
          return value.includes('## New.Package') ? value : undefined;
        } catch {
          return undefined;
        }
      });
      assert.ok(text.includes('ecosystem: nuget'));
      assert.strictEqual(await exists(rootNotes), false, 'root NuGet notes must not be created');
    } finally {
      await vscode.workspace.fs.writeFile(nestedNotes, originalNested);
      await vscode.workspace.fs.writeFile(rootNotes, originalRoot);
    }
  });

  test('bin and obj .NET manifests are excluded from note dependency discovery', async function () {
    this.timeout(15000);
    const notes = at('apps', 'dotnet-app', '.pacmon', 'nuget', 'DEPENDENCY-NOTES.md');
    const doc = await vscode.workspace.openTextDocument(notes);
    const editor = await vscode.window.showTextDocument(doc);
    const ecosystemLine = doc.getText().split(/\r?\n/).findIndex((line) => line === 'ecosystem: nuget');
    assert.ok(ecosystemLine > 0, 'fixture changed: no NuGet ecosystem line');
    await editor.edit((edit) => edit.replace(doc.lineAt(ecosystemLine).range, 'ecosystem: cargo'));
    try {
      const mine = await poll(() => {
        const diagnostics = vscode.languages.getDiagnostics(notes).filter((item) => item.source === 'depos');
        return diagnostics.some((item) => item.code === 'wrong-ecosystem') ? diagnostics : undefined;
      });
      assert.ok(
        !mine.some((item) => item.code === 'removed-but-present'),
        'a dependency found only under obj must not count as a project dependency',
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  test('a nested Go module uses its nearest Go notes', async function () {
    this.timeout(20000);
    const text = await poll(async () => {
      const value = await goHoverText(at('apps', 'go-app', 'go.mod'), 'github.com/example/shared-go');
      return value.includes('Nested Go note') ? value : undefined;
    });
    assert.ok(text.includes('.pacmon/go/DEPENDENCY-NOTES.md'), text);
    assert.ok(!text.includes('Root Go note'), 'the root Go note must not leak into the nested module');
  });

  test('a nested Composer manifest uses its nearest Composer notes', async function () {
    this.timeout(20000);
    const text = await poll(async () => {
      const value = await hoverText(at('apps', 'php-app', 'composer.json'), 'acme/shared-composer');
      return value.includes('Nested Composer note') ? value : undefined;
    });
    assert.ok(text.includes('.pacmon/composer/DEPENDENCY-NOTES.md'), text);
    assert.ok(!text.includes('Root Composer note'), 'the root Composer note must not leak into the nested project');
  });

  test('nested Gemfile and gemspec manifests use their nearest shared Ruby notes', async function () {
    this.timeout(20000);
    for (const [manifestName, dependency, expected] of [
      ['Gemfile', 'shared-ruby', 'Nested Ruby note'],
      ['nested.gemspec', 'nested-runtime', 'Nested gemspec runtime note'],
    ] as const) {
      const text = await poll(async () => {
        const value = await hoverText(at('apps', 'ruby-app', manifestName), dependency);
        return value.includes(expected) ? value : undefined;
      });
      assert.ok(text.includes('.pacmon/ruby/DEPENDENCY-NOTES.md'), text);
      assert.ok(!text.includes('Root Ruby note'), 'root Ruby notes must not leak into the nested project');
    }
  });

  test('nested vcpkg and Conan manifests use separate nearest notes', async function () {
    this.timeout(20000);
    for (const [manifestName, dependency, expected, other] of [
      ['vcpkg.json', 'shared-vcpkg', 'Nested vcpkg note', 'Nested Conan note'],
      ['conanfile.txt', 'shared-conan', 'Nested Conan note', 'Nested vcpkg note'],
    ] as const) {
      const text = await poll(async () => {
        const value = await pythonHoverText(at('apps', 'cpp-app', manifestName), dependency);
        return value.includes(expected) ? value : undefined;
      });
      assert.ok(!text.includes(other), `${manifestName} must not read the other C/C++ ecosystem notes`);
      assert.ok(!text.includes(`Root ${manifestName === 'vcpkg.json' ? 'vcpkg' : 'Conan'} note`));
    }
  });

  test('depos.monorepo = rootOnly ignores the nested notes file', async function () {
    this.timeout(20000);
    await cfg().update('monorepo', 'rootOnly', vscode.ConfigurationTarget.Global);
    try {
      // The root file has no express section, so the hover falls silent.
      const text = await poll(async () => {
        const t = await hoverText(at('packages', 'app', 'package.json'), 'express');
        return t.includes('App-level') ? undefined : t;
      });
      assert.ok(!text.includes('command:depos.') && !text.includes('Edit note'), `expected silence, got: ${text}`);
    } finally {
      await cfg().update('monorepo', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('pacmon.monorepo, from before Pacmon became Depos, is still read; depos.monorepo wins', async function () {
    this.timeout(20000);
    const legacy = vscode.workspace.getConfiguration('pacmon');
    await legacy.update('monorepo', 'rootOnly', vscode.ConfigurationTarget.Global);
    try {
      const silent = await poll(async () => {
        const t = await hoverText(at('packages', 'app', 'package.json'), 'express');
        return t.includes('App-level') ? undefined : t;
      });
      assert.ok(!silent.includes('Edit note'), `expected silence, got: ${silent}`);
      await cfg().update('monorepo', 'nearest', vscode.ConfigurationTarget.Global);
      await poll(async () => {
        const t = await hoverText(at('packages', 'app', 'package.json'), 'express');
        return t.includes('App-level') ? t : undefined;
      });
    } finally {
      await legacy.update('monorepo', undefined, vscode.ConfigurationTarget.Global);
      await cfg().update('monorepo', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('depos.monorepo = rootOnly makes an umbrella child use root Mix notes', async function () {
    this.timeout(20000);
    await cfg().update('monorepo', 'rootOnly', vscode.ConfigurationTarget.Global);
    try {
      const text = await poll(async () => {
        const value = await mixHoverText(at('apps', 'web', 'mix.exs'), 'phoenix');
        return value.includes('Root umbrella web note') ? value : undefined;
      });
      assert.ok(!text.includes('Web child note'), 'rootOnly must ignore the child Mix notes file');
    } finally {
      await cfg().update('monorepo', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('depos.monorepo = rootOnly makes a nested Gleam manifest use root Gleam notes', async function () {
    this.timeout(20000);
    await cfg().update('monorepo', 'rootOnly', vscode.ConfigurationTarget.Global);
    try {
      const text = await poll(async () => {
        const value = await gleamHoverText(at('apps', 'gleam-app', 'gleam.toml'), 'shared_gleam');
        return value.includes('Root Gleam note') ? value : undefined;
      });
      assert.ok(!text.includes('Nested Gleam note'), 'rootOnly must ignore the child Gleam notes file');
    } finally {
      await cfg().update('monorepo', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('depos.monorepo = rootOnly makes a nested Zig manifest use root Zig notes', async function () {
    this.timeout(20000);
    await cfg().update('monorepo', 'rootOnly', vscode.ConfigurationTarget.Global);
    try {
      const text = await poll(async () => {
        const value = await zigHoverText(at('apps', 'zig-app', 'build.zig.zon'), 'shared_zig');
        return value.includes('Root Zig note') ? value : undefined;
      });
      assert.ok(!text.includes('Nested Zig note'), 'rootOnly must ignore the child Zig notes file');
    } finally {
      await cfg().update('monorepo', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('depos.monorepo = rootOnly makes a nested Python manifest use root Python notes', async function () {
    this.timeout(20000);
    await cfg().update('monorepo', 'rootOnly', vscode.ConfigurationTarget.Global);
    try {
      const text = await poll(async () => {
        const value = await pythonHoverText(at('apps', 'python-app', 'pyproject.toml'), 'shared_python');
        return value.includes('Root Python note') ? value : undefined;
      });
      assert.ok(!text.includes('Nested Python note'), 'rootOnly must ignore the child Python notes file');
    } finally {
      await cfg().update('monorepo', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('depos.monorepo = rootOnly makes a nested Go module use root Go notes', async function () {
    this.timeout(20000);
    await cfg().update('monorepo', 'rootOnly', vscode.ConfigurationTarget.Global);
    try {
      const text = await poll(async () => {
        const value = await goHoverText(at('apps', 'go-app', 'go.mod'), 'github.com/example/shared-go');
        return value.includes('Root Go note') ? value : undefined;
      });
      assert.ok(!text.includes('Nested Go note'), 'rootOnly must ignore the child Go notes file');
    } finally {
      await cfg().update('monorepo', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('depos.monorepo = rootOnly makes a nested Composer manifest use root Composer notes', async function () {
    this.timeout(20000);
    await cfg().update('monorepo', 'rootOnly', vscode.ConfigurationTarget.Global);
    try {
      const text = await poll(async () => {
        const value = await hoverText(at('apps', 'php-app', 'composer.json'), 'acme/shared-composer');
        return value.includes('Root Composer note') ? value : undefined;
      });
      assert.ok(!text.includes('Nested Composer note'), 'rootOnly must ignore the child Composer notes file');
    } finally {
      await cfg().update('monorepo', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('depos.monorepo = rootOnly makes nested Ruby manifests use root Ruby notes', async function () {
    this.timeout(20000);
    await cfg().update('monorepo', 'rootOnly', vscode.ConfigurationTarget.Global);
    try {
      const text = await poll(async () => {
        const value = await hoverText(at('apps', 'ruby-app', 'Gemfile'), 'shared-ruby');
        return value.includes('Root Ruby note') ? value : undefined;
      });
      assert.ok(!text.includes('Nested Ruby note'), 'rootOnly must ignore the nested Ruby notes file');
    } finally {
      await cfg().update('monorepo', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('depos.monorepo = rootOnly makes nested C/C++ manifests use their matching root notes', async function () {
    this.timeout(20000);
    await cfg().update('monorepo', 'rootOnly', vscode.ConfigurationTarget.Global);
    try {
      for (const [manifestName, dependency, expected] of [
        ['vcpkg.json', 'shared-vcpkg', 'Root vcpkg note'],
        ['conanfile.txt', 'shared-conan', 'Root Conan note'],
      ] as const) {
        const text = await poll(async () => {
          const value = await pythonHoverText(at('apps', 'cpp-app', manifestName), dependency);
          return value.includes(expected) ? value : undefined;
        });
        assert.ok(!text.includes('Nested'), `${manifestName} must ignore its nested notes in rootOnly mode`);
      }
    } finally {
      await cfg().update('monorepo', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('Go vendor manifests are excluded from note dependency discovery', async function () {
    this.timeout(15000);
    const notes = at('.pacmon', 'go', 'DEPENDENCY-NOTES.md');
    const doc = await vscode.workspace.openTextDocument(notes);
    const editor = await vscode.window.showTextDocument(doc);
    const ecosystemLine = doc.getText().split(/\r?\n/).findIndex((line) => line === 'ecosystem: go');
    assert.ok(ecosystemLine > 0, 'fixture changed: no Go ecosystem line');
    await editor.edit((edit) => edit.replace(doc.lineAt(ecosystemLine).range, 'ecosystem: cargo'));
    try {
      const mine = await poll(() => {
        const diagnostics = vscode.languages.getDiagnostics(notes).filter((item) => item.source === 'depos');
        return diagnostics.some((item) => item.code === 'wrong-ecosystem') ? diagnostics : undefined;
      });
      assert.ok(
        !mine.some((item) => item.code === 'removed-but-present'),
        'a dependency found only under vendor/ must not count as a project dependency',
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  test('Composer vendor manifests are excluded from note dependency discovery', async function () {
    this.timeout(15000);
    const notes = at('.pacmon', 'composer', 'DEPENDENCY-NOTES.md');
    const doc = await vscode.workspace.openTextDocument(notes);
    const editor = await vscode.window.showTextDocument(doc);
    const ecosystemLine = doc.getText().split(/\r?\n/).findIndex((line) => line === 'ecosystem: composer');
    assert.ok(ecosystemLine > 0, 'fixture changed: no Composer ecosystem line');
    await editor.edit((edit) => edit.replace(doc.lineAt(ecosystemLine).range, 'ecosystem: cargo'));
    try {
      const mine = await poll(() => {
        const diagnostics = vscode.languages.getDiagnostics(notes).filter((item) => item.source === 'depos');
        return diagnostics.some((item) => item.code === 'wrong-ecosystem') ? diagnostics : undefined;
      });
      assert.ok(
        !mine.some((item) => item.code === 'removed-but-present'),
        'a dependency found only under vendor/ must not count as a project dependency',
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  test('Ruby vendor manifests are excluded from note dependency discovery', async function () {
    this.timeout(15000);
    const notes = at('.pacmon', 'ruby', 'DEPENDENCY-NOTES.md');
    const doc = await vscode.workspace.openTextDocument(notes);
    const editor = await vscode.window.showTextDocument(doc);
    const ecosystemLine = doc.getText().split(/\r?\n/).findIndex((line) => line === 'ecosystem: ruby');
    assert.ok(ecosystemLine > 0, 'fixture changed: no Ruby ecosystem line');
    await editor.edit((edit) => edit.replace(doc.lineAt(ecosystemLine).range, 'ecosystem: cargo'));
    try {
      const mine = await poll(() => {
        const diagnostics = vscode.languages.getDiagnostics(notes).filter((item) => item.source === 'depos');
        return diagnostics.some((item) => item.code === 'wrong-ecosystem') ? diagnostics : undefined;
      });
      assert.ok(
        !mine.some((item) => item.code === 'removed-but-present'),
        'a dependency found only under vendor/ must not count as a Ruby project dependency',
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  test('Zig package-cache manifests are excluded from note dependency discovery', async function () {
    this.timeout(15000);
    const notes = at('.pacmon', 'zig', 'DEPENDENCY-NOTES.md');
    const doc = await vscode.workspace.openTextDocument(notes);
    const editor = await vscode.window.showTextDocument(doc);
    const ecosystemLine = doc.getText().split(/\r?\n/).findIndex((line) => line === 'ecosystem: zig');
    assert.ok(ecosystemLine > 0, 'fixture changed: no Zig ecosystem line');
    await editor.edit((edit) => edit.replace(doc.lineAt(ecosystemLine).range, 'ecosystem: cargo'));
    try {
      const mine = await poll(() => {
        const diagnostics = vscode.languages.getDiagnostics(notes).filter((item) => item.source === 'depos');
        return diagnostics.some((item) => item.code === 'wrong-ecosystem') ? diagnostics : undefined;
      });
      assert.ok(
        !mine.some((item) => item.code === 'removed-but-present'),
        'a dependency found only under zig-pkg must not count as a project dependency',
      );
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  test('a new note for a nested package lands in its own .pacmon/; the agent rules land once, at the root', async function () {
    this.timeout(20000);
    const appNotes = at('packages', 'app', '.pacmon', 'DEPENDENCY-NOTES.md');
    const rootNotes = at('.pacmon', 'DEPENDENCY-NOTES.md');
    const originalApp = await vscode.workspace.fs.readFile(appNotes);
    const originalRoot = await vscode.workspace.fs.readFile(rootNotes);
    try {
      const pkg = at('packages', 'app', 'package.json');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(pkg));
      await vscode.commands.executeCommand('depos.addOrEditNote', 'react-fake', 'UI runtime (fake)');

      const text = await poll(async () => {
        const t = await readText(appNotes);
        return t.includes('## react-fake') ? t : undefined;
      });
      assert.ok(text.includes('UI runtime (fake)'), 'body missing in the nested notes file');
      assert.ok(text.indexOf('## express') < text.indexOf('## react-fake'), 'sections stay sorted');
      assert.ok(!(await readText(rootNotes)).includes('react-fake'), 'the root notes must stay untouched');

      const rules = await poll(async () => (await exists(at('.pacmon', 'AGENT-RULES.md')) ? await readText(at('.pacmon', 'AGENT-RULES.md')) : undefined));
      assert.ok(rules.includes('### Agent notes'), 'AGENT-RULES.md should be the rules file');
      assert.strictEqual(await exists(at('packages', 'app', '.pacmon', 'AGENT-RULES.md')), false, 'AGENT-RULES.md exists once, at the root');
    } finally {
      await vscode.workspace.fs.writeFile(appNotes, originalApp);
      await vscode.workspace.fs.writeFile(rootNotes, originalRoot);
    }
  });
});
