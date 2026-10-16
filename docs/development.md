# Development

## Requirements

- Node.js 24+
- pnpm 11 (`corepack enable` or `npm install -g pnpm@11`)
- Docker (only for the image and compose checks)

No PostgreSQL or Omie account is needed: development uses PGlite (PostgreSQL compiled to WASM)
in memory and the mock Omie transport with fictitious data.

## First run

```bash
pnpm install
```

Create a `.env` at the repository root for local development:

```dotenv
NODE_ENV=development
APP_URL=http://localhost:5173
OMIE_MODE=mock
BOOTSTRAP_ADMIN_EMAIL=admin@example.com
BOOTSTRAP_ADMIN_PASSWORD=Local-Dev#Pass2026
AI_PROVIDER=mock
# Optional: try the write flow against the mock
OMIE_READ_ONLY=false
OMIE_ALLOW_UPDATE=true
```

```bash
pnpm dev
```

- Web UI (Vite, hot reload): <http://localhost:5173>
- API (tsx watch): <http://localhost:3001>; Vite proxies `/api` and `/health` to it.

The in-memory database starts empty on every restart. To keep data between restarts use a
PGlite directory (`DATABASE_URL=pglite:./.pglite`) or a local PostgreSQL
(`DATABASE_URL=postgres://…`).

## Repository layout

```text
apps/
  api/            Fastify server (routes, services, security, AI), esbuild bundle
  web/            React 19 + Vite UI
packages/
  shared/         errors, RBAC, redaction, shared types
  sql-engine/     parser, planner, executor, writes, resource registry
  omie-client/    HTTP transport, limiter, retries, error classification, mock transport + fixtures
  database/       Drizzle schema, migrations, PGlite / node-postgres client
e2e/              Playwright end-to-end tests
docs/             documentation, ADRs, screenshots
```

## Scripts

| Command                        | What it does                                                         |
| ------------------------------ | -------------------------------------------------------------------- |
| `pnpm dev`                     | API and web in watch mode                                            |
| `pnpm build`                   | builds the web UI, then bundles the API into `apps/api/dist`         |
| `pnpm lint`                    | ESLint (type-aware rules, React hooks)                               |
| `pnpm format` / `format:check` | Prettier                                                             |
| `pnpm typecheck`               | `tsc` in every package                                               |
| `pnpm test`                    | all Vitest projects                                                  |
| `pnpm test:unit`               | unit tests (packages, API and web)                                   |
| `pnpm test:integration`        | API integration tests (Fastify `inject` + PGlite + mock Omie)        |
| `pnpm test:e2e`                | Playwright against the built app (run `pnpm build` first)            |
| `pnpm db:generate`             | generates a new SQL migration from `packages/database/src/schema.ts` |

First-time Playwright setup: `pnpm --filter @dbx/e2e exec playwright install chromium`.
`UPDATE_SCREENSHOTS=1 pnpm test:e2e` refreshes the images in `docs/screenshots`.

## Adding a resource

1. Read the Omie documentation for the endpoint: list call, lookup call, filters, page size and
   the shape of the records.
2. Add a `ResourceDef` to `packages/sql-engine/src/registry/resources.ts`: columns with their
   JSON paths and types, pushdown filters, lookup and write operations. Mark anything you could
   not verify against a real account in `notes` as UNCONFIRMED.
3. Add fictitious fixtures and handlers to the mock transport
   (`packages/omie-client/src/mock`). Never paste real Omie responses.
4. `validateRegistry` runs at startup and in the tests; it rejects duplicate tables or columns,
   unsafe endpoints and JSON paths, pushdowns on unknown columns, missing primary keys and
   inconsistent column flags.
5. Add engine tests for the new pushdowns and writes, then regenerate
   [omie-resources.md](omie-resources.md).

## Database changes

Edit `packages/database/src/schema.ts`, then run `pnpm db:generate`. Commit the generated SQL in
`packages/database/migrations`. Migrations are applied on startup; never edit a migration that
was already released.

## Conventions

- TypeScript strict mode everywhere, ES modules, exact dependency versions.
- Errors are `AppError` with a code from `packages/shared/src/errors.ts`; keep the web
  translations in `apps/web/src/api/errors.ts` in sync.
- UI text is Portuguese (pt-BR); code, comments, logs and API messages are English.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/).
- Test data is fictitious: `example.com` e-mails, invented company names, generated CNPJ/CPF.
