# Dependency notes — rules for AI agents

<!-- .pacmon/AGENT-RULES.md is copied into this repository by Pacmon; do not edit it.
  "Pacmon: Set Up AI Instructions" refreshes it. The format reference is
  https://pacmon.dev/format/ -->

## Org mode

If your tools include `get_dependency_note` from the Depos notes MCP server, this repository's notes live in the organization's Depos. Then:

- Read notes with `get_dependency_note` and `list_dependency_notes`, not from the notes files. The files can be out of date.
- Before you add a package, call `check_package`. Do not add a package that is Denied. Tell the user about a package that is Not listed.
- Write with `set_agent_fields` only: the same keys and rules as `### Agent notes` below. It replaces all fields, so send the full list. Never edit the notes files.
- If `set_agent_fields` is not offered, you can only read. Tell the user what you would change.

Without these tools, follow the rest of this file.

## Before you touch a dependency

Its notes are beside the manifest you are changing: npm uses `.pacmon/DEPENDENCY-NOTES.md`, Rust uses `.pacmon/cargo/DEPENDENCY-NOTES.md`, Maven uses `.pacmon/maven/DEPENDENCY-NOTES.md`, Gradle uses `.pacmon/gradle/DEPENDENCY-NOTES.md`, Mix uses `.pacmon/mix/DEPENDENCY-NOTES.md`, Gleam uses `.pacmon/gleam/DEPENDENCY-NOTES.md`, Zig uses `.pacmon/zig/DEPENDENCY-NOTES.md`, Python uses `.pacmon/python/DEPENDENCY-NOTES.md`, Ruby uses `.pacmon/ruby/DEPENDENCY-NOTES.md`, PHP/Composer uses `.pacmon/composer/DEPENDENCY-NOTES.md`, Go uses `.pacmon/go/DEPENDENCY-NOTES.md`, .NET/NuGet uses `.pacmon/nuget/DEPENDENCY-NOTES.md`, vcpkg uses `.pacmon/vcpkg/DEPENDENCY-NOTES.md`, and Conan uses `.pacmon/conan/DEPENDENCY-NOTES.md`. In a monorepo, use the nearest file for the same ecosystem, walking up. Read two things first: the free text between `# Dependency Notes` and the first section (this repository's own rules), then the dependency's `## <name>` section.

- **Adding a package:** open its section in the same commit, with at least `purpose:`. Say what you considered and why this one, in `alternatives:` or `log:`.
- **Upgrading:** read its `constraint:` and `verify:` lines, then run what `verify:` says. Log the attempt with its outcome even if you reverted it — the next agent must not repeat it.
- **Removing:** keep the section and add `- status: removed <YYYY-MM> — <reason>`. Do not delete it.
- **Trivial packages** (`@types/*`, tiny helpers): `purpose:` and, if it applies, `bump-with:` are enough.

## Where you write

```md
## <the dependency's note key>

Text written by people. Do not touch it.

### Agent notes

- key: value
- key: value
```

- **The heading is the dependency's note key**, spelled as its manifest spells it:
  - `package.json`: the package name with its `@scope/` — `## @types/node`
  - .NET project files and `Directory.Packages.props`: the case-insensitive NuGet package ID as written — `## Newtonsoft.Json`
  - `Cargo.toml`: the key in the dependency table; for a renamed dependency, the key, not its `package` — `## serde`
  - `pom.xml`: `groupId:artifactId` — `## org.slf4j:slf4j-api`
  - `build.gradle(.kts)`: `group:name` without the version, or the catalog alias as written — `## org.slf4j:slf4j-api`, `## libs.junit.jupiter`
  - `mix.exs`: the dependency tuple's first application atom — `## phoenix`, `## ecto_sql`
  - `gleam.toml`: the key in `[dependencies]` or `[dev_dependencies]` — `## gleam_stdlib`, `## gleeunit`
  - `build.zig.zon`: the direct field name in the top-level `.dependencies` struct — `## known_folders`
  - `pyproject.toml` or a requirements file: the normalized distribution name, lower-case with `.`, `_`, and `-` treated alike — `## requests`, `## importlib-metadata`
  - `Gemfile`, `gems.rb`, or a gemspec: the literal, case-sensitive gem name — `## rails`, `## rspec`
  - `go.mod`: the module path in `require`, including any major-version suffix; a `tool` belongs to the module that contains it — `## github.com/spf13/cobra`, `## github.com/jackc/pgx/v5`
  - `composer.json`: the lower-cased package or platform key in `require` or `require-dev` — `## monolog/monolog`, `## php`, `## ext-mbstring`
- **The text right under the heading is written by people.** Never edit or delete it. Treat it as one of your sources — alongside the code, the git history, the registry and your own reasoning. If your block disagrees with it, the human text wins: fix your block and add a `log:` line saying so.
- **`### Agent notes` is yours.** Lower-case keys, one fact per line, keys may repeat (several `constraint:` or `log:` lines are normal). Keys outside the vocabulary below are flagged by Pacmon; if something fits none of them, write it as `note:` — never invent a key.
- One `## name` section per direct dependency, in alphabetical order. `##` is reserved for dependencies; inside a section the only heading is `### Agent notes`.
- Never write an empty field or a dash placeholder. If you have nothing true to say, leave the field out.
- Write judgments, not measurements.
- Revise, do not accumulate: correct a line instead of adding a contradicting one. `log:` is the exception — it is the history.
- Field keys are English. Write the values in the language given by `lang:` in the file's frontmatter.
- Never remove the frontmatter or the header comment at the top of the file. If you are asked to draft the first human line, keep it short: it shows next to the dependency in its manifest.

## Fields

Fill these whenever you can:

| Field | Question it answers | One line of |
|---|---|---|
| `purpose:` | What job does it do here? | the package's role in this project — what it is and why this repo uses it, one sentence |
| `usage:` | Where and how is it wired in? | entry points, wrapper module, config; the rule for using it ("always through lib/http.ts") |
| `constraint:` | What must not change? | a pin, a forbidden upgrade, a coordination requirement — the rule and its reason |
| `verify:` | How do I check I did not break it? | a command or a flow: `vitest src/api`, "run the login e2e" |
| `log:` | What happened, what was decided? | one dated event per line — added (by whom, version, PR), an upgrade attempt, a rejected proposal and why; carry a commit hash, PR or advisory id |
| `verified:` | Which installed version were these notes checked against? | the resolved version (from the lockfile, where there is one) when you last confirmed the block is still true |

Add these only when they are true and non-obvious:

| Field | Question it answers | One line of |
|---|---|---|
| `risk:` | What does it cost or endanger? | a judgment — security exposure, native binary, licence obligation, maintenance state — not raw numbers |
| `runtime:` | Where does it execute? | one of: `server`, `client`, `build`, `dev`, `deploy` |
| `exposure:` | Does it handle untrusted input? | one of: `untrusted-input`, `internal` |
| `bump-with:` | What must move with it? | packages that have to be upgraded together (peer pairs, plugin sets) |
| `remove-when:` | When should it go? | the exit condition |
| `alternatives:` | What could replace it? | only real decisions, dated, with a verdict: "fastify (rejected 2023-01: middleware ecosystem)" |
| `owner:` | Who to ask? | a team, a person, a channel |
| `status:` | Is it still here? | `dead`, `removal-planned`, or `removed <YYYY-MM> — <reason>`; absent means active |
| `links:` | Sources? | changelog, docs, upstream issue, registry page — the specific ones, not the obvious |
| `note:` | Anything else the next agent must know? | free text that fits no other field — one thought per line, never a measurement |

A section whose `status:` starts with `removed` is kept on purpose for a package that left its manifest; Pacmon does not flag it as an orphan.

## Example

```md
## express

Do not upgrade to v5 — the auth middleware is incompatible (SEC-1301).
Rate-limit settings live in `src/middleware/limits.ts`.

### Agent notes

- purpose: HTTP framework; serves the public REST API and the webhook receiver
- constraint: stay on ^4 — v5 changes router path matching (path-to-regexp v8) and the session API
- verify: `vitest src/api` and the login e2e (`pnpm e2e:auth`)
- log: 2026-03 agent tried 5.0.1, 14 auth tests failed, reverted (PR #402)
- verified: 4.18.2
```
