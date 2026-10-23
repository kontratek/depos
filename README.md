# Pacmon

**JavaScript, Rust, JVM, Elixir, Zig, Python, Ruby, PHP/Composer, Go, .NET/NuGet and C/C++ package manifests say what you depend on. Pacmon adds why.**

Every dependency gets a short note: why it is here, what must not change, what to check before an upgrade. The note shows in the manifest on hover, and you write it from there.

Notes live in Markdown files under `.pacmon/`, next to the manifest they describe. No database, no service, no account: files that you read, diff and commit like any other. AI coding agents read the same files before they touch a dependency, and keep their own lines in them.

![Pacmon in VS Code: a preview after each dependency in package.json, the note on hover, and a note written from the side panel](docs/media/demo.gif)

## Supported manifests

| Ecosystem | Manifest | Notes file | Section heading |
|---|---|---|---|
| npm | `package.json` | `.pacmon/DEPENDENCY-NOTES.md` | the package name: `## express`, `## @types/node` |
| Rust | `Cargo.toml` | `.pacmon/cargo/DEPENDENCY-NOTES.md` | the dependency key, usually the crate name: `## serde` |
| Maven | `pom.xml` | `.pacmon/maven/DEPENDENCY-NOTES.md` | `groupId:artifactId`: `## org.slf4j:slf4j-api` |
| Gradle | `build.gradle`, `build.gradle.kts` | `.pacmon/gradle/DEPENDENCY-NOTES.md` | `group:name` or the catalog alias: `## org.slf4j:slf4j-api`, `## libs.junit.jupiter` |
| Elixir / Mix | `mix.exs` | `.pacmon/mix/DEPENDENCY-NOTES.md` | the dependency application atom: `## phoenix`, `## ecto_sql` |
| Gleam / Hex | `gleam.toml` | `.pacmon/gleam/DEPENDENCY-NOTES.md` | the dependency key: `## gleam_stdlib`, `## gleeunit` |
| Zig | `build.zig.zon` | `.pacmon/zig/DEPENDENCY-NOTES.md` | the direct dependency field: `## known_folders` |
| Python | `pyproject.toml`, `requirements*.txt`, `requirements/*.txt` | `.pacmon/python/DEPENDENCY-NOTES.md` | the normalized distribution name: `## requests`, `## importlib-metadata` |
| Ruby | `Gemfile`, `gems.rb`, `*.gemspec` | `.pacmon/ruby/DEPENDENCY-NOTES.md` | the literal gem name as written: `## rails`, `## rspec` |
| .NET / NuGet | `*.csproj`, `*.fsproj`, `*.vbproj`, `Directory.Packages.props` | `.pacmon/nuget/DEPENDENCY-NOTES.md` | the case-insensitive package ID as written: `## Newtonsoft.Json` |
| Go | `go.mod` | `.pacmon/go/DEPENDENCY-NOTES.md` | the module path: `## github.com/spf13/cobra`, `## github.com/jackc/pgx/v5` |
| C/C++ / vcpkg | `vcpkg.json` | `.pacmon/vcpkg/DEPENDENCY-NOTES.md` | the case-insensitive port name: `## fmt`, `## openssl` |
| C/C++ / Conan | `conanfile.py`, `conanfile.txt` | `.pacmon/conan/DEPENDENCY-NOTES.md` | the case-insensitive package name before `/`: `## zlib`, `## openssl` |
| PHP / Composer | `composer.json` | `.pacmon/composer/DEPENDENCY-NOTES.md` | the case-insensitive package or platform name: `## monolog/monolog`, `## php`, `## ext-mbstring` |

VS Code supports every manifest in the table. JetBrains supports npm, Rust, Maven, Gradle, Mix, Gleam, Zig, Python, Ruby, PHP/Composer, NuGet, Go, vcpkg and Conan. The Visual Studio 2022+ VSIX currently supports the .NET/NuGet row only and reads the same `.pacmon/nuget/DEPENDENCY-NOTES.md` files, so NuGet notes move between all three IDEs without conversion.

Pacmon reads a manifest as text and never runs npm, Cargo, Maven, Gradle, Mix, Gleam, Zig, Python, pip, Poetry, uv, Ruby, Bundler, RubyGems, PHP, Composer, Go, .NET, MSBuild, NuGet, vcpkg, Conan or Python recipe code. It sees the direct dependencies written in the file:

- **npm:** `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`.
- **Rust:** `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]` and their `[target.…]` forms. A member's `serde.workspace = true` counts; `[workspace.dependencies]` itself does not.
- **Maven:** the `<dependencies>` of the project and its profiles, not `<dependencyManagement>` or plugin dependencies. Parent POMs are not read.
- **Gradle:** module coordinates and `libs.*` aliases in a `dependencies` block, not plugins, constraints, `project(…)`, `files(…)` or catalog bundles. The script is never run, so a dependency added by code is not seen.
- **Elixir / Mix:** literal dependency tuples in `def/defp deps` or an inline `deps: [...]` list, including Hex, Git, path and umbrella dependencies. Static `only` and `targets` options are shown as scopes; dynamically assembled lists are not run or guessed.
- **Gleam / Hex:** direct keys in `[dependencies]` and `[dev_dependencies]` in `gleam.toml`, including version, Hex, Git and path declarations. `manifest.toml`, transitive packages and other tables are not read.
- **Zig:** direct fields of the top-level `.dependencies` struct in `build.zig.zon`, including URL/hash, path and lazy dependencies. `build.zig`, system libraries and transitive dependencies are not evaluated.
- **Python:** named dependencies in standard project metadata, optional dependencies, dependency groups and build requirements; Poetry dependency tables and groups; uv legacy development dependencies; and named pip requirements. Includes, constraints, tool options, unnamed paths and lock files are not dependencies. Package names are matched case-insensitively with `.`, `_` and `-` treated alike.
- **Ruby:** literal `gem` calls in `Gemfile` or `gems.rb`, with literal group and platform scopes; plus literal `add_dependency`, `add_runtime_dependency` and `add_development_dependency` calls on the active specification receiver in `*.gemspec`. Ruby is never evaluated. Dynamic names, method/class/module bodies, `eval_gemfile`, `Gemfile.lock` and transitive gems are ignored. Gem names are matched exactly.
- **.NET / NuGet:** literal `PackageReference Include` items in C#, F# and VB project files; and `PackageVersion Include/Update` plus `GlobalPackageReference Include` items in `Directory.Packages.props`. Package IDs are matched case-insensitively. Imports, MSBuild expressions, project/framework references, downloads and transitive packages are not evaluated.
- **Go:** module paths in `require` directives of `go.mod`, including `// indirect` ones, shown with their own scope. A `tool` directive points at the required module that provides it. `replace`, `exclude`, `retract`, `go.work` and `vendor/` are not read as dependencies.
- **vcpkg:** string and object entries in the root `dependencies` array and in `features.<name>.dependencies`. Host dependencies keep a separate scope. Overrides, baselines, requested dependency features, configuration files, installed trees and transitive packages are not dependencies.
- **Conan:** references in the `requires`, `tool_requires`, `test_requires` and legacy `build_requires` sections of `conanfile.txt`; literal strings, lists or tuples in matching `conanfile.py` class fields; and literal first arguments to matching `self.*` calls. Dynamic expressions, lockfiles and transitive packages are not evaluated.
- **PHP / Composer:** package and platform requirements in the root `require` and `require-dev` objects of `composer.json`, including `php`, `php-*`, `hhvm`, `ext-*`, `lib-*` and Composer API packages. Names are matched case-insensitively. `provide`, `replace`, `conflict`, `suggest`, `composer.lock` and transitive packages are not dependencies.

Each ecosystem keeps its own notes file, even when two manifests share a folder. A manifest without a notes file of its own uses the nearest one above it for the same ecosystem.

## The notes file

One `## section` per direct dependency. People write under the heading. Agents write under `### Agent notes`.

```md
## express

HTTP API layer (SEC-1234).
Do not upgrade to v5 — the auth middleware is incompatible.

### Agent notes

- purpose: HTTP framework; serves the public REST API and the webhook receiver
- constraint: stay on ^4 — v5 changes router path matching and the session API
- verify: `vitest src/api` and the login e2e (`pnpm e2e:auth`)
- log: 2026-03 agent tried 5.0.1, 14 auth tests failed, reverted (PR #402)
- verified: 4.19.2
```

The file renders on GitHub as it is. A complete npm example is in [`docs/example-repo`](docs/example-repo/).

The file is the only place a note lives. Open it and write a section by hand,
and the manifest shows it at once: the mark before the dependency fills in,
and the first line of the note appears at the end of the line. Nothing is
generated, and nothing is cached anywhere else.

![helmet has no note; a section for it is written by hand in the notes file; the helmet line in package.json then carries the note](docs/media/notes-file.gif)

## Features

- Hover a dependency in its manifest to read its note.
- The first line of the note shows at the end of the dependency line.
- A mark before each dependency: filled when it has a note, hollow when it does not.
- Write a note from the manifest: in a side panel, a peek editor, or an input box.
- **Documentation Coverage** lists which dependencies have a note and which do not.
- Problems in the notes file show as warnings, most with a one-click fix.

## Dependency review and allowlisting

A notes file can serve as the allowlist of the packages a project has reviewed and accepted. Each accepted package gets a note that says why it was allowed, and the agent layer records its `risk` (security exposure, native code, licence obligations, maintenance), where it runs (`runtime`), whether it handles untrusted input (`exposure`), and a dated `log` of advisories, upgrades and rejected proposals. A dependency added to a manifest without a note shows a hollow mark and appears in **Documentation Coverage**, so an unreviewed dependency stands out. Pacmon makes it visible; it does not block the dependency.

## Getting started

1. Install Pacmon from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=kontra.pacmon). VSCodium, Cursor, Windsurf, code-server and other editors that use [Open VSX](https://open-vsx.org/extension/kontra/pacmon) install it from there. Rider, IntelliJ IDEA, RustRover, Android Studio, WebStorm and the other JetBrains IDEs install it from the [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/34295-pacmon). Visual Studio 2022 and newer install it from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=kontra.pacmon-visualstudio).
2. Open a supported manifest, such as `package.json`, `Cargo.toml`, `pom.xml`, `build.gradle`, `mix.exs`, `gleam.toml`, `build.zig.zon`, `pyproject.toml`, a supported requirements file, `Gemfile`, a gemspec, `composer.json`, `go.mod`, `Directory.Packages.props`, a .NET project file, `vcpkg.json`, `conanfile.py` or `conanfile.txt`. A hollow mark appears before every dependency that has no note yet.
3. Right-click a dependency and choose **Pacmon: Add/Edit Dependency Note**, or click the mark. Write one line.
4. The note now shows on hover and at the end of the line. Pacmon created the notes file for that ecosystem next to the manifest, and `.pacmon/AGENT-RULES.md` at the root of the workspace; commit them together with the manifest.

## AI agents

Every section has a second layer, `### Agent notes`, for AI coding agents. They write `- key: value` lines there: `purpose`, `constraint`, `verify`, `log`, `verified` and a few more. Agents never edit the text people wrote.

Run **Pacmon: Set Up AI Instructions** once. It writes the rules and the field list to `.pacmon/AGENT-RULES.md` and, in VS Code and JetBrains, adds a three-line pointer to the instruction files your agents already read: `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, `.github/copilot-instructions.md`. The rules say where each ecosystem keeps its notes and how it names its sections. From then on, an agent reads a dependency's section before it adds, upgrades or removes the dependency, and records what it did. Pacmon checks the agent lines: an unknown field or an empty value shows as a warning, with a fix.

![An agent in the terminal fills the notes for react; the package.json line gains its preview and the panel shows the agent lines](docs/media/demo-ai.gif)

Pacmon does not call any AI service. Agents use their own tools; Pacmon gives them the files and the rules.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `pacmon.decorations` | `preview` | The hint at the end of a line that has a note: `preview` (the first line of the note), `badge` (a small marker), or `off`. |
| `pacmon.inlineSource` | `human-first` | Which layer feeds the preview and leads the hover: `human-first`, `ai-first`, `human-only`, `ai-only`. |
| `pacmon.noteEntry` | `panel` | How you write a note from a manifest: `panel`, `peek`, `input`, `inputBeside`, or `comments` (experimental). |
| `pacmon.noteButtons` | `["iconLeft", "link"]` | Clickable ways into a note: `iconLeft`, `link`, `codelens`, `inlayHint`, `lightbulb`. |
| `pacmon.depos.url` | `http://localhost:3000` | Address of Depos (in JetBrains IDEs, **Depos address** under **Settings → Tools → Pacmon**, for every project), for the optional organization connection: **Sign in to Depos** in the Pacmon view, or the commands **Pacmon: Sign In to Depos**, **Sign Out of Depos**, **Show Depos Connection** and **Refresh Notes from Depos**. Requests are made only while you are signed in. `https` is required, except for `localhost`. See [Notes from Depos](#notes-from-depos). |
| `pacmon.monorepo` | `nearest` | Which notes file a manifest uses: the nearest one for its ecosystem, walking up, or only the one at the workspace root (`rootOnly`). |

The **Pacmon** view in the activity bar switches these without opening the settings editor.

Visual Studio exposes the corresponding choices in **Tools → Options → Pacmon** and in its Pacmon tool window, which opens beside Solution Explorer. Its native entry modes are `ToolWindow`, `QuickInput` and `OpenBeside`; it also provides Quick Info, a clickable Pacmon mark beside each package ID, inline previews, Ctrl+click navigation and Quick Actions in NuGet manifests.

## Notes from Depos

Depos is a web app that holds one note per package for a whole organization, shared by all its repositories. In VS Code and JetBrains IDEs (preview), sign in to Depos and every workspace folder — in a JetBrains IDE, the project's folder and each content root — whose GitHub repository is added to one of your organizations works in **org mode**:

- The hover, the note editor, the end-of-line preview and coverage show the organization's notes from Depos. `DEPENDENCY-NOTES.md` is not read or changed; an error at its top says it is no longer used and should be deleted.
- Organization admins edit these notes in the note editor, and the change goes to Depos. Other members read them.
- If someone else changed the note first, the save is refused and the editor fetches the new version.
- The organization's allowlist shows at each manifest line: Denied and Not listed packages are a warning in Audit and an error in Enforce, and the hover and the note editor show the result, its reason and a link to the package in Depos. A line you just added is checked at once.
- Pacmon keeps a copy of the notes and allowlist results on your machine, asks Depos only for what changed, and uses the copy while Depos cannot be reached. Signing out removes the copy.
- AI agents in VS Code (Copilot and others) get a "Depos notes" MCP server for the folder: they read the notes and check a package against the organization's allowlist before they add it. An admin's agent can also write agent fields, never the human text. Agents outside VS Code connect with an MCP key from Depos → Settings → AI agents. JetBrains IDEs have no way for a plugin to add an MCP server, so there **Copy Depos MCP Setup** puts an `.mcp.json` for the folder's repository on the clipboard; it reads the key from `DEPOS_MCP_KEY`.

To sign in, run **Pacmon: Sign In to Depos** (or use the Depos section of the Pacmon view; in a JetBrains IDE, **Tools → Sign In to Depos** or the DEPOS group of the Pacmon tool window). Your browser opens Depos; check that it shows the same code and approve. Every other folder, and everything while you are signed out, works from the notes files as before. The rules are in [docs/format.md](docs/format.md#the-organization-layer).

## Requirements

VS Code 1.101 or newer, a JetBrains IDE 2025.2 or newer, or Visual Studio 2022 or newer on Windows. Nothing else: Pacmon reads the manifests itself, so it needs no language runtime or package manager installation, and it reads and writes files in your workspace without making network requests. The one exception is the optional Depos connection in VS Code and JetBrains IDEs: it makes requests only while you are signed in, to sign in and out, to fetch your organization's notes and allowlist results, and to save a note you change. RubyMine or the Ruby plugin supplies Ruby editor integration in JetBrains IDEs; Pacmon still does not require a Ruby SDK. In VS Code it also works in VS Code for the Web (vscode.dev, github.dev), Remote-SSH, WSL and dev containers.

## Format reference

npm notes use the `dependency-notes/1` format. Cargo, Maven, Gradle, Mix, Gleam, Zig, Python, Ruby, Composer, Go, NuGet, vcpkg and Conan notes use `dependency-notes/2`, whose frontmatter also names the ecosystem. VS Code and JetBrains support every listed ecosystem, and the Visual Studio VSIX currently supports NuGet. The reference is [`docs/format.md`](docs/format.md).

## Contributing and license

Pacmon is an early preview and does not accept pull requests yet. Bug reports and feature requests are welcome as [issues](https://github.com/kontratek/pacmon/issues); see [CONTRIBUTING.md](CONTRIBUTING.md). Security problems: see [SECURITY.md](SECURITY.md).

Apache License 2.0 — see [LICENSE](LICENSE). "Pacmon" and the logo are trademarks of Kontra; see [TRADEMARK.md](TRADEMARK.md).
