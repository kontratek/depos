# pacmon

**Depos (formerly Pacmon) documents *why* each dependency exists — right next to your JavaScript, Rust, JVM, Elixir, Gleam, Zig, Python, Ruby, PHP/Composer, Go, .NET/NuGet, or C/C++ dependency manifest.**

Today Depos ships as a **VS Code extension**, a **JetBrains plugin**, and a **Visual Studio extension** for Visual Studio 2022 and newer: hover a dependency to read its note, right-click to write one. The Visual Studio extension currently supports .NET/NuGet only. Notes live in your repository under `.depos/` (`.pacmon/` in repositories from before the rename), travel with git, and render on GitHub. Notes are plain Markdown and stay in your repository.

- Install: [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=Kontra.pacmon), [Open VSX](https://open-vsx.org/extension/kontra/pacmon), [JetBrains Marketplace](https://plugins.jetbrains.com/plugin/34295), [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=Kontra.pacmon-visualstudio)
- Source and issues: [github.com/kontratek/depos](https://github.com/kontratek/depos)
- Site: [depos.dev](https://depos.dev)

## About this package

This npm package is the home of the forthcoming Depos **command line interface** — the same notes files, readable and writable outside the editor (CI checks, coverage reports, batch edits). Until that ships, running `npx pacmon` only prints the links above. No dependencies, no install scripts.

Apache-2.0 © Kontra Siber Savunma Teknoloji Ltd. Şti.
