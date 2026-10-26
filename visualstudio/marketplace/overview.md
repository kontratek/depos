# Depos — Dependency Notes

**Your project file says which NuGet packages you depend on. Depos adds why.**

Every package gets a short note: why it is here, what must not change, what to
check before an upgrade. The note shows in the project file as Quick Info, and
you write it from there.

Notes are plain Markdown in `.pacmon/nuget/DEPENDENCY-NOTES.md`, next to the
project they describe. No database, no service, no account: a file that you
read, diff and commit like any other. AI coding agents read the same file
before they touch a package.

## What Depos reads

Literal `PackageReference Include` items in `.csproj`, `.fsproj` and `.vbproj`
files, and `PackageVersion Include/Update` plus `GlobalPackageReference Include`
items in `Directory.Packages.props`. Package IDs match case-insensitively.
Depos reads these files as text and never runs .NET, MSBuild or NuGet, so
imports, MSBuild expressions and transitive packages are not evaluated.

## Features

- A mark beside each package ID: filled when the package has a note, hollow
  when it does not. Click it to write the note.
- The first line of the note at the end of the line, and the whole note in
  Quick Info.
- Ctrl+click on a package ID jumps to its section in the notes file; the Quick
  Action on the line adds or edits the note.
- Write a note in the Depos tool window beside Solution Explorer, in a quick
  input box, or in the notes file opened beside the project, with one layer
  for people and one for agents.
- **Documentation Coverage** lists which packages have a note and which do not.
- Problems in the notes file are underlined as you write, and
  **Format NuGet Dependency Notes** rewrites the file into canonical form.
- **Set Up AI Instructions** writes the rules for AI coding agents to
  `.pacmon/AGENT-RULES.md`.

**Tools → Options → Depos** chooses what the end of a line shows, which layer
of the note leads, how a note opens, and which notes file a project uses in a
monorepo.

## Dependency review and allowlisting

The notes file can serve as the allowlist of packages a project has reviewed
and accepted. Each accepted package gets a note that says why it was allowed,
and the agent layer records its `risk` (security exposure, native code, licence
obligations, maintenance), where it runs (`runtime`), whether it handles
untrusted input (`exposure`), and a dated `log` of advisories, upgrades and
rejected proposals. A package added to a project file without a note shows a
hollow mark and appears in **Documentation Coverage**, so an unreviewed
dependency stands out. Depos makes it visible; it does not block the package.

## The notes file

One `## section` per package. People write under the heading. Agents write
under `### Agent notes`.

```md
## Newtonsoft.Json

Serializes the public API contracts.
Do not replace with System.Text.Json yet: the partner webhooks depend on its date handling.

### Agent notes

- purpose: JSON serialization for the public REST API and the webhook receiver
- constraint: stay on 13.x; the contract tests pin its date format
- verify: `dotnet test tests/Api.Contracts`
- log: 2022-06 upgraded to 13.0.1 for GHSA-5crp-9r3c-p9vr (deeply nested input exhausts the stack)
- verified: 13.0.3
- risk: deserializes partner webhook payloads; TypeNameHandling must stay None
- runtime: server
- exposure: untrusted-input
```

The Pacmon extensions for VS Code and the JetBrains IDEs, Rider included, read
the same file, so notes move between editors unchanged. The format is
documented at [pacmon.dev/format](https://pacmon.dev/format/).

## Requirements

Visual Studio 2022 or newer on Windows, x64 or Arm64. Depos reads and writes
files in your solution and makes no network requests; it does not call any AI
service.

## Feedback

Bug reports and feature requests are welcome as
[GitHub issues](https://github.com/kontratek/pacmon/issues). This extension is
licensed under the Apache License 2.0.
