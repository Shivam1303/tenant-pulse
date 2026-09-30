---
name: change-plan-shape
description: Checklist for adding, renaming, removing or changing the type of any field stored in a Tenant Pulse plan, including plan-level fields, settings, thresholds, requests, the login request, tenants, MySQL hosts and tenant secrets. Use it whenever a change means plans.json or secrets.json will hold something different, for example "add a per-request timeout", "let tenants have a weight", "add a think-time setting", "rename vusPerTenant", "store an API key per tenant" or "remove the label field", even when the user only describes the UI control they want. Missing one step drops the field silently on save or breaks existing users' saved plans.
---

# Changing the plan shape

A plan passes through several layers, and each one rebuilds or copies it instead of passing it through unchanged. A new field has to be carried explicitly through every layer, or it disappears without any error. Existing users also have plans saved in the old shape, and those must keep loading.

## How a plan flows

A plan (requests, login, settings, thresholds, MySQL, `environmentId`) and an environment (`baseUrl`, shared `variables`, `tenants`) are saved separately. **Tenants and the base URL belong to the environment**, not the plan.

```
browser (web/lib/types.ts Plan / Environment)
  └ workspace-provider.tsx save() → PUT /api/environments/:id for each edited environment, then cleaned(plan) → PUT /api/plans/:id
      ├ store.saveEnvironment: tenant secrets out (mergeTenantSecret) → validateEnvironment → environments.json / secrets.json
      └ store.savePlan: MySQL passwords out → validatePlan → plans.json / secrets.json
read: store.plans() / environments() → migratePlan / migrateEnvironment on every read → publicPlan / publicEnvironment (secrets → has… flags) → browser
run:  store.runPlan(id) → validatePlan + validateEnvironment → resolveRun (base URL, only enabled tenants, shared variables merged) → engine
```

**`validatePlan`, `validateEnvironment`, `validateSettings`, `validateRequest`, `validateTenant` and `validateLogin` return new objects that list each field.** They do not spread the input. A field that is not listed there is dropped on save, and the UI shows it as reverted after the save round-trip.

## Checklist

Work through every item. Say "n/a" to yourself for the ones that don't apply rather than skipping silently.

### Service

1. **`service/schema.js`: validate and return it.** Add the field to the relevant validator's returned object, using the existing helpers (`text`, `rawText`, `number(value, field, min, max, integer)`, `optionalNumber`, `pairs`), and `fail(field, message)` with the dotted path (`settings.x`, `requests.${i}.x`, `tenants.${i}.x`) so the UI can point at the right input. Decide the default for a missing value here too (see `pacingMs: s.pacingMs || 0` and `enabled: r.enabled !== false`). Limits shared with the UI are exported constants (`MAX_VUS`, `MAX_RUN_SECONDS`).
2. **`service/defaults.js` `newPlan()` / `requestDefaults()` / `defaultLogin()`:** give new plans and new requests the default value.
3. **`service/defaults.js` `migratePlan()`:** bring plans saved by older versions up to the new shape. This is required because `store.runPlan` re-runs `validatePlan` on stored plans before every run and check, so an old plan that fails the new validation cannot be run. `migratePlan` runs on *every* read, so it must be idempotent. Renames copy the old key and `delete` it (see `workersPerTenant` → `vusPerTenant`). Put migrations here, never in schema.js. Environment fields migrate in `migrateEnvironment()`; a change that moves data between files belongs in `store.upgrade()`.
4. **Is it a secret** (password, token, API key, anything that grants access)? Then it must not be stored in `plans.json` or sent to the browser:
   - Tenant secrets: `store.saveEnvironment` collects them per environment and client (see `mergeTenantSecret`: a blank value keeps the saved one, and `savedClient` keeps secrets across a client rename). Plan secrets (MySQL): `store.savePlan`. Strip them from what the validators return.
   - `store.publicEnvironment` / `store.publicPlan` expose only a `hasX` boolean.
   - `store.runPlan` returns them to the engine alongside the plan. `duplicatePlan` / `duplicateEnvironment` already copy their secrets.
   - `server.js` `draftContext` falls back from the draft value to the one saved in `body.environmentId` for Send / Test login.
5. **Engine and single sends:** use the field where it matters (`engine.js` `makeRequest`, `send`, `Run`, `preflight`). If it affects a single request, check `server.js` `draftContext`: it builds `ctx.settings` from **only** `timeoutMs` and `checkSuccessField`, so a new setting that Send / Test login should respect must be added there.
6. **Reports:** a report stores a copy of `plan.settings`. If Results or Trends reads the new field from a report, handle old reports that don't have it. If it belongs in the trends index, update `store.reportSummary` and the rebuild condition in `store.reports()` so old indexes are regenerated.
7. **Template variables:** if the field can contain `{{variables}}`, add it to `requestVariables` in `service/schema.js` (and its mirror in `web/lib/plan.ts`), so preflight requires tenants to fill them in. Built-in names (`token`, `client`, `username`, `baseUrl`) cannot be tenant variables.

### Web

8. **`web/lib/types.ts`:** add the field to the matching type. Use optional (`?`) only when old data can lack it after migration.
9. **`web/lib/plan.ts`:** update `blankRequest()` / `blankTenant()` for new items. If you changed a mirrored constant or `requestVariables`, change the copy here in the same edit.
10. **`workspace-provider.tsx` `createBlank`:** it resets `thresholds`, `requests` and `mysql` explicitly and keeps everything else from the current plan. Decide whether the new field should be reset for a new plan. If the field is a key/value `Pair[]` list on requests or login, add it to `cleaned()`, which drops empty rows before saving.
11. **Tenant fields and CSV import:** tenant edits go through `updateEnv`, not `updatePlan`.  `web/lib/csv.ts` turns **every column that isn't in `reserved`** into a tenant variable. Add the new column name to `reserved` and read it in `tenantsFromCsv`, or it will be imported as a variable.
12. **UI control:** edit through `updatePlan` and wrap inputs in `Field` from `components/ui.tsx`. A failed save shows the service's message in a toast. The `field` path is kept in `notice.field`, but no screen highlights inputs from it yet, so the message itself must say what to fix and for which tenant or request (see `Enter ${key} for ${tenant.client}.`).

### Tests and docs

13. **`service/test/mock.test.js`:** add assertions for
    - round trip: PUT a plan with the field, GET it back, value kept (in `testRoutes`)
    - rejection: an invalid value gives 400 with the expected `field`
    - migration: a plan written without the field (write `plans.json` in `process.env.TENANT_PULSE_DATA` directly, as the reports-index test does) loads with the default and still passes `validatePlan(…, true)`
    - secrets: if applicable, the value never appears in any response body (see the existing "secrets never leave the service" assertion)
    - engine: the field changes behaviour, if it is used in a run
14. **Docs:** README / `docs/guide.html` if users see it. Update the root `CLAUDE.md` if a cross-cutting rule changed (a new built-in variable, a new secret, a new limit).

## Verify

Follow `.claude/skills/add-feature/references/verify.md`. For a shape change, the must-haves are:

1. `npm test` passes, with the new assertions.
2. `(cd web && npx tsc --noEmit -p .)` passes.
3. Sandbox round trip: `.claude/skills/add-feature/scripts/sandbox.sh start --no-web`, then GET `/api/plans/default`, set the field, PUT it back, GET it again, and confirm the value survived. Also save a plan **without** the field, as an old client would, to confirm the default applies. Start a run and confirm it reaches `finished`.
4. For a secret: `curl -s …/api/plans/default | grep -c <the secret>` must print `0`.
5. Screenshot the screen with the new control (restart the sandbox without `--no-web` after UI edits).

Do not commit. The owner asks for commits explicitly.
