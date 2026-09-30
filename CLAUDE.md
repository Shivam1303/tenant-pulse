# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Tenant Pulse is a local-only load tester: it runs a collection of HTTP requests against an API with many tenants at once, each tenant with its own token and variables, and reports latency percentiles, errors and PASS/FAIL verdicts.

## Commands

Node 24 through nvm (`.nvmrc`). In non-interactive shells nvm is not loaded; call `~/.nvm/versions/node/v24.*/bin/node` directly or source `~/.nvm/nvm.sh` first. The shell's default `node` may be v14 and cannot run the app.

```sh
./run.sh              # nvm use 24, install web deps if missing, start API + web in dev mode
./run.sh prod         # build, then start production
npm run dev           # same as ./run.sh without nvm (node start.js dev)
npm test              # the only test suite: node service/test/mock.test.js
npm run build         # next build for web/
npm run package       # single-file executables in dist/ (Linux x64, Windows x64); see README
cd web && npx tsc --noEmit -p .   # type-check the web app (no linter is configured)
node service/cli.js --plan default [--preflight-only] [--allow-writes]
```

There is no test runner and no way to run a single test: `service/test/mock.test.js` is one script of plain `assert` calls that starts a mock API, exercises the engine and then the HTTP routes. Add new assertions to it. It sets `TENANT_PULSE_DATA` to a temp folder and `API_PORT=4999` before requiring the service modules, so it never touches `service/data`.

Ports: web `WEB_PORT` (3000), API `API_PORT` (4174). `next.config.mjs` reads `API_PORT` for its `/api` rewrite **at build time**, so a production build must be made with the same `API_PORT`. Next refuses a second `next dev` in the same folder; to test alongside a running dev server, start only the service (`TENANT_PULSE_DATA=<tmp> API_PORT=<port> node service/server.js`) and call it with an `origin: http://127.0.0.1:3000` header.

## Architecture

Two processes, started together by `start.js`:

- **`service/`**: plain Node (CommonJS, no dependencies). `server.js` is a route table (`[method, "/api/...:param", handler]`) behind a local-only guard: Host must be `127.0.0.1:<API_PORT>`, and non-GET requests need an allowed `Origin`. Errors with a `field` (validation) or `status` go back as-is; anything else becomes a 500 with a generic message.
- **`web/`**: Next.js 16 App Router + React 19, all client components. The browser calls `/api/*` on the Next server, which proxies to the service. **`web/AGENTS.md` applies: this Next.js version differs from training data; check `web/node_modules/next/dist/docs/` before using Next APIs.**

### Service modules

- `schema.js`: all validation (`validatePlan`, `validateRequest`, `validateTenant`, `validateLogin`) and shared limits (`MAX_VUS` 1000, `MAX_RUN_SECONDS` 600). `validatePlan(plan, secrets, requireTenants)`: with `requireTenants=true` it is validating for a run. It checks credentials and required `{{variables}}`, and **returns only tenants with `enabled !== false`**. Saving uses `false` and keeps every tenant.
- `engine.js`: `makeRequest` (template → URL/headers/body), `send`, `login`, `preflight` (8 tenants in parallel), `tryRequest` / `testLogin` (single draft calls), and the `Run` class. A run is closed-loop: each VU loops over enabled requests with think time (`pacingMs` × random 0.5–1.5). `Run.tick()` runs every second. It pushes a series point (per-second p50/p95/p99 from a window histogram, rate, error rate, VUs, event-loop `lagMs`) and caches summaries, so `snapshot(since)` stays cheap.
- `stats.js`: fixed-size log-scale histogram (~2% buckets, `Uint32Array`, no sorting), `summary`, `verdict` (thresholds → PASS/FAIL), `isSuccess` (2xx and, when `settings.checkSuccessField`, not `"success": false`).
- `store.js`: JSON files in `TENANT_PULSE_DATA` (default `service/data/`, git-ignored). `plans.json`, `secrets.json` (0600), `report-<id>.json` per run, and `reports-index.json` (summaries including per-request p50/p95/p99 for trends; rebuilt automatically when missing or outdated). `plans()` runs `defaults.migratePlan` on every read: **add a migration there when changing the plan shape**, never in schema.
- `app.js`: entry point of the packaged app. One process serves the static web export (`web/out`, or SEA assets inside the executable) and `/api` on `API_PORT`; data goes to `tenant-pulse-data/` next to the executable. `scripts/package.js` bundles it and every `./module` it requires into one script, so **service modules must only `require` built-ins or `"./name"`**.
- `defaults.js`: `newPlan`, `defaultLogin` (reproduces the original `POST /pos-login` → `token`), `migratePlan`.

### Cross-cutting rules

- **Secrets never reach the browser.** `store.publicPlan` replaces them with `hasPassword` / `hasToken` flags; a blank password or token field on save keeps the stored value. Secrets are keyed by client number, and the browser sends `savedClient` so a rename keeps them.
- **Auth model:** a tenant is either `authMode: "token"` (pasted token) or `"login"` (the plan's login request runs once in preflight; the token is read from `login.tokenPath`). The token is exposed as `{{token}}`. Requests with `authMode: "tenantBearer"` send `Authorization: Bearer {{token}}`. There is no token refresh: a 401 during a run is just a failure.
- **Built-in variables** `token`, `client`, `username`, `baseUrl` (the list lives in both `service/schema.js` and `web/lib/plan.ts`) cannot be tenant variables. `password` is only available to the login request. Interpolation escapes values for JSON bodies and URL-encodes them in relative paths.
- **Request `path`** is one of: a relative path on `plan.baseUrl`, a full `http(s)://` URL, or a string starting with a variable (`{{baseUrl}}/x`, `{{apiHost}}/x`), resolved at request time. `agentFor()` keeps uncapped keep-alive pools for both http and https.
- **Write methods** (POST/PUT/PATCH/DELETE) need `allowWrites: true` for Send, preflight and run.
- **Run lifecycle:** `POST /api/run` answers 202 at once; state goes `preflight → running → stopping → finished`, or `failed` (preflight failures in `snapshot().preflight.failures`). Only one check or run at a time (409 otherwise).
- **Duplicated on purpose:** `web/lib/plan.ts` mirrors `builtins`, `requestVariables`, `MAX_VUS` and `MAX_RUN_SECONDS` from `service/schema.js`, and `web/lib/types.ts` mirrors the API shapes. Change both sides together.

### Web app

- `app/workspace/layout.tsx` nests `ConfirmProvider` → `WorkspaceProvider` → `LiveProvider` → `WorkspaceShell`. Screens: `requests`, `tenants`, `run`, `results` (Live / Reports / Trends tabs).
- `workspace-provider.tsx` holds the plan being edited. `dirty` compares it to the last saved JSON, and switching plans or leaving with unsaved edits asks first. Send and Test login post the **unsaved draft** (request, tenant, login) to `/api/try` and `/api/auth/test`; Start run and Check only save first.
- `live-provider.tsx` polls `/api/live?since=<last second>` (1 s while active, 4 s idle) and merges new points by run id. The global run bar and all live views read from it.
- `components/chart.tsx` wraps uPlot (dynamic import, colours read from CSS variables, `ResizeObserver`); the plot is rebuilt only when the series set changes.
- Styling: plain global CSS in `web/styles/` (`tokens.css` holds every colour, dark theme; then `ui.css`, `shell.css`, `pages.css`). No CSS modules, no Tailwind. Icons come from `lucide-react`.

## Repo conventions

- Commit each finished change as its own small commit; do not push (the owner pushes).
- Commits are authored only by the repo-local identity (Shivam1303). Do not add `Co-Authored-By` or any AI attribution lines to commit messages.
