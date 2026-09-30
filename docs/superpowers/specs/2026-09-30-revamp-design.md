# Tenant Pulse revamp — design

Approved in chat on 2026-09-30. Scope: backend fixes → dark UI revamp (option B) → five small additions.

## Backend

- `service/stats.js`: log-scale latency histogram (2% buckets, fixed array, no sorting), cumulative + per-second windows. Series points carry `p50Ms/p95Ms/p99Ms` for that second.
- Run snapshot computed once per tick and cached. `GET /api/live?since=N` returns only series/MySQL points after second N.
- Run lifecycle: `POST /api/run` answers `202` at once; state goes `preflight → running → stopping → finished`, or `failed` with `preflight` rows.
- Preflight runs tenants with a concurrency of 8.
- Auth: no token refresh. Per tenant either a pasted token or the plan's **login request** (`plan.login = {method, path, headers, body, tokenPath}`). The extracted token is stored in the tenant variable `{{token}}`. Requests with `authMode: "tenantBearer"` send `Authorization: Bearer {{token}}`; `{{token}}`, `{{client}}` and `{{username}}` are usable anywhere. A 401 mid-run is just a failure. Defaults reproduce the old `/pos-login` behaviour.
- `POST /api/try` takes a draft request + draft tenant (no whole-plan save). `POST /api/auth/test` runs only the login for one tenant.
- `plan.thresholds = {p95Ms, errorRatePct}` (either may be null) → report `verdict`. The CLI exits 1 on FAIL.
- `plan.settings.checkSuccessField` (default true) toggles the `success:false` body check.
- Reports index file (`reports-index.json`), rebuilt from report files when missing.
- Route table, 405 for wrong method, 400 only for validation errors, 500 otherwise.
- `POST /api/plans/:id/duplicate` copies a plan with its secrets; `DELETE /api/reports/:id` removes a report.
- Legacy migrations happen once in `store` when reading. Tenant secrets survive a client rename (`savedClient`).
- MySQL sampler skips a tick while the previous sample is running; it samples connected + running threads only.

## UI

- Plain global CSS split into `web/styles/` (`tokens.css`, `ui.css`, `shell.css`, `pages.css`) instead of CSS modules, so the shared class names stay in one place. Tokens: bg `#0B0D12`, panel `#12151C`, raised `#181C25`, border `#232834`, text `#E6E8EE`, muted `#8A93A6`, accent iris `#8C7CF0`, success `#3FB68B`, warning `#E0A955`, danger `#E5626A`, info `#5B9CF0`, teal `#4FC1B6`.
- Inter + JetBrains Mono via `next/font`. Icons: lucide-react. Charts: uPlot.
- Shell: collapsible icon sidebar, top bar (plan switcher, unsaved dot, Save/⌘S, ⋯ menu with New blank / Duplicate / Delete with confirm), global run bar, leave-with-unsaved-changes guard.
- Requests: 3 panes (collection, editor, response). Send uses the draft.
- Tenants: table + edit panel, missing-variable badges, auto fields for required variables, CSV import with preview, Authentication (login request) card with "Test login".
- Run: Target, Load profile (shape preview), Thresholds, Advanced (MySQL); sticky footer with Start run / Check only; preflight rows only on failure.
- Results: Live (KPIs, 4 synced charts, error breakdown, sortable tables, events) and Reports (table with verdict, pick two to compare).

## Testing

Extend `service/test/mock.test.js` (login config, thresholds, `since`), add route tests on a temp data dir and a percentile accuracy test. `tsc` + `next build` must pass; check each screen in a browser.
