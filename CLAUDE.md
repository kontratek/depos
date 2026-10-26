# Depos — working rules

`docs/format.md` is the authority on the notes format. Nothing is derived from it mechanically; these follow it by hand, in the same commit as any format change:

- `src/core/vocabulary.ts` — the field keys and enumerated values the lint checks
- `src/core/template.ts` — file names, headings, frontmatter defaults, the header comment, the pointer block
- `src/core/lint.ts`, `src/core/parseNotes.ts`, `src/core/serialize.ts` — the rules themselves
- `jetbrains/src/main/kotlin/dev/pacmon/jetbrains/core/` and `visualstudio/Pacmon.Core/` — the same rules, ported to Kotlin and C#
- `assets/AGENT-RULES.md` — what agents are told; written for agents, not a copy of the reference
- `docs/example-repo/` — a complete, lint-clean example

Order of work: `docs/format.md` first, then code and `assets/AGENT-RULES.md`, then `CHANGELOG.md` under `Unreleased`. Unit tests check the TypeScript and C# vocabularies against `assets/AGENT-RULES.md` and lint the example repo.

Anything a user would notice goes under `## Unreleased` in `CHANGELOG.md`, in the same commit that makes the change — release plumbing included, when it changes what ships. Every registry's release notes are that section, and a release that finds it empty stops there.

Before committing: `pnpm lint`, `pnpm typecheck`, `pnpm test`. Integration tests: `pnpm run pretest:integration && pnpm run test:integration`.
