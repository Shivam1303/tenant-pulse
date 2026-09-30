---
name: add-feature
description: End-to-end workflow for building or changing a feature in Tenant Pulse (the multi-tenant load tester in this repo), from finding the right files to proving it works in an isolated sandbox. Use it whenever the user asks to add, change, extend or remove behaviour in this app, for example a new setting, a new chart or column on Results, a new tenant option, a CSV import tweak, a change to how runs, preflight, thresholds or reports work, or a new screen, even if they don't say "feature". Use it together with change-plan-shape when the saved plan data changes, and with add-api-route when the service needs a new endpoint.
---

# Adding a feature to Tenant Pulse

Tenant Pulse is two processes: a dependency-free Node service (`service/`) that owns all data, validation and load generation, and a Next.js 16 client-only web app (`web/`) that edits a plan and shows live and saved results. The root `CLAUDE.md` describes the architecture; read it first if it is not already in context. This skill is about working through a change without missing the places that have to move together, and proving the result works.

## 1. Place the change

Decide which layer owns the behaviour before writing code. Most features touch several:

| If the feature… | It lives in |
|---|---|
| changes what a plan, request, tenant, login or settings holds | `service/schema.js` + `service/defaults.js` + `web/lib/types.ts`: **use the change-plan-shape skill** |
| needs the browser to ask the service for something new | `service/server.js` route table: **use the add-api-route skill** |
| changes how requests are built, sent, timed or counted | `service/engine.js` (`makeRequest`, `send`, `Run`), `service/stats.js` |
| changes pass/fail, error classes or percentiles | `service/stats.js` (`verdict`, `add`, `isSuccess`) |
| changes what is stored in reports or the trends index | `engine.js` `Run.report()`, `store.js` `reportSummary` (old index files are rebuilt when the check in `reports()` says so) |
| is visual only | `web/app/workspace/<screen>/page.tsx`, `web/components/`, `web/styles/` |

Follow the data through end to end before editing: where it is typed (web page) → saved (`workspace-provider.tsx` `save` → `PUT /api/plans/:id` → `store.savePlan` → `validatePlan`) → used (engine) → reported (snapshot/report → `live-provider.tsx` / Results page). A field that is added at one end but not carried through the middle is the most common way a feature silently does nothing.

## 2. Rules that keep the app correct

These come from how the app is built; breaking them causes bugs that tests do not always catch.

- **The service is the source of truth.** Validate in `service/schema.js`, not only in the UI. The UI may pre-check for a friendlier message, but the service must reject bad input with `fail(field, message)`, where `field` is the dotted path (`settings.pacingMs`, `tenants.3.client`). The UI shows only the message, in a toast (`notice.field` is kept but not yet used to highlight inputs), so the message must say what to fix and where.
- **Secrets never reach the browser.** Anything credential-like goes into `secrets.json` through `store.saveEnvironment` (tenants) or `store.savePlan` (MySQL), and the browser only sees `has…` flags from `store.publicEnvironment` / `store.publicPlan`. A blank secret field on save means "keep the stored one".
- **Mirrors move together.** `web/lib/plan.ts` copies `builtins`, `requestVariables`, `MAX_VUS` and `MAX_RUN_SECONDS` from `service/schema.js`, and `web/lib/types.ts` copies the API shapes. Change both sides in the same change.
- **Keep the run loop cheap.** `Run.virtualUser` and `send` run thousands of times a second. Anything per-request must be O(1) with no allocation-heavy work. Compute summaries in `tick()` (once per second), not per request or per `/api/live` poll. High `lagMs` in the series means the tool itself is adding latency.
- **Write methods are guarded.** POST/PUT/PATCH/DELETE requests need `allowWrites: true` for Send, preflight and run. Keep that guard when adding new ways to send requests.
- **One activity at a time.** Anything that sends traffic calls `assertIdle()` (409 when a check or run is active).
- **Next.js 16 is not the version in training data.** Before using any Next API (routing, navigation, config), read the relevant file under `web/node_modules/next/dist/docs/`. All pages are `"use client"` components, and the packaged app is a static export, so server-only features (route handlers, server actions, cookies, `headers()`, rewrites at runtime) are not available.

## 3. Match the house style

- **Service:** CommonJS, no dependencies, `"use strict"`. Modules only `require` Node built-ins or `"./name"`, because `scripts/package.js` bundles the service by following `require("./name")` and anything else breaks the executable. Short comments that say *why*.
- **Web:** plain global CSS in `web/styles/` (`tokens.css` for every colour, then `ui.css`, `shell.css`, `pages.css`). No CSS modules, no Tailwind, no inline colours. Icons come from `lucide-react`. Reuse `web/components/ui.tsx` (`Field`, `Switch`, `Dialog`, `Menu`, `PairEditor`, `Empty`, `Toast`, `useConfirm`) and `web/lib/format.ts` (`ms`, `num`, `pct`, `duration`, `dateTime`, `bytes`) instead of new one-offs.
- **Plan edits:** edit through `useWorkspace().updatePlan((p) => ({ ...p, … }))`. Saving is the user's action (`save`). `dirty` compares against the last saved JSON, so the unsaved-changes prompt works for free.
- **Live data:** read it from `useLive()`. Do not start new polling loops; `live-provider.tsx` already polls `/api/live?since=` and merges series points.
- **Copy:** UI text and error messages are short, plain sentences that say what to do ("Enter a bearer token for 1234.", "Switch on at least one tenant for the run."). No jargon the user did not introduce.

## 4. Build it in small steps

1. Service first: schema/validation, engine or store logic, then routes.
2. Add assertions to `service/test/mock.test.js` for the new behaviour, including one for the rejection path when there is validation. Run `npm test`.
3. Types and mirrors in `web/lib/`.
4. UI.
5. Documentation when behaviour changes for users: `README.md` (and `docs/guide.html` for user-facing workflows), and the root `CLAUDE.md` when the architecture or a cross-cutting rule changes.

## 5. Prove it works

Follow `references/verify.md` in this skill directory. In short: Node 24 on PATH, `npm test`, the web type-check, then `scripts/sandbox.sh start` for an isolated app with a fake target API and a seeded plan. Exercise the feature through the API, screenshot the affected screens with `scripts/sandbox.sh shot`, then `scripts/sandbox.sh stop`. Never test against the owner's running dev server or `service/data`.

## 6. Hand off

Do not commit. The owner reviews and asks for commits explicitly; when they do, make small logical commits with no AI co-author lines. Summarise what changed, what you verified and how, and anything left unverified.
