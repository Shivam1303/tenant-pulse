---
name: debug-app
description: Diagnose and fix problems in Tenant Pulse (this repo's multi-tenant load tester), covering the app not starting, blank or broken pages, 403/404/409/500 responses from /api, plans or fields not saving, preflight failures, runs that fail, stall or show unexpected errors, suspicious latency or throughput numbers, broken reports and trends, and the packaged executable misbehaving. Use it whenever the user reports that something in this app "doesn't work", shows an error message or screenshot from it, or asks why a run's numbers look wrong, even when they don't use the word debug.
---

# Debugging Tenant Pulse

Find the cause before changing code. Most reports fall into a handful of known causes (below); check those first, then reproduce in isolation. A fix without a reproduction is a guess.

## 1. Locate the failing layer

```
browser page ──/api/*──> Next dev server :3000 (proxy only) ──> service :4174 ──> target API
packaged app:  browser ──> one process on :4174 (web files + /api) ──> target API
```

Ask, or work out from the evidence:

- Which mode? `./run.sh` / `npm run dev` (two processes), `./run.sh prod`, or the packaged executable (`dist/tenant-pulse-*`).
- Which URL is in the address bar? Which port?
- What exactly does the page, toast, or service console say? The service logs real errors to its console; the browser only gets a generic message for 500s.

Check what is running, without stopping anything:

```sh
ss -ltnp | grep -E ':3000|:417[0-9]'          # who owns the ports
ps -eo pid,args | grep -E 'server.js|app.js|next|tenant-pulse' | grep -v grep
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:4174/api/plans
curl -s http://127.0.0.1:4174/api/live | head -c 600     # current run state, errors, preflight failures
```

The owner's dev server and `service/data` hold their real plans, tokens and reports. Read from them freely (GET), but don't stop their processes, run load against their targets, or write to their data without asking. Reproduce in the sandbox instead (section 3).

## 2. Known causes by symptom

### Startup

| Symptom | Cause | Fix |
|---|---|---|
| `SyntaxError` / `Unexpected token` from node, or Next refusing to start | Shell's default `node` is old (v14 here); nvm isn't loaded in non-interactive shells | `export PATH="$(ls -d ~/.nvm/versions/node/v24.*/bin \| sort -V \| tail -1):$PATH"`, or `./run.sh` (runs `nvm use 24`) |
| `nvm not found` from `run.sh` | `NVM_DIR` unset or nvm not installed | set `NVM_DIR`, or run `npm run dev` with Node 24 on PATH |
| Next says another dev server is running | Next allows one `next dev` per folder | Use the running one, or use the sandbox for isolated checks. Don't kill the owner's server. |
| `EADDRINUSE` | port taken | `ss -ltnp` to see by whom; set `WEB_PORT` / `API_PORT` |

### Pages and API responses

| Symptom | Cause |
|---|---|
| Page shows `{"error":"Not found."}` | The browser is on the **service** port in dev mode (4174 serves only `/api` there; pages are on 3000). Packaged app: something else owns 4174. The executable now moves to the next free port and prints the URL; old builds didn't. |
| `403 {"error":"Local access only."}` | Host isn't `127.0.0.1:<API_PORT>`/`localhost:<API_PORT>` (opened via LAN IP or hostname), **or** a non-GET request has no or an unexpected `Origin` (curl without `-H origin:`), **or** a production build was made with a different `API_PORT` (the Next rewrite target is fixed at build time; rebuild with the same `API_PORT`). |
| `409 A check or run is already active.` | A preflight or run is in progress (`/api/live` → `state`). Wait, or `POST /api/stop`. Only one at a time, by design. |
| `500 Something went wrong in the service. See its log.` | An unexpected throw. The stack trace is in the service console (the `./run.sh` terminal, or the executable's window). |
| `400` with a message | Validation (`service/schema.js`). The message is shown as a toast; the `field` path in the JSON body says which input. |
| Blank page or no styles | A client-side exception or a failed chunk load. Check the browser console. Run `(cd web && npx tsc --noEmit -p .)`. Look for Next APIs used as in older Next versions (read `web/node_modules/next/dist/docs/`). |

### Plans and saving

| Symptom | Cause |
|---|---|
| A field reverts after Save, or never reaches the engine | The validator in `schema.js` rebuilds objects field by field; the field isn't in its returned object. See the change-plan-shape skill. |
| Old plans fail to load or run after a change | Missing or non-idempotent migration in `defaults.migratePlan` (it runs on every read, and runs re-validate stored plans). |
| Password or token "forgotten" | Secrets are keyed by client number and kept across renames only through `savedClient`; a blank field keeps the old one. Switching `authMode` deletes the other kind of secret. |
| Imported CSV tenants have odd variables | Every CSV column not in `reserved` (`web/lib/csv.ts`) becomes a variable. |

### Preflight and runs

Preflight logs every tenant in, then calls every enabled request once per tenant. Failures are in `POST /api/preflight` → `rows`, or `/api/live` → `preflight.failures`. The `detail` text says why:

| `detail` | Meaning |
|---|---|
| `No password saved` / `No bearer token saved` | the tenant's secret is missing |
| `Login HTTP 401` (or another status) | the login request itself failed: wrong credentials, path or body |
| `Login HTTP 200, no token at "token"` | login worked, but `login.tokenPath` doesn't match the response. Test login shows the body. |
| `Missing variable {{x}}` | the tenant has no value for `x` (built-ins are `token`, `client`, `username`, `baseUrl`; `password` exists only in the login request) |
| `HTTP 200, success: false` | the API returned `"success": false`; counts as a failure while `settings.checkSuccessField` is on |
| `timeout` | slower than `settings.timeoutMs` |
| `connection` | ECONNREFUSED, ECONNRESET, ENOTFOUND, …: target down, wrong host or port, DNS |
| `network` | any other socket error (TLS and so on) |
| `Body is not valid JSON after filling in variables.` | a JSON body template breaks once values are inserted |
| `Request path changed the API origin.` | a relative path with variables resolved to another host; use a full URL or `{{var}}`-prefixed path instead |

During a run:

- **401s appear partway through:** tokens expire and there is no token refresh, by design. Shorten the run or use longer-lived tokens.
- **Latency looks high but the API is fine:** check `lagMs` in the series. It is the load generator's own event-loop delay; high values mean this machine is the bottleneck (too many VUs, or pacing 0 with many VUs). Lower `vusPerTenant` or add pacing.
- **Throughput lower than expected:** the model is closed-loop. Each VU waits for its response, then thinks for `pacingMs × 0.5–1.5`. So rate ≈ VUs / (latency + pacing), and a slower API gives fewer requests per second, not a queue.
- **Error rate counts 2xx responses:** those are `apiFailure` (body said `success: false`).
- **p95 capped at 120000:** the histogram tops out at 120 s (`MAX_MS` in `stats.js`).
- **Verdict missing:** thresholds are null. A verdict is only computed when `p95Ms` or `errorRatePct` is set.
- **MySQL series errors:** the `mysql` client isn't on PATH, or the credentials are wrong. It is optional and doesn't affect the run.
- **Run state `failed` with "The run stopped unexpectedly":** an exception in `Run.start`. See the service log.

### Reports and trends

Reports are `report-<id>.json` in the data folder, with a summary index in `reports-index.json`. `store.reports()` rebuilds the index when it is missing or lacks `byRequest`. If trends look wrong after changing the report shape, check `reportSummary` and that rebuild condition. Deleting `reports-index.json` forces a rebuild and is safe.

### Packaged executable

- **Wrong page or `Not found`:** see the ports row above. Run the executable from a terminal to see its output: the URL, the data folder, and any error.
- **Data "missing":** it lives in `tenant-pulse-data/` next to the executable, separate from the dev `service/data`.
- **Works in dev but not packaged:** a service module `require`s something other than a Node built-in or `"./name"` (the bundler in `scripts/package.js` only follows `require("./name")`), or a page relies on a server-only Next feature that static export doesn't support. See the package-app skill.

## 3. Reproduce in isolation

Use the sandbox from the add-feature skill. It gives you Tenant Pulse on 4990 with throwaway data, a fake target API on 4991 with failure modes (`/fail`, `/slow`, `/status/<code>`, `POST /login`), and a seeded plan:

```sh
export PATH="$(ls -d ~/.nvm/versions/node/v24.*/bin | sort -V | tail -1):$PATH"
S=.claude/skills/add-feature/scripts/sandbox.sh
$S start --no-web        # service only; drop --no-web to reproduce UI issues and screenshot them
# shape the plan to match the report: GET /api/plans/default, edit, PUT back (with -H origin:)
$S stop
```

Details and more recipes are in `.claude/skills/add-feature/references/verify.md`. For engine-level bugs, a failing assertion in `service/test/mock.test.js` is the best reproduction: it has a mock API with per-tenant auth, variables and login variants.

`node service/cli.js --plan <id> --preflight-only` runs preflight from the terminal against a saved plan (it reads `TENANT_PULSE_DATA`, default `service/data`, so point it at a sandbox or temp folder unless the owner asked you to use their data).

## 4. Fix and confirm

1. Write the failing check first (a test assertion or a sandbox curl sequence) and watch it fail.
2. Fix the cause, not the symptom. If the bug came from a missed mirror (`web/lib/plan.ts` / `types.ts` against `service/schema.js`), fix both sides.
3. Re-run the check, then `npm test` and `(cd web && npx tsc --noEmit -p .)`.
4. Stop anything you started. Report the cause, the fix and the evidence. Do not commit; the owner asks for commits explicitly.
