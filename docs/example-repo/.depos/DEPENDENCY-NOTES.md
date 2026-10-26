---
format: dependency-notes/1
lang: en
---

<!-- Each "## name" below is a package from package.json. The text right under the
  heading is written by people. "### Agent notes" and everything below it is written
  by AI agents — rules in .depos/AGENT-RULES.md. -->

# Dependency Notes

Team rules: every runtime dependency gets a line from a person saying why it is
here; a pinned version says who pinned it and why. Keep the first line short — it
shows next to the dependency in `package.json`. Agents: read `.depos/AGENT-RULES.md`
before touching a package.

## @acme/telemetry

Internal metrics client — the only sanctioned way to emit product events (OBS-77).
2.x changed the event schema; coordinate with #observability before bumping.

### Agent notes

- purpose: product analytics events; wraps the vendor SDK so call sites never see it
- usage: only through `src/lib/track.ts`; never import the package directly
- constraint: stay on the same major as zod — it re-exports zod types
- bump-with: zod
- owner: #observability
- verified: 1.8.2

## @tanstack/react-query

Server data is cached here, not in state.

```ts
const { data } = useQuery({
  queryKey: ['order', id],
  queryFn: () => api.order(id),
})
```

## core-js

Polyfills for the two customers still on the 2021 embedded browser (SUP-410).

### Agent notes

- purpose: runtime polyfills for the legacy embedded browser target
- runtime: client
- remove-when: SUP-410 closes, or both customers are off that browser — check quarterly
- log: 2026-02 removal proposed and declined; both customers still on the old browser (SUP-410)
- note: the exact polyfill list the vendor requires is in docs/legacy-browsers.md
- verified: 3.42.0

## drizzle-kit

Drizzle ORM's CLI — migrations are generated.

Never hand-write a migration: change `schema.ts`, generate it, review the SQL,
and commit both in one go.

```sh
drizzle-kit generate   # turn a schema change into a SQL migration
drizzle-kit migrate    # apply pending migrations
drizzle-kit push       # sync the schema straight to the dev database
drizzle-kit studio     # browse the data in the browser
```

## express

HTTP API layer (SEC-1234).
Do not upgrade to v5 — the auth middleware is incompatible.

Rate-limit settings live in `src/middleware/limits.ts`. The v5 migration is
tracked in SEC-1301; until it lands, `^4` is intentional.

### Agent notes

- purpose: HTTP framework; serves the public REST API and the webhook receiver
- usage: wired in `src/server.ts`; middleware order matters, see the comment there
- constraint: stay on ^4 — v5 changes router path matching (path-to-regexp v8) and the session API
- verify: `vitest src/api` and the login e2e (`pnpm e2e:auth`)
- risk: every route takes untrusted input; body-size limits live in `limits.ts`
- runtime: server
- exposure: untrusted-input
- log: 2026-03 agent tried 5.0.1, 14 auth tests failed, reverted (PR #402)
- links: https://expressjs.com/en/guide/migrating-5.html
- verified: 4.19.2

## helmet

Sets the security headers on every response.

Mounted first in `src/server.ts`, before any route.

```ts
app.use(helmet())  // CSP, HSTS, X-Frame-Options, …
```

## lodash

Utility helpers. Only `debounce` and `groupBy` are used; prefer native methods
for anything new, and remove this once both call sites are migrated.

### Agent notes

- purpose: two helpers, `debounce` and `groupBy`
- remove-when: both call sites use native code (two left, #882)
- alternatives: native `Object.groupBy` (accepted 2026-01; blocked on Node 20 support until Q3)
- verified: 4.17.21

## moment

Replaced by `date-fns` in 2026-06; the bundle went from 71 KB to 9 KB (PERF-12).
Kept so the next person who reaches for it finds this first.

### Agent notes

- status: removed 2026-06 — replaced by date-fns (PERF-12)
- purpose: date formatting in reports (historical)

## nanoid

Short URL-safe ids — 21 chars, not 36.

```ts
import { nanoid } from 'nanoid'

nanoid()  // 'V1StGXR8_Z5jdHi6B-myT'
```

## pino

No console.log — every log goes through req.log.

Every route handler logs through `req.log`, never the bare logger: it carries
the request id, so one request's lines can be pulled out of the log later.

```ts
req.log.info({ orderId }, 'order created')
```

## react

UI runtime.

### Agent notes

- purpose: UI runtime for the web client
- runtime: client
- bump-with: react-dom, @types/react
- verified: 19.1.0

## typescript

Type checking and the build (`tsc` emits nothing — esbuild bundles). `strict`
is on; a major bump usually surfaces new errors in `src/legacy/`, budget a day.

Config lives in `tsconfig.json`; the test config extends it:

```json
{ "extends": "./tsconfig.json", "include": ["src/test/**/*.ts"] }
```

### Agent notes

- purpose: type checker; esbuild does the bundling
- runtime: build
- verify: `pnpm typecheck`
- verified: 5.9.2

## vitest

Unit test runner — fast, ESM-native, same config as the build.

### Agent notes

- purpose: unit test runner
- runtime: dev
- verified: 3.2.4

## zod

Runtime validation at every trust boundary (HTTP bodies, env, config files).

### Agent notes

- purpose: schema validation at trust boundaries; the types double as the API contract
- constraint: same major as @acme/telemetry, which re-exports zod types
- bump-with: @acme/telemetry
- exposure: untrusted-input
- verified: 3.25.0
