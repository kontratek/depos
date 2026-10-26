# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security problem.

Report it privately on GitHub: open **Security → Report a vulnerability** on this repository, or go to https://github.com/kontratek/depos/security/advisories/new. Only Kontra sees the report. Kontra replies in the same thread and publishes an advisory when a fix is out.

Include the Depos version, the editor and its version (VS Code or a JetBrains IDE), the steps, and — if the problem needs one — a minimal manifest or notes file.

## What is in scope

Depos runs inside the editor. It reads the dependency manifests in the open workspace (`package.json`, `Cargo.toml`, `pom.xml`, `build.gradle`, `build.gradle.kts`), reads and writes the notes files under `.pacmon/` and `.pacmon/AGENT-RULES.md`, writes the AI instruction files it is asked to update, and makes no network requests. Its own surface is in scope: a crafted notes file or manifest that makes the extension or the plugin misbehave, notes content that reaches the note panel or a hover unescaped, or a write outside the workspace.

## Supported versions

Fixes go into the latest release on the Visual Studio Marketplace, Open VSX and the JetBrains Marketplace. Older releases are not patched.
