import * as assert from 'assert';
import * as vscode from 'vscode';

function fixtureUri(...parts: string[]): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders![0]!;
  return vscode.Uri.joinPath(folder.uri, ...parts);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function poll<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 5000,
): Promise<T> {
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

suite('depos integration', () => {
  suiteSetup(async function () {
    this.timeout(30000);
    const ext = vscode.extensions.getExtension('kontra.pacmon');
    assert.ok(ext, 'extension not found');
    await ext.activate();
    // The default "panel" entry opens UI whose contents automated tests cannot
    // reach; pin the deterministic input mode for the note-writing tests
    // (isolated test profile — no user impact). The panel gets its own test.
    await vscode.workspace
      .getConfiguration('depos')
      .update('noteEntry', 'input', vscode.ConfigurationTarget.Global);
  });

  suiteTeardown(async () => {
    // Every note write brings .pacmon/AGENT-RULES.md along; keep the fixture clean.
    try {
      await vscode.workspace.fs.delete(fixtureUri('.pacmon', 'AGENT-RULES.md'));
    } catch {
      // not there
    }
  });

  test('hover on a documented dependency shows the note', async () => {
    const pkg = fixtureUri('package.json');
    const doc = await vscode.workspace.openTextDocument(pkg);
    await vscode.window.showTextDocument(doc);
    const offset = doc.getText().indexOf('"express"');
    assert.ok(offset > 0);
    const pos = doc.positionAt(offset + 2);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      pkg,
      pos,
    );
    const all = (hovers ?? [])
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === 'string' ? c : c.value))
      .join('\n');
    assert.ok(all.includes('HTTP API layer'), `hover missing note, got: ${all}`);
    assert.ok(all.includes('Edit note'), 'hover missing edit link');
    // Both layers, human first by default, a rule between them.
    const human = all.indexOf('HTTP API layer');
    const agent = all.indexOf('- purpose:');
    assert.ok(agent > -1, `hover should carry the agent block too, got: ${all}`);
    assert.ok(human < agent, 'human text leads with the default inlineSource');
    assert.ok(all.slice(human, agent).includes('---'), 'a rule separates the layers');
  });

  test('hover on an undocumented dependency stays silent', async () => {
    const pkg = fixtureUri('package.json');
    const doc = await vscode.workspace.openTextDocument(pkg);
    // helmet is in package.json and deliberately has no section in the fixture.
    const offset = doc.getText().indexOf('"helmet"');
    const pos = doc.positionAt(offset + 2);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      pkg,
      pos,
    );
    const ours = (hovers ?? [])
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === 'string' ? c : c.value))
      .join('\n');
    assert.ok(
      !ours.includes('command:depos.') && !ours.includes('Edit note'),
      `expected silence, got: ${ours}`,
    );
  });

  test('Cargo.toml dependencies use the Cargo notes namespace', async () => {
    const manifest = fixtureUri('Cargo.toml');
    const doc = await vscode.workspace.openTextDocument(manifest);
    await vscode.window.showTextDocument(doc);
    const offset = doc.getText().indexOf('serde');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      manifest,
      doc.positionAt(offset + 1),
    );
    const text = (hovers ?? []).flatMap((hover) => hover.contents)
      .map((content) => typeof content === 'string' ? content : content.value).join('\n');
    assert.ok(text.includes('Serialization layer'), `Cargo note missing, got: ${text}`);
    assert.ok(text.includes('.pacmon/cargo/DEPENDENCY-NOTES.md'));
  });

  test('Cargo notes validate their ecosystem and open their Cargo manifest', async function () {
    this.timeout(15000);
    const notes = fixtureUri('.pacmon', 'cargo', 'DEPENDENCY-NOTES.md');
    const doc = await vscode.workspace.openTextDocument(notes);
    const editor = await vscode.window.showTextDocument(doc);
    const line = doc.getText().split(/\r?\n/).findIndex((value) => value === 'ecosystem: cargo');
    assert.ok(line > 0);
    await editor.edit((edit) => edit.replace(doc.lineAt(line).range, 'ecosystem: maven'));
    try {
      const diagnostics = await poll(() => {
        const mine = vscode.languages.getDiagnostics(notes).filter((item) => item.source === 'depos');
        return mine.some((item) => item.code === 'wrong-ecosystem') ? mine : undefined;
      });
      assert.ok(diagnostics.some((item) => item.code === 'wrong-ecosystem'));
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    await vscode.commands.executeCommand('depos.openManifest');
    await poll(() => vscode.window.activeTextEditor?.document.uri.path.endsWith('/Cargo.toml') ? true : undefined);
  });

  test('pom.xml groupId and artifactId both open the Maven note', async () => {
    const manifest = fixtureUri('pom.xml');
    const doc = await vscode.workspace.openTextDocument(manifest);
    await vscode.window.showTextDocument(doc);
    for (const token of ['org.slf4j', 'slf4j-api']) {
      const offset = doc.getText().indexOf(token);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        manifest,
        doc.positionAt(offset + 1),
      );
      const text = (hovers ?? []).flatMap((hover) => hover.contents)
        .map((content) => typeof content === 'string' ? content : content.value).join('\n');
      assert.ok(text.includes('Logging facade'), `Maven note missing on ${token}, got: ${text}`);
    }
  });

  test('Gradle coordinates and catalog aliases use the Gradle notes namespace', async () => {
    const manifest = fixtureUri('build.gradle.kts');
    const doc = await vscode.workspace.openTextDocument(manifest);
    await vscode.window.showTextDocument(doc);
    for (const token of ['slf4j-api', 'libs.junit.jupiter']) {
      const offset = doc.getText().indexOf(token);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        manifest,
        doc.positionAt(offset + 1),
      );
      const text = (hovers ?? []).flatMap((hover) => hover.contents)
        .map((content) => typeof content === 'string' ? content : content.value).join('\n');
      assert.ok(text.includes('.pacmon/gradle/DEPENDENCY-NOTES.md'), `Gradle path missing on ${token}: ${text}`);
    }
  });

  test('mix.exs atoms use the Mix notes namespace', async () => {
    const manifest = fixtureUri('mix.exs');
    const doc = await vscode.workspace.openTextDocument(manifest);
    await vscode.window.showTextDocument(doc);
    const offset = doc.getText().indexOf(':phoenix');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      manifest,
      doc.positionAt(offset + 2),
    );
    const text = (hovers ?? []).flatMap((hover) => hover.contents)
      .map((content) => typeof content === 'string' ? content : content.value).join('\n');
    assert.ok(text.includes('HTTP and realtime application framework'), `Mix note missing, got: ${text}`);
    assert.ok(text.includes('.pacmon/mix/DEPENDENCY-NOTES.md'));
  });

  test('gleam.toml keys use the Gleam notes namespace', async () => {
    const manifest = fixtureUri('gleam.toml');
    const doc = await vscode.workspace.openTextDocument(manifest);
    await vscode.window.showTextDocument(doc);
    const offset = doc.getText().indexOf('gleam_stdlib');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      manifest,
      doc.positionAt(offset + 2),
    );
    const text = (hovers ?? []).flatMap((hover) => hover.contents)
      .map((content) => typeof content === 'string' ? content : content.value).join('\n');
    assert.ok(text.includes('Core Gleam standard library'), `Gleam note missing, got: ${text}`);
    assert.ok(text.includes('.pacmon/gleam/DEPENDENCY-NOTES.md'));
  });

  test('composer.json requirements use the Composer notes namespace', async () => {
    const manifest = fixtureUri('composer.json');
    const doc = await vscode.workspace.openTextDocument(manifest);
    await vscode.window.showTextDocument(doc);
    const offset = doc.getText().indexOf('monolog/monolog');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      manifest,
      doc.positionAt(offset + 2),
    );
    const text = (hovers ?? []).flatMap((hover) => hover.contents)
      .map((content) => typeof content === 'string' ? content : content.value).join('\n');
    assert.ok(text.includes('Structured logging for the PHP fixture'), `Composer note missing, got: ${text}`);
    assert.ok(text.includes('.pacmon/composer/DEPENDENCY-NOTES.md'));
  });

  test('build.zig.zon fields use the Zig notes namespace', async () => {
    const manifest = fixtureUri('build.zig.zon');
    const doc = await vscode.workspace.openTextDocument(manifest);
    await vscode.window.showTextDocument(doc);
    const offset = doc.getText().indexOf('.known_folders');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      manifest,
      doc.positionAt(offset + 2),
    );
    const text = (hovers ?? []).flatMap((hover) => hover.contents)
      .map((content) => typeof content === 'string' ? content : content.value).join('\n');
    assert.ok(text.includes('Cross-platform user directory discovery'), `Zig note missing, got: ${text}`);
    assert.ok(text.includes('.pacmon/zig/DEPENDENCY-NOTES.md'));
  });

  test('pyproject.toml requirements use canonical Python notes', async () => {
    const manifest = fixtureUri('pyproject.toml');
    const doc = await vscode.workspace.openTextDocument(manifest);
    await vscode.window.showTextDocument(doc);
    const offset = doc.getText().indexOf('requests>=');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      manifest,
      doc.positionAt(offset + 2),
    );
    const text = (hovers ?? []).flatMap((hover) => hover.contents)
      .map((content) => typeof content === 'string' ? content : content.value).join('\n');
    assert.ok(text.includes('HTTP client used by the Python fixture'), `Python note missing, got: ${text}`);
    assert.ok(text.includes('.pacmon/python/DEPENDENCY-NOTES.md'));
  });

  test('split requirements files share project Python notes and open pyproject first', async () => {
    const manifest = fixtureUri('requirements', 'dev.txt');
    const doc = await vscode.workspace.openTextDocument(manifest);
    await vscode.window.showTextDocument(doc);
    const offset = doc.getText().indexOf('pytest-cov');
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      'vscode.executeHoverProvider',
      manifest,
      doc.positionAt(offset + 2),
    );
    const text = (hovers ?? []).flatMap((hover) => hover.contents)
      .map((content) => typeof content === 'string' ? content : content.value).join('\n');
    assert.ok(text.includes('Coverage reporting for Python tests'), `requirements note missing, got: ${text}`);

    const notes = fixtureUri('.pacmon', 'python', 'DEPENDENCY-NOTES.md');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(notes));
    await vscode.commands.executeCommand('depos.openManifest');
    await poll(() => vscode.window.activeTextEditor?.document.uri.path.endsWith('/pyproject.toml') ? true : undefined);
  });

  test('Gemfile and gemspec dependencies share the Ruby notes namespace', async () => {
    for (const [manifestName, dependency, expected] of [
      ['Gemfile', 'rack', 'Rack interface used by the Ruby fixture'],
      ['pacmon-fixture.gemspec', 'zeitwerk', 'Code loader declared by the fixture gemspec'],
    ] as const) {
      const manifest = fixtureUri(manifestName);
      const doc = await vscode.workspace.openTextDocument(manifest);
      await vscode.window.showTextDocument(doc);
      const offset = doc.getText().indexOf(`"${dependency}"`);
      assert.ok(offset >= 0, `${dependency} missing from ${manifestName}`);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        manifest,
        doc.positionAt(offset + 2),
      );
      const text = (hovers ?? []).flatMap((hover) => hover.contents)
        .map((content) => typeof content === 'string' ? content : content.value).join('\n');
      assert.ok(text.includes(expected), `Ruby note missing for ${dependency}: ${text}`);
      assert.ok(text.includes('.pacmon/ruby/DEPENDENCY-NOTES.md'));
    }
  });

  test('Ruby notes aggregate gemspec dependencies and open Gemfile first', async function () {
    this.timeout(15000);
    const notes = fixtureUri('.pacmon', 'ruby', 'DEPENDENCY-NOTES.md');
    const doc = await vscode.workspace.openTextDocument(notes);
    const editor = await vscode.window.showTextDocument(doc);
    const zeitwerk = doc.getText().indexOf('Code loader declared by the fixture gemspec.');
    assert.ok(zeitwerk > 0);
    await editor.edit((edit) => edit.insert(doc.positionAt(zeitwerk + 'Code loader declared by the fixture gemspec.'.length),
      '\n\n### Agent notes\n\n- status: removed 2026-09 - test'));
    try {
      const diagnostics = await poll(() => {
        const mine = vscode.languages.getDiagnostics(notes).filter((item) => item.source === 'depos');
        return mine.some((item) => item.code === 'removed-but-present') ? mine : undefined;
      });
      assert.ok(diagnostics.some((item) => item.code === 'removed-but-present'));
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    await vscode.commands.executeCommand('depos.openManifest');
    await poll(() => vscode.window.activeTextEditor?.document.uri.path.endsWith('/Gemfile') ? true : undefined);
  });

  test('.NET project and central package declarations use NuGet notes', async () => {
    for (const [parts, packageName] of [
      [['Pacmon.DotNet.csproj'], 'Newtonsoft.Json'],
      [['Directory.Packages.props'], 'Newtonsoft.Json'],
      [['Directory.Packages.props'], 'Nerdbank.GitVersioning'],
    ] as const) {
      const manifest = fixtureUri(...parts);
      const doc = await vscode.workspace.openTextDocument(manifest);
      await vscode.window.showTextDocument(doc);
      const offset = doc.getText().indexOf(`"${packageName}"`);
      assert.ok(offset > 0, `${packageName} missing from ${manifest.path}`);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        manifest,
        doc.positionAt(offset + 2),
      );
      const text = (hovers ?? []).flatMap((hover) => hover.contents)
        .map((content) => typeof content === 'string' ? content : content.value).join('\n');
      assert.ok(text.includes('.pacmon/nuget/DEPENDENCY-NOTES.md'), `NuGet path missing: ${text}`);
    }
  });

  test('the first .NET note is created beside Directory.Packages.props', async function () {
    this.timeout(20000);
    const notes = fixtureUri('.pacmon', 'nuget', 'DEPENDENCY-NOTES.md');
    const original = await vscode.workspace.fs.readFile(notes);
    try {
      await vscode.workspace.fs.delete(notes);
      await sleep(500);
      const manifest = fixtureUri('Pacmon.DotNet.csproj');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manifest));
      await vscode.commands.executeCommand('depos.addOrEditNote', 'Serilog.AspNetCore', 'Structured request logging.');
      const text = await poll(async () => {
        try {
          const value = await readText(notes);
          return value.includes('## Serilog.AspNetCore') ? value : undefined;
        } catch {
          return undefined;
        }
      });
      assert.ok(text.includes('format: dependency-notes/2\necosystem: nuget\nlang: en'));
      assert.ok(text.includes('Structured request logging.'));
    } finally {
      await vscode.workspace.fs.writeFile(notes, original);
    }
  });

  test('the first Mix note creates a v2 Mix notes file', async function () {
    this.timeout(20000);
    const notes = fixtureUri('.pacmon', 'mix', 'DEPENDENCY-NOTES.md');
    const original = await vscode.workspace.fs.readFile(notes);
    try {
      await vscode.workspace.fs.delete(notes);
      await sleep(500);
      const manifest = fixtureUri('mix.exs');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manifest));
      await vscode.commands.executeCommand('depos.addOrEditNote', 'wallaby', 'Browser integration tests.');
      const text = await poll(async () => {
        try {
          const value = await readText(notes);
          return value.includes('## wallaby') ? value : undefined;
        } catch {
          return undefined;
        }
      });
      assert.ok(text.includes('format: dependency-notes/2\necosystem: mix\nlang: en'));
      assert.ok(text.includes('Browser integration tests.'));
    } finally {
      await vscode.workspace.fs.writeFile(notes, original);
    }
  });

  test('the first Gleam note creates a v2 Gleam notes file', async function () {
    this.timeout(20000);
    const notes = fixtureUri('.pacmon', 'gleam', 'DEPENDENCY-NOTES.md');
    const original = await vscode.workspace.fs.readFile(notes);
    try {
      await vscode.workspace.fs.delete(notes);
      await sleep(500);
      const manifest = fixtureUri('gleam.toml');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manifest));
      await vscode.commands.executeCommand('depos.addOrEditNote', 'gleeunit', 'Gleam test framework.');
      const text = await poll(async () => {
        try {
          const value = await readText(notes);
          return value.includes('## gleeunit') ? value : undefined;
        } catch {
          return undefined;
        }
      });
      assert.ok(text.includes('format: dependency-notes/2\necosystem: gleam\nlang: en'));
      assert.ok(text.includes('Gleam test framework.'));
    } finally {
      await vscode.workspace.fs.writeFile(notes, original);
    }
  });

  test('the first Zig note creates a v2 Zig notes file', async function () {
    this.timeout(20000);
    const notes = fixtureUri('.pacmon', 'zig', 'DEPENDENCY-NOTES.md');
    const original = await vscode.workspace.fs.readFile(notes);
    try {
      await vscode.workspace.fs.delete(notes);
      await sleep(500);
      const manifest = fixtureUri('build.zig.zon');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manifest));
      await vscode.commands.executeCommand('depos.addOrEditNote', 'local_utils', 'Local Zig utilities.');
      const text = await poll(async () => {
        try {
          const value = await readText(notes);
          return value.includes('## local_utils') ? value : undefined;
        } catch {
          return undefined;
        }
      });
      assert.ok(text.includes('format: dependency-notes/2\necosystem: zig\nlang: en'));
      assert.ok(text.includes('Local Zig utilities.'));
    } finally {
      await vscode.workspace.fs.writeFile(notes, original);
    }
  });

  test('the first Go note creates a v2 Go notes file', async function () {
    this.timeout(20000);
    const notes = fixtureUri('.pacmon', 'go', 'DEPENDENCY-NOTES.md');
    const original = await vscode.workspace.fs.readFile(notes);
    try {
      await vscode.workspace.fs.delete(notes);
      await sleep(500);
      const manifest = fixtureUri('go.mod');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manifest));
      await vscode.commands.executeCommand('depos.addOrEditNote', 'github.com/jackc/pgx/v5', 'PostgreSQL driver.');
      const text = await poll(async () => {
        try {
          const value = await readText(notes);
          return value.includes('## github.com/jackc/pgx/v5') ? value : undefined;
        } catch {
          return undefined;
        }
      });
      assert.ok(text.includes('format: dependency-notes/2\necosystem: go\nlang: en'));
      assert.ok(text.includes('PostgreSQL driver.'));
    } finally {
      await vscode.workspace.fs.writeFile(notes, original);
    }
  });

  test('the first Composer note creates a v2 Composer notes file', async function () {
    this.timeout(20000);
    const notes = fixtureUri('.pacmon', 'composer', 'DEPENDENCY-NOTES.md');
    const original = await vscode.workspace.fs.readFile(notes);
    try {
      await vscode.workspace.fs.delete(notes);
      await sleep(500);
      const manifest = fixtureUri('composer.json');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manifest));
      await vscode.commands.executeCommand('depos.addOrEditNote', 'phpunit/phpunit', 'PHP test framework.');
      const text = await poll(async () => {
        try {
          const value = await readText(notes);
          return value.includes('## phpunit/phpunit') ? value : undefined;
        } catch {
          return undefined;
        }
      });
      assert.ok(text.includes('format: dependency-notes/2\necosystem: composer\nlang: en'));
      assert.ok(text.includes('PHP test framework.'));
    } finally {
      await vscode.workspace.fs.writeFile(notes, original);
    }
  });

  test('vcpkg and Conan manifests use separate C/C++ notes namespaces', async () => {
    for (const [manifestName, dependency, expected, notesPath] of [
      ['vcpkg.json', 'fmt', 'C++ formatting library from vcpkg', '.pacmon/vcpkg/DEPENDENCY-NOTES.md'],
      ['conanfile.py', 'zlib', 'Compression library from Conan', '.pacmon/conan/DEPENDENCY-NOTES.md'],
    ] as const) {
      const manifest = fixtureUri(manifestName);
      const doc = await vscode.workspace.openTextDocument(manifest);
      await vscode.window.showTextDocument(doc);
      const offset = doc.getText().indexOf(dependency);
      assert.ok(offset >= 0, `${dependency} missing from ${manifestName}`);
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        manifest,
        doc.positionAt(offset + 1),
      );
      const text = (hovers ?? []).flatMap((hover) => hover.contents)
        .map((content) => typeof content === 'string' ? content : content.value).join('\n');
      assert.ok(text.includes(expected), `${manifestName} note missing: ${text}`);
      assert.ok(text.includes(notesPath), `${manifestName} notes path missing: ${text}`);
    }
  });

  test('the first vcpkg note creates a v2 vcpkg notes file', async function () {
    this.timeout(20000);
    const notes = fixtureUri('.pacmon', 'vcpkg', 'DEPENDENCY-NOTES.md');
    const original = await vscode.workspace.fs.readFile(notes);
    try {
      await vscode.workspace.fs.delete(notes);
      await sleep(500);
      const manifest = fixtureUri('vcpkg.json');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(manifest));
      await vscode.commands.executeCommand('depos.addOrEditNote', 'openssl', 'TLS implementation for native code.');
      const text = await poll(async () => {
        try {
          const value = await readText(notes);
          return value.includes('## openssl') ? value : undefined;
        } catch {
          return undefined;
        }
      });
      assert.ok(text.includes('format: dependency-notes/2\necosystem: vcpkg\nlang: en'));
      assert.ok(text.includes('TLS implementation for native code.'));
    } finally {
      await vscode.workspace.fs.writeFile(notes, original);
    }
  });

  test('Conan notes open conanfile.py before conanfile.txt', async () => {
    const notes = fixtureUri('.pacmon', 'conan', 'DEPENDENCY-NOTES.md');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(notes));
    await vscode.commands.executeCommand('depos.openManifest');
    await poll(() => vscode.window.activeTextEditor?.document.uri.path.endsWith('/conanfile.py') ? true : undefined);
  });

  test('writing a Cargo note does not change other ecosystem notes', async function () {
    this.timeout(15000);
    const cargoNotes = fixtureUri('.pacmon', 'cargo', 'DEPENDENCY-NOTES.md');
    const npmNotes = fixtureUri('.pacmon', 'DEPENDENCY-NOTES.md');
    const mavenNotes = fixtureUri('.pacmon', 'maven', 'DEPENDENCY-NOTES.md');
    const gradleNotes = fixtureUri('.pacmon', 'gradle', 'DEPENDENCY-NOTES.md');
    const mixNotes = fixtureUri('.pacmon', 'mix', 'DEPENDENCY-NOTES.md');
    const gleamNotes = fixtureUri('.pacmon', 'gleam', 'DEPENDENCY-NOTES.md');
    const zigNotes = fixtureUri('.pacmon', 'zig', 'DEPENDENCY-NOTES.md');
    const goNotes = fixtureUri('.pacmon', 'go', 'DEPENDENCY-NOTES.md');
    const composerNotes = fixtureUri('.pacmon', 'composer', 'DEPENDENCY-NOTES.md');
    const notesFiles = [cargoNotes, npmNotes, mavenNotes, gradleNotes, mixNotes, gleamNotes, zigNotes, goNotes, composerNotes];
    const originals = await Promise.all(notesFiles.map((uri) => vscode.workspace.fs.readFile(uri)));
    try {
      const cargo = fixtureUri('Cargo.toml');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(cargo));
      await vscode.commands.executeCommand('depos.addOrEditNote', 'anyhow', 'Application error context.');
      const updated = await poll(async () => {
        const text = await readText(cargoNotes);
        return text.includes('## anyhow') ? text : undefined;
      });
      assert.ok(updated.includes('Application error context.'));
      assert.strictEqual(await readText(npmNotes), new TextDecoder().decode(originals[1]!));
      assert.strictEqual(await readText(mavenNotes), new TextDecoder().decode(originals[2]!));
      assert.strictEqual(await readText(gradleNotes), new TextDecoder().decode(originals[3]!));
      assert.strictEqual(await readText(mixNotes), new TextDecoder().decode(originals[4]!));
      assert.strictEqual(await readText(gleamNotes), new TextDecoder().decode(originals[5]!));
      assert.strictEqual(await readText(zigNotes), new TextDecoder().decode(originals[6]!));
      assert.strictEqual(await readText(goNotes), new TextDecoder().decode(originals[7]!));
      assert.strictEqual(await readText(composerNotes), new TextDecoder().decode(originals[8]!));
    } finally {
      await Promise.all(notesFiles.map((uri, index) =>
        vscode.workspace.fs.writeFile(uri, originals[index]!),
      ));
    }
  });

  test('sections not in package.json get no diagnostic, and everything Depos reports is a warning', async function () {
    this.timeout(15000);
    const notes = fixtureUri('.pacmon', 'DEPENDENCY-NOTES.md');
    const doc = await vscode.workspace.openTextDocument(notes);
    const editor = await vscode.window.showTextDocument(doc);
    // Force one real diagnostic so we know the refresh has run.
    const line = doc.getText().split(/\r?\n/).findIndex((l) => l.startsWith('- verified: 4.19.2'));
    assert.ok(line > 0, 'fixture changed: no express agent block');
    await editor.edit((b) => {
      b.insert(new vscode.Position(line, 0), '- dafdsf: fdsaf\n');
      // A section that matches no dependency. The fixture has none of its own:
      // it is the demo repository now, and moment — the one section not in
      // package.json — is marked removed, which is the other case here.
      b.insert(doc.lineAt(doc.lineCount - 1).range.end, '\n## ghost-package\n\nAn orphan, on purpose.\n');
    });
    try {
      const mine = await poll(() => {
        const d = vscode.languages.getDiagnostics(notes).filter((x) => x.source === 'depos');
        return d.some((x) => x.code === 'unknown-agent-key') ? d : undefined;
      });
      // ghost-package (a real orphan) and moment (marked removed) are markers, not problems.
      assert.deepStrictEqual(
        mine.filter((d) => d.message.includes('ghost-package') || d.message.includes('moment')).map((d) => d.message),
        [],
      );
      for (const d of mine) {
        assert.strictEqual(d.severity, vscode.DiagnosticSeverity.Warning, `not a warning: ${d.message}`);
      }
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  test('a stray heading, a second title and a stale removed status are flagged with one-click fixes', async function () {
    this.timeout(20000);
    const notes = fixtureUri('.pacmon', 'DEPENDENCY-NOTES.md');
    const doc = await vscode.workspace.openTextDocument(notes);
    const editor = await vscode.window.showTextDocument(doc);
    const lines = doc.getText().split(/\r?\n/);
    const humanLine = lines.findIndex((l) => l.startsWith('Do not upgrade to v5'));
    const verifiedLine = lines.findIndex((l) => l.startsWith('- verified: 4.19.2'));
    assert.ok(humanLine > 0 && verifiedLine > humanLine, 'fixture changed');
    await editor.edit((b) => {
      b.insert(new vscode.Position(humanLine, 0), '### Known quirks\n');
      b.insert(new vscode.Position(verifiedLine, 0), '- status: removed 2026-01 — test\n');
      b.insert(doc.lineAt(doc.lineCount - 1).range.end, '\n# Second title\n');
    });
    try {
      const mine = (): vscode.Diagnostic[] => vscode.languages.getDiagnostics(notes).filter((d) => d.source === 'depos');
      const found = await poll(() => {
        const d = mine();
        const stray = d.find((x) => x.code === 'stray-heading');
        const removed = d.find((x) => x.code === 'removed-but-present');
        const extra = d.find((x) => x.code === 'extra-title');
        return stray && removed && extra ? { stray, removed, extra } : undefined;
      }, 10000);
      assert.ok(found.stray.message.includes('Agent notes'), found.stray.message);
      assert.ok(found.removed.message.includes('"express"'), found.removed.message);

      const fixes = async (d: vscode.Diagnostic): Promise<vscode.CodeAction[]> =>
        (await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', notes, d.range)) ?? [];
      // Bottom-up, so no fix shifts the lines a later one still points at.
      const secondTitle = (await fixes(found.extra)).find((a) => a.title === 'Make it plain text');
      assert.ok(secondTitle?.edit, 'extra title: make it plain text');
      await vscode.workspace.applyEdit(secondTitle.edit);
      assert.ok(doc.getText().includes('**Second title**'), 'second title should be plain text now');

      const removeStatus = (await fixes(found.removed)).find((a) => a.title === 'Remove this line');
      assert.ok(removeStatus?.isPreferred && removeStatus.edit, 'removed-but-present: remove the line');
      await vscode.workspace.applyEdit(removeStatus.edit);
      assert.ok(!doc.getText().includes('status: removed 2026-01'), 'status line should be gone');

      const plain = (await fixes(found.stray)).find((a) => a.title === 'Make it plain text');
      assert.ok(plain?.isPreferred && plain.edit, 'stray heading: make it plain text');
      await vscode.workspace.applyEdit(plain.edit);
      assert.strictEqual(doc.lineAt(humanLine).text, '**Known quirks**');
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  test('an unknown key in the agent block gets a diagnostic and a keep-as-note fix', async function () {
    this.timeout(15000);
    const notes = fixtureUri('.pacmon', 'DEPENDENCY-NOTES.md');
    const doc = await vscode.workspace.openTextDocument(notes);
    const editor = await vscode.window.showTextDocument(doc);
    const line = doc.getText().split(/\r?\n/).findIndex((l) => l.startsWith('- verified: 4.19.2'));
    assert.ok(line > 0, 'fixture changed: no express agent block');
    await editor.edit((b) =>
      b.insert(new vscode.Position(line, 0), '- dafdsf: fdsaf\n- contraint: stay on ^4\n'),
    );
    try {
      // Only the two inserted lines matter; the fixture may carry other unknown keys.
      const { gibberish, typo } = await poll(() => {
        const d = vscode.languages
          .getDiagnostics(notes)
          .filter((x) => x.source === 'depos' && x.code === 'unknown-agent-key');
        const g = d.find((x) => x.range.start.line === line);
        const t = d.find((x) => x.range.start.line === line + 1);
        return g && t ? { gibberish: g, typo: t } : undefined;
      }, 10000);
      assert.ok(gibberish.message.includes('dafdsf') && !gibberish.message.includes('did you mean'), gibberish.message);
      assert.ok(typo.message.includes('"constraint:"'), typo.message);
      // A warning (yellow, counted, tinting the tab), on the key alone.
      assert.strictEqual(typo.severity, vscode.DiagnosticSeverity.Warning);
      assert.strictEqual(typo.range.start.character, 2);
      assert.strictEqual(typo.range.end.character, 2 + 'contraint'.length);

      // The typo's preferred fix is the rename; gibberish is kept as a note.
      const forTypo = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        notes,
        typo.range,
      );
      const rename = (forTypo ?? []).find((a) => a.title.includes('constraint'));
      assert.ok(rename?.isPreferred, `rename should be the preferred fix among: ${(forTypo ?? []).map((a) => a.title).join(', ')}`);
      const forGibberish = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        notes,
        gibberish.range,
      );
      assert.ok((forGibberish ?? []).some((a) => a.title.includes('note') && a.isPreferred), 'keep-as-note is preferred for gibberish');
      // The squiggle is on the key, but the fix is there with the caret anywhere on the line.
      const atEnd = new vscode.Position(line + 1, doc.lineAt(line + 1).text.length);
      const forCaret = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        notes,
        new vscode.Range(atEnd, atEnd),
      );
      assert.ok((forCaret ?? []).some((a) => a.title.includes('constraint')), 'fix offered at the end of the line too');

      // Fix All exists — the on-save path — under its kind, and under the kind
      // from before Pacmon became Depos that settings may still name. One
      // action either way, so a fix never runs twice.
      for (const kind of ['source.fixAll.depos', 'source.fixAll.pacmon', 'source.fixAll']) {
        const all = await vscode.commands.executeCommand<vscode.CodeAction[]>(
          'vscode.executeCodeActionProvider',
          notes,
          new vscode.Range(0, 0, doc.lineCount, 0),
          kind,
        );
        const fixAll = (all ?? []).filter((a) => a.kind?.value.startsWith('source.fixAll') && a.edit);
        const expected = kind === 'source.fixAll.pacmon' ? 'source.fixAll.pacmon' : 'source.fixAll.depos';
        assert.deepStrictEqual(
          fixAll.map((a) => a.kind?.value),
          [expected],
          `asked for ${kind}, got: ${(all ?? []).map((a) => `${a.kind?.value ?? '?'}:${a.title}`).join(', ')}`,
        );
      }

      // The code lens above the block names the count and fixes both lines in one click.
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', notes);
      const lens = (lenses ?? []).find((l) => l.command?.command === 'depos.fixAgentNotes');
      assert.ok(lens?.command, `no fix lens among: ${(lenses ?? []).map((l) => l.command?.title ?? '?').join(', ')}`);
      const fileLines = doc.getText().split(/\r?\n/);
      // The block we edited, not the first one in the file: the fixture is a
      // whole repository now, and most of its sections carry an agent block.
      const headingLine = fileLines.lastIndexOf('### Agent notes', line);
      const blockEnd = fileLines.findIndex((l, i) => i > headingLine && l.startsWith('## '));
      assert.strictEqual(lens.range.start.line, headingLine, 'lens sits on the block heading');
      // The count is whatever the block holds right now — at least our two.
      const inBlock = vscode.languages
        .getDiagnostics(notes)
        .filter((d) => d.source === 'depos' && d.severity === vscode.DiagnosticSeverity.Warning)
        .filter((d) => d.range.start.line > headingLine && d.range.start.line < blockEnd).length;
      assert.ok(inBlock >= 2, `expected at least the two inserted problems, got ${inBlock}`);
      assert.ok(lens.command.title.includes(`${inBlock} problem`), `${lens.command.title} (block has ${inBlock})`);
      await vscode.commands.executeCommand(lens.command.command, ...(lens.command.arguments ?? []));
      await poll(() => (doc.lineAt(line).text === '- note: dafdsf: fdsaf' ? true : undefined));
      assert.strictEqual(doc.lineAt(line + 1).text, '- constraint: stay on ^4');
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  });

  test('normalize canonicalizes a messy heading and is undoable (buffer only)', async function () {
    this.timeout(15000);
    const notes = fixtureUri('.pacmon', 'DEPENDENCY-NOTES.md');
    const doc = await vscode.workspace.openTextDocument(notes);
    const editor = await vscode.window.showTextDocument(doc);
    await editor.edit((b) => {
      b.insert(doc.lineAt(doc.lineCount - 1).range.end, '\n##   zzz-messy  \nbody text\n');
    });
    await vscode.commands.executeCommand('depos.normalizeNotesFile');
    await poll(() => (doc.getText().includes('## zzz-messy') ? true : undefined));
    const text = doc.getText();
    assert.ok(text.includes('## zzz-messy'), 'heading not canonicalized');
    assert.ok(!text.includes('##   zzz-messy'), 'messy heading still present');
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  test('addOrEditNote with a body writes inline and stays in package.json', async function () {
    this.timeout(15000);
    const notes = fixtureUri('.pacmon', 'DEPENDENCY-NOTES.md');
    const original = await vscode.workspace.fs.readFile(notes);
    try {
      const pkg = fixtureUri('package.json');
      const pdoc = await vscode.workspace.openTextDocument(pkg);
      await vscode.window.showTextDocument(pdoc);

      await vscode.commands.executeCommand('depos.addOrEditNote', 'helmet', 'why: security headers');

      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(notes));
      assert.ok(text.includes('## helmet'), 'section missing on disk');
      assert.ok(text.includes('why: security headers'), 'body missing on disk');
      // helmet has no section in the fixture, so this writes a new one: it must
      // land in order, between the two sections it belongs between.
      assert.ok(
        text.indexOf('## express') < text.indexOf('## helmet') &&
          text.indexOf('## helmet') < text.indexOf('## lodash'),
        'a new section should sort between express and lodash',
      );
      assert.strictEqual(
        vscode.window.activeTextEditor?.document.uri.toString(),
        pkg.toString(),
        'focus must stay in package.json',
      );
    } finally {
      await vscode.workspace.fs.writeFile(notes, original);
    }
  });

  test('context-menu style invocation (Uri as first arg) resolves the dep from the cursor', async function () {
    this.timeout(15000);
    const notes = fixtureUri('.pacmon', 'DEPENDENCY-NOTES.md');
    const original = await vscode.workspace.fs.readFile(notes);
    try {
      const pkg = fixtureUri('package.json');
      const doc = await vscode.workspace.openTextDocument(pkg);
      const ed = await vscode.window.showTextDocument(doc);
      // showTextDocument can resolve a beat before the editor is ACTIVE. This
      // test reads the dep off the cursor, so a stale active editor sends it
      // down the "pick a dependency" path and nothing is written.
      await poll(() =>
        vscode.window.activeTextEditor?.document.uri.toString() === pkg.toString() ? true : undefined,
      );
      const off = doc.getText().indexOf('"vitest"') + 2;
      const pos = doc.positionAt(off);
      ed.selection = new vscode.Selection(pos, pos);
      // Editor context menus pass the resource Uri as the first argument.
      await vscode.commands.executeCommand('depos.addOrEditNote', pkg, 'ctx-menu body');
      // The write lands either straight on disk or through the open document's
      // save, depending on whether the previous test's restore has settled —
      // so wait for the content rather than reading once.
      const text = await poll(async () => {
        const t = new TextDecoder().decode(await vscode.workspace.fs.readFile(notes));
        return t.includes('## vitest') ? t : undefined;
      });
      assert.ok(text.includes('ctx-menu body'), 'body missing');
    } finally {
      await vscode.workspace.fs.writeFile(notes, original);
    }
  });

  test('editing an existing note opens the file at the section', async function () {
    this.timeout(15000);
    await vscode.commands.executeCommand('depos.addOrEditNote', 'express');
    await poll(() => {
      const uri = vscode.window.activeTextEditor?.document.uri;
      return uri && uri.path.endsWith('.pacmon/DEPENDENCY-NOTES.md') ? true : undefined;
    });
    const ed = vscode.window.activeTextEditor!;
    const headingLine = ed.document.lineAt(Math.max(ed.selection.active.line - 1, 0)).text;
    assert.strictEqual(headingLine, '## express', `cursor should sit right under the heading, got: "${headingLine}"`);
  });

  test('note markers: the setting wins, and the toggle writes it', async function () {
    this.timeout(20000);
    const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('depos');
    const read = (): string => cfg().get<string>('decorations', 'preview');
    const saved = cfg().inspect('decorations');
    try {
      // Start from a known state in BOTH targets: a workspace value shadows
      // the global one, and a previous run may have left one behind.
      await cfg().update('decorations', undefined, vscode.ConfigurationTarget.Workspace);
      await cfg().update('decorations', 'preview', vscode.ConfigurationTarget.Global);
      await sleep(400);
      assert.strictEqual(read(), 'preview', `setup failed, effective value is "${read()}"`);

      // The toggle used to write a hidden per-workspace flag that outranked
      // the setting, so choosing "off" in the view could do nothing at all.
      await vscode.commands.executeCommand('depos.toggleDecorations');
      await sleep(400);
      assert.strictEqual(read(), 'off', `toggle should have written the setting, got "${read()}"`);

      await vscode.commands.executeCommand('depos.toggleDecorations');
      await sleep(400);
      assert.strictEqual(read(), 'preview', `toggling back should restore, got "${read()}"`);

      // An explicit "off" stays off. Clear the workspace value the toggle just
      // wrote first — a workspace setting outranking a global one is ordinary
      // VS Code precedence, not the bug this test guards.
      await cfg().update('decorations', undefined, vscode.ConfigurationTarget.Workspace);
      await cfg().update('decorations', 'off', vscode.ConfigurationTarget.Global);
      await sleep(400);
      assert.strictEqual(read(), 'off', `explicit off must stick, got "${read()}"`);
    } finally {
      await cfg().update('decorations', undefined, vscode.ConfigurationTarget.Workspace);
      await cfg().update('decorations', saved?.globalValue, vscode.ConfigurationTarget.Global);
    }
  });

  test('opening package.json from the command works from anywhere', async function () {
    this.timeout(15000);
    const notes = fixtureUri('.pacmon', 'DEPENDENCY-NOTES.md');
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(notes));
    await vscode.commands.executeCommand('depos.openPackageJson');
    const uri = await poll(() => {
      const u = vscode.window.activeTextEditor?.document.uri;
      return u && u.path.endsWith('package.json') ? u : undefined;
    });
    assert.ok(uri.path.endsWith('package.json'));
  });

  // NOTE: the settings view reveals the manifest from inside its webview, which
  // a test cannot click. What is covered here is the surfacing itself — that
  // package.json can be brought back with nothing open. The webview wiring that
  // calls it needs a human.
  test('the manifest can be surfaced with no editor open', async function () {
    this.timeout(20000);
    const cfg = vscode.workspace.getConfiguration('depos');
    const saved = cfg.inspect('noteButtons')?.globalValue;
    try {
      // Close everything, then focus the Depos view as a user would.
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await poll(() => (vscode.window.visibleTextEditors.length === 0 ? true : undefined));
      await vscode.commands.executeCommand('depos.settings.focus');

      // A setting change of the kind the view writes...
      await vscode.workspace
        .getConfiguration('depos')
        .update('noteButtons', ['codelens'], vscode.ConfigurationTarget.Global);
      await vscode.commands.executeCommand('depos.openPackageJson');

      const shown = await poll(() =>
        vscode.window.visibleTextEditors.find((e) => e.document.uri.path.endsWith('package.json')),
      );
      assert.ok(shown, 'package.json should be on screen');
    } finally {
      await vscode.workspace
        .getConfiguration('depos')
        .update('noteButtons', saved, vscode.ConfigurationTarget.Global);
    }
  });

  test('the Depos view is contributed and its rows toggle the setting', async function () {
    this.timeout(20000);
    const ext = vscode.extensions.getExtension('kontra.pacmon')!;
    const contributes = ext.packageJSON.contributes as {
      viewsContainers: { activitybar: { id: string; icon: string }[] };
      views: Record<string, { id: string; type?: string }[]>;
    };
    assert.ok(
      contributes.viewsContainers.activitybar.some((c) => c.id === 'depos'),
      'no activity bar container',
    );
    const view = contributes.views['depos']?.find((v) => v.id === 'depos.settings');
    assert.ok(view, 'no settings view');
    assert.strictEqual(view.type, 'webview', 'the settings view should be a webview');

    // Focusing the view is what a user clicking the activity bar icon does.
    await vscode.commands.executeCommand('depos.settings.focus');

    const cfg = (): string[] =>
      vscode.workspace.getConfiguration('depos').get<string[]>('noteButtons', []);
    const before = cfg();
    try {
      await vscode.workspace
        .getConfiguration('depos')
        .update('noteButtons', ['codelens'], vscode.ConfigurationTarget.Global);
      await poll(() => (cfg().includes('codelens') ? true : undefined));
      // The opt-in arm must actually come back when it is selected.
      const lenses = await poll(async () => {
        const all = await vscode.commands.executeCommand<vscode.CodeLens[]>(
          'vscode.executeCodeLensProvider',
          fixtureUri('package.json'),
        );
        const mine = (all ?? []).filter((l) => l.command?.command === 'depos.addOrEditNote');
        return mine.length > 0 ? mine : undefined;
      });
      assert.ok(lenses.length > 0, 'codelens should be available when selected');

      // Links have no change event and VS Code caches them, so the provider is
      // re-registered by hand; without that, toggling link off does nothing.
      const commandLinks = async (): Promise<number> => {
        const all = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
          'vscode.executeLinkProvider',
          fixtureUri('package.json'),
        );
        return (all ?? []).filter((l) => l.target?.scheme === 'command').length;
      };
      assert.strictEqual(await commandLinks(), 0, 'link is off, so no command links');
      await vscode.workspace
        .getConfiguration('depos')
        .update('noteButtons', ['codelens', 'link'], vscode.ConfigurationTarget.Global);
      const withLink = await poll(async () => {
        const n = await commandLinks();
        return n > 0 ? n : undefined;
      });
      assert.ok(withLink > 0, 'turning link on must take effect without editing the file');
    } finally {
      await vscode.workspace
        .getConfiguration('depos')
        .update('noteButtons', before.length > 0 ? before : undefined, vscode.ConfigurationTarget.Global);
    }
  });

  suite('note affordances (depos.noteButtons)', () => {
    const OURS = 'depos.addOrEditNote';

    async function withButtons<T>(buttons: string[], fn: () => Promise<T>): Promise<T> {
      const cfg = vscode.workspace.getConfiguration('depos');
      await cfg.update('noteButtons', buttons, vscode.ConfigurationTarget.Global);
      try {
        return await fn();
      } finally {
        await cfg.update('noteButtons', undefined, vscode.ConfigurationTarget.Global);
      }
    }

    test('link turns the package name into a Ctrl+click command link', async function () {
      this.timeout(15000);
      await withButtons(['link'], async () => {
        const uri = fixtureUri('package.json');
        const links = await poll(async () => {
          const all = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
            'vscode.executeLinkProvider',
            uri,
          );
          const mine = (all ?? []).filter((l) => l.target?.scheme === 'command');
          return mine.length > 0 ? mine : undefined;
        });
        const target = links.find((l) => decodeURIComponent(l.target!.query).includes('express'));
        assert.ok(target, 'no command link for express');
        assert.strictEqual(target.target!.path, OURS);
      });
    });

    test('iconLeft is a decoration — it emits no inlay hint and no code lens', async function () {
      this.timeout(15000);
      await withButtons(['iconLeft'], async () => {
        const uri = fixtureUri('package.json');
        const doc = await vscode.workspace.openTextDocument(uri);
        const hints = await vscode.commands.executeCommand<vscode.InlayHint[]>(
          'vscode.executeInlayHintProvider',
          uri,
          new vscode.Range(0, 0, doc.lineCount, 0),
        );
        const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
          'vscode.executeCodeLensProvider',
          uri,
        );
        assert.strictEqual((hints ?? []).length, 0, 'the glyph must not be an inlay hint');
        assert.strictEqual(
          (lenses ?? []).filter((l) => l.command?.command === OURS).length,
          0,
          'no code lens should remain',
        );
      });
    });

    test('the icon click path ignores non-mouse caret moves', async function () {
      this.timeout(20000);
      const cfg = vscode.workspace.getConfiguration('depos');
      await cfg.update('noteEntry', 'panel', vscode.ConfigurationTarget.Global);
      try {
        await withButtons(['iconLeft'], async () => {
          const uri = fixtureUri('package.json');
          const doc = await vscode.workspace.openTextDocument(uri);
          const ed = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

          // Exactly where a click on the mark lands. Arriving there
          // programmatically (kind Command/undefined) must do nothing —
          // otherwise Home, arrow keys and every jump would open the note.
          const keyPos = doc.positionAt(doc.getText().indexOf('"express"'));
          ed.selection = new vscode.Selection(keyPos, keyPos);
          await sleep(1200);

          const panel = vscode.window.tabGroups.all
            .flatMap((g) => g.tabs)
            .find(
              (t) =>
                t.input instanceof vscode.TabInputWebview &&
                t.input.viewType.includes('pacmon.noteEditor'),
            );
          assert.strictEqual(panel, undefined, 'a non-mouse caret move must not open the note');
        });
      } finally {
        await cfg.update('noteEntry', 'input', vscode.ConfigurationTarget.Global);
      }
    });

    test('an empty setting silences both affordances', async function () {
      this.timeout(15000);
      await withButtons([], async () => {
        const uri = fixtureUri('package.json');
        const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
          'vscode.executeLinkProvider',
          uri,
        );
        assert.strictEqual(
          (links ?? []).filter((l) => l.target?.scheme === 'command').length,
          0,
          'no command links',
        );
        // The right-click command must still work with every affordance off.
        const notes = fixtureUri('.pacmon', 'DEPENDENCY-NOTES.md');
        const original = await vscode.workspace.fs.readFile(notes);
        try {
          await vscode.commands.executeCommand('depos.addOrEditNote', 'vitest', 'still reachable');
          const text = await poll(async () => {
            const t = new TextDecoder().decode(await vscode.workspace.fs.readFile(notes));
            return t.includes('still reachable') ? t : undefined;
          });
          assert.ok(text.includes('## vitest'));
        } finally {
          await vscode.workspace.fs.writeFile(notes, original);
        }
      });
    });
  });

  test('panel mode opens the note editor beside package.json', async function () {
    this.timeout(15000);
    const cfg = vscode.workspace.getConfiguration('depos');
    await cfg.update('noteEntry', 'panel', vscode.ConfigurationTarget.Global);
    try {
      const pkg = fixtureUri('package.json');
      const doc = await vscode.workspace.openTextDocument(pkg);
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);

      await vscode.commands.executeCommand('depos.addOrEditNote', 'express');

      const tab = await poll(() =>
        vscode.window.tabGroups.all
          .flatMap((g) => g.tabs)
          .find(
            (t) =>
              t.input instanceof vscode.TabInputWebview &&
              t.input.viewType.includes('pacmon.noteEditor'),
          ),
      );
      assert.ok(
        tab.label.includes('express'),
        `panel title should name the dependency, got: "${tab.label}"`,
      );
      assert.ok(tab.group.viewColumn !== vscode.ViewColumn.One, 'panel should open beside package.json');
      await vscode.window.tabGroups.close(tab);
    } finally {
      await cfg.update('noteEntry', 'input', vscode.ConfigurationTarget.Global);
    }
  });

  test('the first note of a repository without notes creates .depos/, the notes file and AGENT-RULES.md', async function () {
    this.timeout(30000);
    // The fixture's notes (.pacmon/, from before Pacmon became Depos) are set
    // aside, so the repository has none; they come back afterwards.
    const legacyDir = fixtureUri('.pacmon');
    const aside = fixtureUri('.pacmon-aside');
    const dir = fixtureUri('.depos');
    const notes = fixtureUri('.depos', 'DEPENDENCY-NOTES.md');
    const agents = fixtureUri('.depos', 'AGENT-RULES.md');
    try {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await vscode.workspace.fs.rename(legacyDir, aside);
      // Give the watcher a moment to see the deletion.
      await sleep(800);

      const pkg = fixtureUri('package.json');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(pkg));
      await vscode.commands.executeCommand('depos.addOrEditNote', 'lodash', 'fresh start');

      const text = await poll(async () => {
        try {
          const t = await readText(notes);
          return t.includes('fresh start') ? t : undefined;
        } catch {
          return undefined;
        }
      });
      assert.ok(
        text.startsWith('---\nformat: dependency-notes/1\nlang: en\n---\n'),
        `template missing, got: ${text.slice(0, 120)}`,
      );
      assert.ok(text.includes('## lodash\n\nfresh start'), 'section missing');
      assert.ok(text.includes('rules in .depos/AGENT-RULES.md'), 'the header names the rules beside it');
      const rules = await poll(async () => {
        try {
          return await readText(agents);
        } catch {
          return undefined;
        }
      });
      assert.ok(
        rules.includes('### Agent notes') && rules.includes('| `purpose:` |'),
        'AGENT-RULES.md should carry the rules and the field table',
      );
      assert.ok(rules.includes('.depos/DEPENDENCY-NOTES.md') && !rules.includes('.pacmon/'), 'the rules name .depos/');
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      try {
        await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
      } catch {
        // never created
      }
      await vscode.workspace.fs.rename(aside, legacyDir);
      // The watcher clears the resolver's cache: the repository is on .pacmon/ again.
      await sleep(800);
    }
  });

  test('Set Up AI Instructions rewrites .pacmon/AGENT-RULES.md and leaves a three-line pointer', async function () {
    // The fixture keeps its notes in .pacmon/, the directory from before Pacmon
    // became Depos: the rules and the pointer stay there, with the new markers.
    this.timeout(15000);
    const rootAgents = fixtureUri('AGENTS.md');
    const rules = fixtureUri('.pacmon', 'AGENT-RULES.md');
    try {
      // A block an older version left behind is replaced, not added to.
      await vscode.workspace.fs.writeFile(
        rootAgents,
        new TextEncoder().encode('# Agents\n\n<!-- pacmon:start -->\nold pointer\n<!-- pacmon:end -->\n'),
      );
      await vscode.commands.executeCommand('depos.setupAiInstructions', ['AGENTS.md']);
      const pointer = await poll(async () => {
        try {
          const text = await readText(rootAgents);
          return text.includes('depos:start') ? text : undefined;
        } catch {
          return undefined;
        }
      });
      const m = /<!-- depos:start -->\n([\s\S]*?)<!-- depos:end -->/.exec(pointer);
      assert.ok(m, `no marker block in AGENTS.md, got: ${pointer}`);
      assert.strictEqual(m[1]!.trim().split('\n').length, 3, 'the pointer is exactly three lines');
      assert.ok(pointer.includes('.pacmon/AGENT-RULES.md'), 'the pointer names the rules file');
      assert.ok(!pointer.includes('.depos/'), 'the pointer names the repository’s own directory');
      assert.ok(!pointer.includes('pacmon:start') && !pointer.includes('old pointer'), 'the old block is gone');
      const generated = await readText(rules);
      assert.ok(generated.includes('| `verified:` |'), '.pacmon/AGENT-RULES.md should be the rules file');
      assert.ok(generated.includes('.pacmon/DEPENDENCY-NOTES.md') && !generated.includes('.depos/'), 'the rules name .pacmon/');
    } finally {
      for (const u of [rootAgents, rules]) {
        try {
          await vscode.workspace.fs.delete(u);
        } catch {
          // never created
        }
      }
    }
  });

  test('a human edit replaces only the human text — the agent block survives', async function () {
    this.timeout(15000);
    const notes = fixtureUri('.pacmon', 'DEPENDENCY-NOTES.md');
    const agents = fixtureUri('.pacmon', 'AGENT-RULES.md');
    const original = await vscode.workspace.fs.readFile(notes);
    try {
      try {
        await vscode.workspace.fs.delete(agents);
      } catch {
        // not there yet — that is the case under test
      }
      const pkg = fixtureUri('package.json');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(pkg));
      await vscode.commands.executeCommand('depos.addOrEditNote', 'express', 'new human line');
      const text = await poll(async () => {
        const t = await readText(notes);
        return t.includes('new human line') ? t : undefined;
      });
      assert.ok(!text.includes('HTTP API layer'), 'the old human text should be gone');
      // Search from the section: the file header also mentions "### Agent notes".
      const section = text.indexOf('## express');
      const agentHeading = text.indexOf('\n### Agent notes\n', section);
      assert.ok(agentHeading > section, 'agent heading lost');
      assert.ok(text.includes('- constraint: stay on ^4'), 'agent line lost');
      const human = text.indexOf('new human line');
      assert.ok(
        section < human && human < agentHeading,
        'human text sits between the heading and the agent block',
      );
      // A notes file that exists without the agent rules gets them on the
      // first write — not only when the file itself is created.
      const rules = await poll(async () => {
        try {
          return await readText(agents);
        } catch {
          return undefined;
        }
      });
      assert.ok(rules.includes('| `purpose:` |'), 'AGENT-RULES.md should appear next to an existing notes file');
    } finally {
      await vscode.workspace.fs.writeFile(notes, original);
      try {
        await vscode.workspace.fs.delete(agents);
      } catch {
        // never created
      }
    }
  });

  test('a .depos/ notes file beside .pacmon/ is read instead, and the .pacmon/ one is flagged', async function () {
    this.timeout(20000);
    const legacy = fixtureUri('.pacmon', 'DEPENDENCY-NOTES.md');
    const currentDir = fixtureUri('.depos');
    const current = fixtureUri('.depos', 'DEPENDENCY-NOTES.md');
    const pkg = fixtureUri('package.json');
    const hoverText = async (): Promise<string> => {
      const doc = await vscode.workspace.openTextDocument(pkg);
      const offset = doc.getText().indexOf('"express"');
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider',
        pkg,
        doc.positionAt(offset + 2),
      );
      return (hovers ?? []).flatMap((hover) => hover.contents)
        .map((content) => typeof content === 'string' ? content : content.value).join('\n');
    };
    try {
      await vscode.workspace.fs.createDirectory(currentDir);
      await vscode.workspace.fs.writeFile(current, new TextEncoder().encode([
        '---', 'format: dependency-notes/1', 'lang: en', '---', '',
        '# Dependency Notes', '', '## express', '', 'Read from the .depos/ file.', '',
      ].join('\n')));
      const text = await poll(async () => {
        const t = await hoverText();
        return t.includes('Read from the .depos/ file.') ? t : undefined;
      }, 10000);
      assert.ok(text.includes('.depos/DEPENDENCY-NOTES.md'), `the hover names the file it read: ${text}`);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(legacy));
      const flagged = await poll(
        () => vscode.languages.getDiagnostics(legacy).find((d) => d.code === 'shadowed-notes-file'),
        10000,
      );
      assert.ok(flagged.message.includes('.depos/DEPENDENCY-NOTES.md'), flagged.message);
    } finally {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      try {
        await vscode.workspace.fs.delete(currentDir, { recursive: true });
      } catch {
        // never created
      }
    }
  });

  // A suite of its own, defined last: Mocha runs a suite's own tests before its
  // child suites, and this one moves the fixture's notes for good.
  suite('moving the notes to .depos/', () => {
    test('Move Notes to .depos/ moves .pacmon/ whole, and what points into it', async function () {
      this.timeout(30000);
      const agents = fixtureUri('AGENTS.md');
      await vscode.workspace.fs.writeFile(
        agents,
        new TextEncoder().encode('# Agents\n\n<!-- pacmon:start -->\nold\n<!-- pacmon:end -->\n'),
      );
      // AGENT-RULES.md at the root of .pacmon/, as any write leaves it.
      await vscode.commands.executeCommand('depos.setupAiInstructions', ['AGENTS.md']);
      await poll(async () => {
        try {
          await vscode.workspace.fs.stat(fixtureUri('.pacmon', 'AGENT-RULES.md'));
          return true;
        } catch {
          return undefined;
        }
      });
      await vscode.commands.executeCommand('depos.moveNotes', { confirmed: true });
      const moved = await poll(async () => {
        try {
          return await readText(fixtureUri('.depos', 'DEPENDENCY-NOTES.md'));
        } catch {
          return undefined;
        }
      }, 10000);
      const header = /<!--[\s\S]*?-->/.exec(moved)?.[0] ?? '';
      assert.ok(header.includes('rules in .depos/AGENT-RULES.md'), `the header names .depos/AGENT-RULES.md: ${header}`);
      assert.ok(!header.includes('.pacmon/'), 'no header left pointing into .pacmon/');
      // What people wrote is theirs: the intro still says what it said.
      assert.ok(moved.includes('Agents: read `.pacmon/AGENT-RULES.md`'), 'the intro is left alone');
      await assert.rejects(async () => {
        await vscode.workspace.fs.stat(fixtureUri('.pacmon'));
      }, '.pacmon/ should be gone');
      const cargo = await readText(fixtureUri('.depos', 'cargo', 'DEPENDENCY-NOTES.md'));
      assert.ok(cargo.includes('rules in .depos/AGENT-RULES.md'), 'every notes file moved, header and all');
      const rules = await readText(fixtureUri('.depos', 'AGENT-RULES.md'));
      assert.ok(rules.includes('.depos/DEPENDENCY-NOTES.md') && !rules.includes('.pacmon/'), 'the rules name .depos/');
      const pointer = await readText(agents);
      assert.ok(pointer.includes('.depos/AGENT-RULES.md') && !pointer.includes('.pacmon/'), `the pointer names .depos/: ${pointer}`);
      assert.strictEqual(pointer.match(/depos:start/g)?.length, 1, 'one block');
    });
  });
});
