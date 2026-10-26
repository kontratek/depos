# Depos for JetBrains IDEs

The JetBrains counterpart of the [VS Code extension](../README.md): the same ecosystem-specific dependency notes, read and written the same way, inside Rider, IntelliJ IDEA, WebStorm and the rest of the JetBrains family. npm uses `.depos/DEPENDENCY-NOTES.md`; Cargo, Maven, Gradle, Mix, Gleam, Zig, Python and NuGet use their own `.depos/<ecosystem>/DEPENDENCY-NOTES.md` — or `.pacmon/…`, the same layout under its name from before Pacmon became Depos, which is still read. `docs/format.md` (at the repository root) is the authority on the formats both clients read; this module keeps its own hand-written port of the same rules, not a shared library.

## What it does

- A **Depos** tool window (right stripe) with two views: a dashboard (documentation coverage, click-target and note-marker settings) and a per-dependency editor with separate human and agent layers.
- Small inlay icons at dependency declarations in `package.json`, `Cargo.toml`, Maven `pom.xml`, `build.gradle`, `build.gradle.kts`, `mix.exs`, `gleam.toml`, `build.zig.zon`, `pyproject.toml`, pip requirements files, `go.mod`, .NET project files and `Directory.Packages.props` — filled when they have a note, hollow when they do not — plus an end-of-line preview and a quick-doc hover.
- Live `docs/format.md` warnings, underlined with a hover message, wherever `DEPENDENCY-NOTES.md` is open.
- Commands under **Tools → Depos** — **Open DEPENDENCY-NOTES.md**, **Open Dependency Manifest**, **Documentation Coverage**, **Toggle Note Markers**, **Set Up AI Instructions**, **Format DEPENDENCY-NOTES.md**, **Move Notes to .depos/**, and the organization connection — and **Add/Edit Dependency Note** in the editor's context menu.
- Pure Kotlin manifest parsers; Rust, TOML, Maven, Groovy, Kotlin, Gradle, Elixir, Zig, ZON, Go, .NET, MSBuild and NuGet tooling are not required. When optional language plugins such as ZigBrains are installed, Depos also registers directly for their language support.

## Requirements

- JDK 21
- No local Gradle install needed — use the wrapper (`./gradlew` / `gradlew.bat`)
- First build downloads IntelliJ IDEA Community 2025.2.6.2 as a dependency (a few hundred MB, cached under `~/.gradle` afterwards)

## Building

Run these from `jetbrains/`:

| Command | What it does |
|---|---|
| `./gradlew test` | Compiles and runs the unit test suite (JUnit, no IDE needed) |
| `./gradlew buildPlugin` | Produces the installable plugin zip at `build/distributions/pacmon-jetbrains-<version>.zip` |
| `./gradlew runIde` | Launches a sandboxed IntelliJ IDEA with the plugin installed, for manual testing |
| `./gradlew verifyPlugin` | Runs the IntelliJ Plugin Verifier against the IDEs listed in `pluginVerification.ides` (`build.gradle.kts`) |

To install a built zip into your own IDE: **Settings → Plugins → ⚙ → Install Plugin from Disk...** and pick the zip.

If a `test` run reports failures that don't match the source (a signature you just changed, a test that passed a moment ago), rerun with `--rerun-tasks` before trusting the result — Gradle's build cache has been seen serving stale compiled test classes after an ABI change in this project.

## Code structure

```
src/main/kotlin/dev/pacmon/jetbrains/
├── core/      Pure logic — no IntelliJ platform imports except where noted. Hand-ported
│              from src/core/*.ts at the repository root; keep the two in sync by hand.
│   ├── NotesCore.kt      parse/serialize the notes file, compose and splice layers,
│   │                     canonical form (docs/format.md "Canonical form")
│   ├── NotesModel.kt     the data classes NotesCore.parse produces (sections, frontmatter,
│   │                     layer ranges, lint spans)
│   ├── NotesLint.kt      the full format lint — a line-for-line port of src/core/lint.ts
│   ├── LintFinding.kt    one sealed class per lint finding kind, with its message()
│   ├── ManifestCore.kt   the npm, Cargo and Maven adapters and source-range parsers
│   ├── GradleManifest.kt the Groovy/Kotlin DSL Gradle adapter and source-range parser
│   ├── MixManifest.kt    the static Elixir/Mix dependency parser
│   ├── GleamManifest.kt  the static gleam.toml dependency parser
│   ├── ZigManifest.kt    the static build.zig.zon dependency parser
│   ├── PythonManifest.kt the static pyproject.toml and pip requirements parsers
│   ├── NugetManifest.kt  the static .NET project and central package parser
│   ├── Xml.kt            the shared tolerant XML reader for Maven and NuGet
│   ├── GoManifest.kt     the static go.mod require/tool parser
│   ├── AgentNotes.kt     agent-layer field lint used live in the note editor's side panel
│   └── AiInstructions.kt the AGENTS.md/CLAUDE.md pointer block ("Set Up AI Instructions")
│
├── editor/    Wiring into dependency manifest editors and the notes file editor.
│   ├── DependencyPsi.kt            bridges manifest source ranges to IntelliJ PSI entry points
│   ├── PacmonInlayHintsProvider.kt the inlay icon before each dependency name
│   ├── PacmonLinePainter.kt        the end-of-line note preview
│   ├── PacmonDocumentationProvider.kt  the quick-doc hover
│   └── PacmonNotesAnnotator.kt     live NotesLint warnings in DEPENDENCY-NOTES.md,
│                                   as an `Annotator` for TEXT and (optionally) Markdown
│                                   — the two languages an .md file can get
│
├── service/   Project-level state and file I/O.
│   ├── PacmonProjectService.kt  settings, cached manifest parsing, ecosystem-specific
│   │                            note resolution, AGENT-RULES.md and workspace indexing
│   └── PacmonNotesListener.kt   message-bus topic other components subscribe to when
│                                 the notes file changes (including from outside the IDE)
│
├── settings/  PacmonConfigurable.kt — the Settings → Tools → Depos page
│
├── ui/        The tool window's Swing UI (Kotlin UI DSL where practical, plain Swing
│              where a custom layout is needed).
│   ├── PacmonToolWindowFactory.kt    registers the tool window
│   ├── PacmonToolWindowRootPanel.kt  CardLayout switch between dashboard and editor
│   ├── PacmonToolWindowService.kt    project service that owns the panel and routes
│   │                                 "open this dependency" requests into it
│   ├── PacmonDashboardPanel.kt       the coverage/settings view
│   ├── PacmonToolWindowPanel.kt      the per-dependency editor (header, layers, footer)
│   ├── NoteLayerPanel.kt             one editable layer: read view / textarea, autosize
│   └── PacmonMarkdown.kt             the small Markdown renderer behind the read view
│
└── action/    AnAction entry points wired in plugin.xml (Tools → Depos menu, editor popup menu),
               and the move of the notes from .pacmon/ to .depos/ (MoveNotes.kt).
```

`src/test/kotlin/...` mirrors this layout. Parser, format, resolver, editor integration, and tool-window behavior are covered by `BasePlatformTestCase`-based tests.

### Keeping this in sync with the TypeScript core

Per the repository's `CLAUDE.md`: when `docs/format.md` changes, update `src/core/*.ts` first, then this module's `core/` package by hand, in the same commit. `NotesLintTest.kt` and `NotesCoreTest.kt` mirror scenarios from `src/test/unit/lint.test.ts` and `parseNotes.test.ts` — when you add a case to one side, add its counterpart to the other.

## Publishing to the JetBrains Marketplace

The plugin is published under the **Kontra** vendor profile, [plugins.jetbrains.com/vendor/kontra](https://plugins.jetbrains.com/vendor/kontra); sign in with a JetBrains Account that belongs to it. The `<vendor>` name in `plugin.xml` is that profile's name and must stay in step with it.

The plugin is [Depos](https://plugins.jetbrains.com/plugin/34295) on the Marketplace (Pacmon before the rename), id 34295, plugin id `dev.pacmon.jetbrains`, which stays. Its first version was uploaded by hand, as the Marketplace requires of every new plugin; every version since is submitted by the repository's Release workflow, together with the VS Code extension — see `docs/releasing.md`. Nothing here is released from a laptop.

**What the listing is made of.** The name, the description, the change notes and the logo come out of the zip, and none of them can be edited on the site — a change ships as a new version. The name and the description are `<name>` and `<description>` in `src/main/resources/META-INF/plugin.xml`; the logo is `META-INF/pluginIcon.svg` next to it (40×40 SVG, the mark on the dark disc as in `media/icon.png`); the change notes are the CHANGELOG section for the version being built, rendered to HTML by `build.gradle.kts` (between releases that is the last release's section, since `package.json` still names it; "Unreleased" is only the fallback for a version without a section). The version is `package.json`'s: the Release workflow raises it there and the plugin follows, so `build.gradle.kts` carries no version of its own. The license (Apache License 2.0, the repository's `LICENSE`), the source code link, the tags and any screenshots are entered on the site and can be changed there at any time.

**What happens on a release.** The workflow runs `./gradlew test buildPlugin verifyPluginStructure`, then `./gradlew publishPlugin` with the `JETBRAINS_TOKEN` secret, unless the Marketplace already lists that version. JetBrains reviews every version by hand, normally within two business days, and mails the vendor when the status changes; until then the version is not listed. The zip also goes on the GitHub Release.

**Verifying.** CI's `jetbrains-verify` job runs the IntelliJ Plugin Verifier on every push to `main`, against the build target, later IntelliJ releases and Rider 2025.2 or newer (`pluginVerification.ides` in `build.gradle.kts`). The Marketplace runs it again after each upload, across every product. To run it by hand: `./gradlew verifyPlugin`; each extra IDE is a large download cached under `~/.gradle`, so on a laptop short of disk `./gradlew verifyPlugin -Ppacmon.verify=current` checks the build target alone and downloads nothing. The report lands in `build/reports/pluginVerifier/`; a *compatibility problem* has to be fixed before a release, a deprecated-API warning is advice.

`sinceBuild` under `pluginConfiguration.ideaVersion` controls the oldest IDE that can install a release — raise it when you start depending on a newer platform API. `until-build` is deliberately not set: one plugin.xml serves every JetBrains product that bundles `com.intellij.modules.json`, on every version from `sinceBuild` on, which is why the verifier matters.
