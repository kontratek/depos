# Changelog

<!-- Write what changed under "Unreleased" as it lands, in the same pull request.
  Releasing (Actions -> Release -> Run workflow) renames that heading to the new
  version, uses the section as the release notes, and opens a fresh empty one.
  See docs/releasing.md. -->

## Unreleased

- **Notes from Depos in VS Code (preview).** The Pacmon view has a new
  **Depos** section: **Sign in to Depos** opens the browser, you check the
  code and approve it, and VS Code keeps the sign-in in its secret storage.
  Signed in, a workspace folder whose GitHub repository is added to one of
  your organizations in Depos uses that organization's notes in Depos:
  the hover, the note editor, the end-of-line preview and coverage show them,
  and `DEPENDENCY-NOTES.md` is not read or changed; an error on its first line
  says it is no longer used and should be deleted. The note editor's
  **Open notes file** and the hover's link to the notes file become **Open in
  Depos**, the package's page in Depos. Organization admins edit
  these notes in the note editor and the change goes to Depos; other members
  read them. If someone else changed the note first, the save is refused and
  the editor shows the new version. Pacmon keeps a copy of the notes on
  your machine, asks Depos only for what changed (at start, when the window
  gets focus, every 5 minutes, or with **Refresh Notes from Depos**), and
  uses the copy while Depos cannot be reached. **Show connection** tells which
  organization each folder belongs to; **Sign out** ends the sign-in in Depos
  too and removes the copy. Pacmon makes network requests only while you are
  signed in. The address is `pacmon.depos.url` (default
  `http://localhost:3000` until there is a public Depos); it must use `https`,
  except for `localhost`, and a workspace cannot set it.

- **The organization's allowlist in the editor (preview).** In org mode,
  Pacmon shows the allowlist result Depos decides for each package of the
  folder's repository. Denied and Not listed packages are marked at their
  manifest line: a warning when the ecosystem is set to Audit, an error in
  Enforce. The hover and the note editor show the result, the reason, the
  expiry, and **Open in Depos** for the package's page. A line you just added
  is checked at once, before you push it. An ecosystem set to Off shows
  nothing. Pacmon asks Depos again only when the allowlist changed, and uses
  the last copy while Depos cannot be reached.

- **AI agents read the notes from Depos in org mode (preview).** For each folder in org
  mode, Pacmon adds a "Depos notes" MCP server to VS Code, so Copilot and
  other agents in VS Code read the notes and check a package against the
  organization's allowlist before they add it. The agents of organization
  admins can also write the agent fields of a note; they never change the
  human text. The server uses your Depos sign-in, which Pacmon adds when the
  server starts and never saves in your MCP settings. `.pacmon/AGENT-RULES.md`
  tells agents to use these tools when they have them; run **Set Up AI
  Instructions** to refresh it. VS Code 1.101 or later is required.

- **Notes and the allowlist from Depos in JetBrains IDEs (preview).** The
  same organization connection as in VS Code. **Tools → Sign In to Depos**, or
  the new **DEPOS** group of the Pacmon tool window, opens the browser; you
  check the code and approve it, and the IDE keeps the sign-in in its password
  safe. Signed in, the project's folder and each content root whose GitHub
  repository is added to one of your organizations use that organization's
  notes from Depos: quick documentation, the marks, the end-of-line preview, coverage and
  the note editor show them, **Open DEPENDENCY-NOTES.md** opens them read-only,
  and `DEPENDENCY-NOTES.md` is not read or changed; a red banner at its top
  says it is no longer used and should be deleted, and the note editor's
  **Open notes file** becomes **Open in Depos**. Organization admins edit these notes in the note editor, which then
  always opens in the tool window; other members read them. Denied and Not
  listed packages are marked at their manifest line, a warning in Audit and an
  error in Enforce, and quick documentation and the note editor show the
  result, its reason, its expiry and **Open in Depos**. The copy on your
  machine is refreshed at start, when the IDE gets focus, every 5 minutes and
  with **Refresh Notes from Depos**. JetBrains IDEs have no way for a
  plugin to add an MCP server, so **Copy Depos MCP Setup** puts an `.mcp.json`
  for the repository on the clipboard instead: it reads an MCP key from the
  `DEPOS_MCP_KEY` environment variable, which an admin adds in Depos under
  Settings → AI agents. The address is **Depos address** under **Settings →
  Tools → Pacmon**, for every project; it uses the IDE's proxy and certificate
  settings. Pacmon makes network requests only while you are signed in.

- **Pacmon supports Ruby projects in VS Code and JetBrains/RubyMine.** Literal
  gems in `Gemfile`, `gems.rb` and `*.gemspec` get markers, hover, note editing
  and shared coverage backed by `.pacmon/ruby/DEPENDENCY-NOTES.md`. Groups,
  platforms, runtime dependencies and development dependencies retain their
  scopes. Parsing is static: Pacmon never runs Ruby, Bundler or RubyGems, and
  ignores dynamic declarations, `eval_gemfile`, `Gemfile.lock` and transitive
  gems.

- **Pacmon supports PHP/Composer projects in VS Code and JetBrains/PhpStorm.**
  Package and platform requirements in the root `require` and `require-dev`
  objects of `composer.json` get markers, hover, note editing and coverage
  backed by `.pacmon/composer/DEPENDENCY-NOTES.md`. Parsing is static: Pacmon never runs
  PHP or Composer, and ignores other package-link fields, `composer.lock` and
  transitive packages.

- **Pacmon supports C/C++ projects that use vcpkg or Conan in VS Code.**
  Dependencies in the root `dependencies` array and the
  `features.<name>.dependencies` arrays of `vcpkg.json`, in the `requires`,
  `tool_requires`, `test_requires` and `build_requires` sections of
  `conanfile.txt`, and in the literal requirement fields and `self.*` calls of
  `conanfile.py` get markers, hover, note editing and coverage backed by
  `.pacmon/vcpkg/DEPENDENCY-NOTES.md` and `.pacmon/conan/DEPENDENCY-NOTES.md`.
  vcpkg host dependencies keep a scope of their own. Parsing is static: Pacmon
  never runs vcpkg, Conan or the recipe's Python code, and ignores overrides,
  baselines, dynamic expressions, lockfiles and transitive packages.

- **The VS Code and Open VSX pages describe dependency review and
  allowlisting.** Like the Visual Studio Marketplace page, they say that a notes
  file can be the allowlist of the packages a project has reviewed and
  accepted, with their `risk`, `runtime`, `exposure` and advisory `log`, and
  that a dependency without a note is shown, not blocked. The README also says
  which editors add the pointer to agent instruction files.

- **The JetBrains Marketplace page links to https://pacmon.dev**, as the
  VS Code, Open VSX and Visual Studio Marketplace pages already do.

- **JetBrains IDEs write the same agent pointer as VS Code.** The three lines
  **Set Up AI Instructions** adds to `AGENTS.md`, `CLAUDE.md` and the other
  instruction files now name the Ruby, .NET/NuGet, vcpkg, Conan and
  PHP/Composer notes files too.

## 0.9.0 — 2026-09-29

- **Pacmon supports Gleam projects in JetBrains IDEs.** `gleam.toml` gets what
  VS Code has had since 0.8.0: markers, hover, note editing and coverage for the
  direct dependencies in `[dependencies]` and `[dev_dependencies]`, backed by the
  same `.pacmon/gleam/DEPENDENCY-NOTES.md`. The manifest is read statically, as
  in VS Code, so neither Gleam nor a Gleam language plugin is needed.

## 0.8.0 — 2026-09-29

- **Pacmon supports Gleam projects in VS Code.** Direct dependencies in the
  `[dependencies]` and `[dev_dependencies]` tables of `gleam.toml` get markers,
  hover, note editing and coverage backed by `.pacmon/gleam/DEPENDENCY-NOTES.md`.
  Version, Hex, Git and path declarations are read statically; Pacmon never runs
  Gleam, reads `manifest.toml` or resolves transitive packages. JetBrains support
  remains a later step.

- **Pacmon is on the Visual Studio Marketplace.** Visual Studio 2022 and newer
  install it from
  [its listing](https://marketplace.visualstudio.com/items?itemName=kontra.pacmon-visualstudio)
  or from Extensions → Manage Extensions, and every release now publishes it
  there alongside the VS Code and JetBrains versions. `pacmon-visualstudio.vsix`
  is also attached to each GitHub Release. The extension links to
  https://pacmon.dev and to this changelog.

- **Visual Studio reads and formats notes the way VS Code and JetBrains do.**
  It no longer reports `risk`, `usage`, `owner`, `alternatives`, `remove-when`
  and `links` as unknown fields, a warning whose fix moved the line under
  `note:`, and it now checks the values of `runtime`, `exposure`, `status` and
  `verified`. **Format NuGet Dependency Notes** keeps duplicate sections, the
  text under the title and the frontmatter as written, all of which it used to
  drop, and writes the same header comment as the other editors. **Set Up AI
  Instructions** writes the same `.pacmon/AGENT-RULES.md` as VS Code and
  JetBrains, with the field list agents need, and the first note written in
  Visual Studio now creates it.

## 0.7.0 — 2026-09-29

- **Pacmon supports .NET/NuGet projects in VS Code, JetBrains/Rider and Microsoft Visual Studio 2022+.** Literal `PackageReference`
  items in `.csproj`, `.fsproj` and `.vbproj` files, plus central
  `PackageVersion` and `GlobalPackageReference` items in
  `Directory.Packages.props`, get markers, hover, note editing and coverage
  backed by `.pacmon/nuget/DEPENDENCY-NOTES.md`. Parsing is static: Pacmon does
  not run .NET, MSBuild or NuGet, follow imports, or resolve transitive packages.
  The new Windows VSIX adds Visual Studio-native Quick Info, clickable inline
  Pacmon marks, previews, Ctrl+click navigation, Quick Actions, a two-layer note editor,
  coverage and notes-file linting. CI produces `pacmon-visualstudio.vsix`; its
  separate Marketplace publication remains a later step.

## 0.6.0 — 2026-09-25

- **Pacmon supports Go projects in VS Code and JetBrains.** Module paths in the
  `require` directives of `go.mod`, single-line or in a block, get markers,
  hover, note editing and coverage backed by `.pacmon/go/DEPENDENCY-NOTES.md`;
  `// indirect` requirements are included with a scope of their own. A `tool`
  directive belongs to the required module that provides it. Parsing is static:
  Pacmon never runs Go, and `replace`, `exclude`, `retract`, `go.work` and
  `vendor/` are not read as dependencies.

- **The listings and the agent rules point at pacmon.dev.** The VS Code
  Marketplace and Open VSX pages link to https://pacmon.dev instead of the
  GitHub README, and `.pacmon/AGENT-RULES.md` and the JetBrains Marketplace page
  give https://pacmon.dev/format/ as the format reference.

## 0.5.0 — 2026-09-24

- **Pacmon supports Python projects in VS Code and JetBrains.** Standard,
  Poetry and uv dependencies in `pyproject.toml`, plus named dependencies in
  common pip requirements-file layouts, get markers, hover, note editing and
  coverage backed by `.pacmon/python/DEPENDENCY-NOTES.md`. Parsing is static:
  Pacmon does not run Python or package-management tools, follow includes, or
  treat constraints and lock data as direct dependencies.

- **Pacmon supports Zig projects in VS Code and JetBrains.** Direct fields in
  the top-level `.dependencies` struct of `build.zig.zon` get markers, hover,
  note editing and coverage backed by `.pacmon/zig/DEPENDENCY-NOTES.md`.
  URL/hash, path and lazy dependencies are read statically; Pacmon never runs
  Zig, evaluates `build.zig` or follows transitive dependencies.

- **Pacmon supports Elixir/Mix projects in VS Code and JetBrains.** Literal direct
  dependencies in `mix.exs` get the same markers, hover, note editor and coverage
  as the other manifests, with notes in `.pacmon/mix/DEPENDENCY-NOTES.md`.
  Hex, Git, path and umbrella tuples are read statically; Pacmon never executes Mix
  or project code, and dynamically assembled dependency lists are left alone.

- **The JetBrains plugin no longer throws an error in IntelliJ IDEA 2026.3.** The
  note lightbulb was registered once per manifest language, and 2026.3 refuses an
  intention registered more than once. It is now registered once, for every
  language, and still appears only on a dependency line in a manifest.

- **The warnings in a notes file keep up with its text in VS Code.** Two checks of
  the same file could finish out of order, and the older one's result then stayed
  until the next edit. A check that finishes after a newer one has started is now
  dropped.

## 0.4.0 — 2026-09-23

- **Pacmon reads `Cargo.toml`, `pom.xml` and Gradle build files, not only
  `package.json`.** A Rust, Maven or Gradle manifest gets what a
  `package.json` has, in VS Code and in the JetBrains plugin: the mark before
  each dependency, the first line of its note at the end of the line, the
  whole note on hover, the note editor and **Documentation Coverage**. Each
  ecosystem keeps its notes in a file of its own beside the manifest —
  `.pacmon/cargo/DEPENDENCY-NOTES.md`, `.pacmon/maven/DEPENDENCY-NOTES.md`,
  `.pacmon/gradle/DEPENDENCY-NOTES.md` — so a folder with both a
  `package.json` and a `Cargo.toml` keeps the two apart. A section carries the
  name the manifest gives the dependency: its key in a Cargo dependency
  table, `groupId:artifactId` in Maven, `group:name` or the `libs.*` alias in
  Gradle. Pacmon reads each manifest as text and runs none of the build
  tools, so it sees what is written in the file: not what a parent POM adds,
  and not a dependency a Gradle script adds with code. The new files are
  `dependency-notes/2`, whose frontmatter also names the ecosystem; npm notes
  stay `dependency-notes/1` and need nothing. **Open package.json** is now
  **Open Dependency Manifest**.
- **Set Up AI Instructions covers every ecosystem.** `.pacmon/AGENT-RULES.md`
  names the four notes files and spells out the section heading for each
  manifest, with an example, and the pointer it writes into `AGENTS.md`,
  `CLAUDE.md` and the rest names the four files too. An agent that adds a
  crate or bumps a Maven artifact finds the right file and writes the right
  heading.

## 0.3.3 — 2026-09-23

- **A release submits the JetBrains plugin too.** The plugin was uploaded by
  hand and kept a version number of its own: `build.gradle.kts` said 0.3.1
  while the extension shipped 0.3.2. It now reads `package.json`, so the
  Release workflow raises one version for the whole repository and the plugin
  follows. Its "What's New" was a `<change-notes>` block written into
  `plugin.xml` beside the real notes in this file, and went stale the way a
  second copy does; it is now that version's section here, rendered to HTML at
  build time. One version number and one set of notes serve the Visual Studio
  Marketplace, Open VSX and the JetBrains Marketplace. The run submits rather
  than publishes: JetBrains reviews every version by hand and lists it
  normally within two business days.
- Run workflow with **`none`** publishes the version already in `package.json`
  to whichever registry still lacks it, commits nothing, and refuses a version
  that was never released — the path for a registry that joined after a
  release, rather than spending a version number to reach it.

## 0.3.2 — 2026-09-16

- **Pacmon comes to JetBrains IDEs.** The `jetbrains/` module is a plugin
  for IntelliJ IDEA, WebStorm, PyCharm, PhpStorm and the rest of the family:
  the same `.pacmon/DEPENDENCY-NOTES.md`, read and written the same way. A
  mark before each dependency in `package.json`, the first line of the note
  at the end of the line and the whole note as quick documentation; a Pacmon
  tool window with documentation coverage, the settings and a note editor
  with a layer for people and a layer for agents; the format warnings
  underlined live in the notes file, with **Format DEPENDENCY-NOTES.md** to
  rewrite it into canonical form; **Set Up AI Instructions** and the rest in
  the Tools menu. The rules are a hand-written port of `src/core`, kept in
  step by hand. The plugin carries the extension's version number, its logo
  is the mark on the dark disc, and it is on the JetBrains Marketplace as
  plainly [Pacmon](https://plugins.jetbrains.com/plugin/34295-pacmon);
  `jetbrains/README.md` says how it is built, verified and published.

- **The JetBrains plugin offers everything the VS Code view does.** The tool
  window had coverage, one checkbox for the mark and one for the end-of-line
  preview; the extension's view has six sections, and the plugin now has the
  same six under the same names. All five click targets are there —
  `iconLeft`, `link` (Ctrl+click the package name, a go-to-declaration
  target), `codelens` (a clickable line above the dependency), `inlayHint`
  (the words at the end of the line) and `lightbulb` (an intention on the
  caret line) — each one drawn only while its box is ticked. Note markers
  became the three-way choice they are in VS Code (`preview`, `badge`,
  `off`), the inline note source moved out of the Settings dialog and into
  the tool window beside the rest, and the note editor can open as a popup
  over the dependency line (`peek`) instead of in the tool window (`panel`).
  The Actions section reaches the same five commands the view does, including
  **Documentation Coverage**, which is now the searchable list of every
  dependency it is in VS Code rather than a second way to show the tool
  window. **Open package.json** and **Toggle Note Markers** join the Tools
  menu, **Open DEPENDENCY-NOTES.md** works from anywhere in the project
  rather than only from inside `package.json`, and a Reset link puts the
  whole view back to its defaults. The Settings page under Tools → Pacmon
  lists the same settings for anyone who looks there first.

- **The JetBrains tool window shows what each choice does, not just what it is
  called.** Every click target and every note marker now carries a sample
  `package.json` line drawn with the editor's own font and colors — the mark
  before the name, the underlined name, the line above, the chip at the end,
  the lightbulb, and for the markers the note text, the badge, or nothing.
  This is the one thing the VS Code view is a webview for rather than a tree,
  and the reason it matters here is `badge`: it was drawing the marker alone,
  where the VS Code extension writes the marker and the word `note`. The
  marker on its own reads as a stray character, so the plugin now writes
  `▪ note` too, and the sample settles what the name never could.

- **A setting changed in the JetBrains tool window reaches `package.json` at
  once.** It used to reach it when you next edited the file, or closed and
  reopened it: the inlay pass stamps the project's PSI modification count
  onto an editor as it collects the marks, and skips that editor while the
  count still matches — and nothing about ticking a click target moved it, so
  the marks stayed exactly as they were. The settings path now moves the
  count, and every refresh also repaints the open editors, because the
  end-of-line markers are painted onto the editor rather than produced by a
  pass and the daemon would never have brought them back. Saving a note is
  unaffected: writing the notes file moves the count by itself, so the
  autosave path stays as cheap as it was.

## 0.3.1 — 2026-09-15

- The README shows the notes file being written by hand. The two recordings
  showed the note panel and an agent, and neither showed the file, which left
  the README's own claim — every note in one Markdown file you edit like any
  other — with nothing behind it. The third recording is the loop: `helmet`
  has no note, a section for it is written by hand in the notes file, and the
  `helmet` line in `package.json` comes back carrying it. The paragraph above
  it says the same in words: the file is the only place a note lives, and
  nothing is generated or cached anywhere else.

## 0.3.0 — 2026-09-14

- **The extension says "Dependency Notes" everywhere now.** The display name,
  the activity bar view and the README said "Dependency Docs" while the file,
  the format and the title said notes. The README is rewritten around the notes
  file and the agent layer, with two recordings, and names Open VSX next to the
  Marketplace. `CONTRIBUTING.md` and `SECURITY.md` say how to report a bug or
  a vulnerability; pull requests are not accepted yet.
  The `npx pacmon` stub said "Dependency Docs" and pointed at the old
  `.pacmon/DEPENDENCIES.md`; it says what the extension says now.
- **Fix: a setting in the Pacmon view could be set and stay unset.** The view
  shows each setting's effective value but wrote the user one, so a workspace
  value on top of it swallowed the click and the control snapped back with
  nothing to explain why — reachable through "Toggle Note Markers", which
  writes the workspace on purpose, and through any repository that ships these
  in its own `.vscode/settings.json`. Writes now land in the target that
  already defines the value, user settings otherwise. "Reset to Defaults"
  clears both, instead of leaving a workspace value standing after a reset.
- Fix: every switch in the view now has a name. The label around the track held
  no text, so a screen reader read an unnamed checkbox and the 30px track was
  the only place you could click; the words beside it are the label now, and
  the help line below is the description.
- Fix: the "Search dependencies…" action said it filtered "the list below".
  There is no list below — the view holds statistics, deliberately. It says
  what the action opens instead.
- Fix: `pacmon.noteButtons` claimed everything except `lightbulb` marks
  dependencies that have no note yet. `link` does not: it is drawn over every
  dependency name alike and only its tooltip tells the two apart — as the
  option's own description already said.
- The preview at the end of a `package.json` line runs to 90 characters
  instead of 48, so a first line of prose more often arrives whole.
- The integration suite reads the demo fixture again. It still looked for a
  package and a version the fixture stopped carrying, and hung two
  assertions on the first agent block in the file rather than the one under
  test. `helmet` is the one dependency the fixture leaves undocumented,
  which is what the marks, the coverage view and two of these tests need;
  its section had been written into the fixture while recording, and out of
  order at that.

## 0.2.0 — 2026-09-14

- **A note being read now looks like a note, not like an empty box.** In the
  note panel a layer at rest is text on the page — no frame, no fill.
  Hovering fills it the way VS Code fills a list row; the framed, filled box
  appears only while you are writing in it. The two are otherwise one box:
  the same floor however little the note says, and their text at the same x,
  so clicking into a layer draws the frame around the words without moving
  anything. Each layer carries a caption now — "Your
  note", "Agent notes" — since the frame is no longer there to name it, and
  "Your note" carries a small pen: the fill, the frame and the caret all wait
  for the mouse, so the pen is the only cue that says the text can be written
  in before you reach for it. It is drawn inline, because a webview under
  default-src 'none' cannot load the codicon font.
- **The mark replaces the pencil.** The glyph before a dependency name is now
  the Pacmon mark itself: filled when the dependency has a note, hollow when it
  does not. The state is carried by the shape rather than the colour, so it
  survives colour blindness; colour is the second channel, and the two marks
  are kept two stops apart in lightness on both editor themes (2.0:1 on Dark+,
  2.1:1 on Light+). Drawn at 12 px from four baked SVGs — two states, two
  themes — because an image attachment takes no `ThemeColor`.
- The activity bar icon is the mark too, replacing the generic document glyph
  that had nothing to do with the logo.
- Each state is its own decoration type instead of a per-dependency
  `renderOptions`. VS Code turns every distinct `renderOptions` object into its
  own dynamic CSS rule; two fixed types mean two rules and no per-dependency
  hashing, however long the dependency list.
- **The format is `dependency-notes/1`, in `.pacmon/DEPENDENCY-NOTES.md`.** The
  same layout as `deps-notes/1` in `.pacmon/DEPENDENCIES.md`; the names now say
  what the file holds, and the file name and the format name agree. A file
  that still says `deps-notes/1` gets an "unknown format" warning on that
  line, and a `.pacmon/DEPENDENCIES.md` is no longer read — rename it. The
  `agents:` frontmatter key is no longer written: it repeated the header
  comment. Existing lines are kept and ignored.
- **`.pacmon/AGENT-RULES.md` replaces `.pacmon/AGENTS.md`**, so the file no
  longer shares a name with the root `AGENTS.md`. It is a hand-written file
  shipped with the extension (`assets/AGENT-RULES.md`) and copied into the
  workspace, not generated from code.
- The pointer block in `AGENTS.md`, `CLAUDE.md` and friends sits between
  `<!-- pacmon:start -->` and `<!-- pacmon:end -->`. Set Up AI Instructions
  still finds a block with the old markers and replaces it.
- `docs/format.md` is the reference for the format; `docs/example-repo/` is a
  complete example, lint-checked by the unit tests.
- The title of the notes file is `# Dependency Notes`, matching the file name.

## 0.1.1 — 2026-09-11

- New icon: the mark now sits on a dark disc, so it holds its shape against a
  light background as well as a dark one.

## 0.1.0 — 2026-09-11

Format round (2026-09-05):

- **`deps-notes/1` is a layered format.** The text right under `## name` is
  written by people and never parsed beyond its first line; `### Agent notes`
  holds `- key: value` lines written by AI agents (`purpose`, `usage`,
  `constraint`, `verify`, `log`, `verified`, plus `risk`, `runtime`,
  `exposure`, `bump-with`, `remove-when`, `alternatives`, `owner`, `status`,
  `links` when they apply); `### Generated` is reserved for a later release.
  The earlier flat draft of `/1` (`- why:` / `- caution:` bullets) was never
  released, so the version number stays and now means the layered format.
  Frontmatter gains `lang` (default `en`) and `agents`.
- **Everything Pacmon owns lives in `.pacmon/`.** Notes are
  `.pacmon/DEPENDENCIES.md` next to each package.json (nearest wins, as before);
  the rules agents follow are the generated `.pacmon/AGENTS.md` at the workspace
  root — created with the first note, regenerated by "Set Up AI Instructions",
  which now leaves only a three-line pointer in AGENTS.md / CLAUDE.md and
  friends. A root-level `DEPENDENCIES.md` is no longer recognized, and
  `pacmon.notesFile` is gone: the layout is part of the format.
- New setting **`pacmon.inlineSource`** (`human-first` default, `ai-first`,
  `human-only`, `ai-only`): which layer feeds the end-of-line preview and leads
  the hover. The hover always shows both layers, separated by a rule. Also a
  radio group in the Pacmon view.
- The note panel edits both layers: the human text in the main box, the agent
  block in a folded, editable box below it with a line count. The
  `- why:` / `- caution:` insert buttons went with the flat format.
- The header comment at the top of the notes file is owned by the format:
  three lines, rewritten by "Format DEPENDENCIES.md". Repository-wide rules go
  in the text between the title and the first section.
- A section kept for a package that left package.json (`- status: removed
  2026-06 — reason`) is no longer flagged as an orphan.
- Fix: the peek editor and the "empty input opens the file" path recreated the
  section with an empty body, wiping an existing note. Both now only make sure
  the section exists.
- Fix: writing a note right after `.pacmon/` was deleted could trust a stale
  cache entry (or a just-closed editor's copy) and skip the creation path. The
  writer now checks the disk.
- The note panel shows each layer rendered (VS Code's own Markdown engine,
  offline; a small fallback when that extension is disabled); click to edit,
  `Esc` when done, and it saves as you type — no Save button. The boxes size
  to their content, and a dependency without a note opens straight into
  writing. Rendered markup passes a sanitizer before it enters the page.
- The agent block is linted: a key outside the vocabulary gets an
  information diagnostic with two quick fixes (keep it as `- note: …`, or
  remove the line); empty values and malformed `runtime` / `exposure` /
  `status` / `verified` values are flagged too. The human text is never
  checked. `note` joins the vocabulary for anything that fits no other field.
  A misspelt key (`contraint`, `bump_with`, `notes`) gets "Change to …" as
  the preferred fix, and `source.fixAll.pacmon` rewrites every unknown key in
  one go — by hand with Fix All, or on save via `editor.codeActionsOnSave`.
- The note panel's read-mode box keeps the editor's size (about six lines)
  even when the note is empty, so an empty note is still visibly a box.
- Agent-block problems are now warnings (yellow, counted in the status bar,
  tinting the tab), underlined on the key or value alone, and made visible
  five ways: the message at the end of the line with a faint line tint, a
  code lens above the block ("⚠ 2 problems in this block — fix all"), a
  "⚠ 2" status bar item while the notes file is active, the problems listed
  under the agent box in the note panel with a Fix button, and the quick fix
  offered with the caret anywhere on the line. Still no notifications.
- A section whose package is not in package.json is no longer a diagnostic
  at all: it gets a yellow ⚠︎ before its heading — a marker, not a problem —
  because a removed package's notes are worth keeping and a marker does not
  nag. The hover names a near-miss dependency ("did you mean lodash?") or
  says the section is marked removed. Everything Pacmon still reports is a
  warning: one colour, one meaning.
- Headings are the format's: `# Dependencies` exactly once (the normalizer
  now writes it, like the header comment), `## name` per package, and inside
  a section only `### Agent notes`. A second `#`, another title, or a `###`
  heading in a section is flagged with "Make it plain text" (the words stay,
  bold) or, for `### Agent Note` / `### AI notes`, "Change to `### Agent
  notes`" — a misspelt agent heading used to make the whole block invisible.
- Also flagged: `status: removed` on a package that is still in package.json
  (remove the line), and a `format:` version this Pacmon does not read.
- A heading with nothing under it no longer counts as documentation: the
  coverage ratio, the `✎` glyph and the hover treat it as no note.
- `.pacmon/AGENTS.md` is now written by every note write, not only when the
  notes file itself is created — a repository can arrive with the one and not
  the other.

Feedback round (2026-09-03):

- **Primary note entry is now a note editor in a panel beside `package.json`**
  (Ghost Note-style): multi-line Markdown, `- why:` / `- caution:` insert
  buttons, Ctrl/Cmd+S to save, and in-memory drafts so unsaved text survives
  switching dependencies or hiding the panel. The webview loads nothing from
  disk or the network (`localResourceRoots: []`, CSP `default-src 'none'`).
  `pacmon.noteEntry`: `panel` (default) / `peek` / `input` / `inputBeside` /
  `comments`.
- Previously the primary entry was the embedded peek editor below the
  dependency line — still available as `pacmon.noteEntry: "peek"`.
- **Two clickable ways into a note from `package.json`** (`pacmon.noteButtons`):
  `iconLeft`, a glyph just before the package name that opens the note on a
  plain click and shows a hand cursor, and `link`, the package name itself on
  `Ctrl`+click. Both switchable; `[]` leaves package.json untouched and the
  right-click menu still works. `iconLeft` marks dependencies with no note yet,
  which is why it can be turned off.
- Fix: `pacmon.decorations: "off"` could do nothing. A hidden per-workspace flag
  outranked the setting entirely, and the fallback under it read
  `=== 'badge'`, so even `preview` only showed markers if that flag happened to
  be set. The setting is now the single source of truth, and "Toggle Note
  Markers" writes it (to the workspace) instead of a flag you cannot see.
- Fix: switching `link` on or off did nothing until the file changed.
  `DocumentLinkProvider` has no change event and VS Code caches what it
  returns, so returning an empty list cannot retract links — the registration
  is now created and dropped by hand.
- Changing any setting in the Pacmon view now brings `package.json` into view
  when none is on screen — as a preview tab, without taking focus, so a run of
  toggles stays a run of toggles. Every setting there changes how the manifest
  looks; hiding the result made the panel a blind box.
- The Pacmon view leads with **Coverage**: the documented/total ratio for the
  package.json you are in, a progress bar, and how many notes are still
  missing. Statistics only — which dependencies have notes is already visible
  on the manifest, so the view does not repeat the list.
  `Pacmon: Documentation Coverage` remains the browse-and-search path.
- New command **`Pacmon: Open package.json`**, the mirror of "Open
  DEPENDENCIES.md", and the notes-file action is now labelled with the actual
  configured file name instead of the words "notes file".
- **A Pacmon view in the activity bar**: a switch per click target with a live
  preview of what each does to a package.json line, radio groups for the note
  editor and the marker style, and the four commands. Built first as a tree and
  rebuilt as a webview — a tree gives you a label, a description and an icon,
  which is not enough to SHOW an option. Same guarantees as the note editor:
  `localResourceRoots: []`, CSP `default-src 'none'`, markup bundled, and an
  allowlist on the commands it may run.
  This softens the "no sidebar" line in the README: the view holds settings and
  commands only, never a list of your dependencies, and nothing opens it for you.
- Chosen out of a five-way comparison; the other three stay one checkbox away
  rather than being removed: CodeLens above the line
  (doubles the file's apparent height), an end-of-line inlay chip (competes with
  the note preview, needs Ctrl+click anyway), a lightbulb code action (two
  clicks). Only "a plain click anywhere on the line" was dropped outright — it
  took clicks meant for the text. `iconLeft` is a decoration rather than an
  inlay hint because only decorations expose `cursor`.
- Test fix (pre-existing flake): the context-menu invocation test read the
  notes file once, immediately after the command; the write lands on disk or
  through the open document's save depending on whether the previous test's
  restore has settled. It now waits for the content. Failed roughly 1 run in 3,
  now 5/5 green.
- Note panel reloads are generation-guarded, so retargeting faster than the
  file reads complete can no longer publish stale state.
- Context-menu invocation fixed (editor menus pass a Uri as the first
  argument); every command now reports failures to Output → Pacmon.

- Inline note **preview** on documented lines (first line of the note, truncated) — new default; `pacmon.decorations`: `preview`/`badge`/`off`.
- Single-line notes are now **edited inline** too (input box pre-filled); multi-line notes open in the file.
- Fixture workspaces ship with `npm.fetchOnlinePackageInfo: false`; README documents the setting (the "latest version / Loading…" hover content is VS Code built-in, not Pacmon).

Initial scope:

Initial version.

- Hover notes on `package.json` dependencies, sourced from `DEPENDENCIES.md` (`deps-notes/1` format).
- Subtle end-of-line marker on documented lines only.
- Add/Edit Dependency Note (right-click or command; creates the file with a template, inserts sections in alphabetical order).
- Format DEPENDENCIES.md (canonical ordering/headings; note bodies untouched).
- Documentation Coverage quick pick.
- Set Up AI Instructions (AGENTS.md / CLAUDE.md / .cursor/rules / copilot-instructions.md).
- Gentle diagnostics on the notes file: orphan and duplicate sections.
- Monorepo support: nearest notes file wins (`pacmon.monorepo`).
- Fully offline; no telemetry; web-extension compatible (VS Code Web, Remote, dev containers).
