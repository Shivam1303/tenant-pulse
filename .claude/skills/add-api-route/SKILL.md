---
name: add-api-route
description: How to add or change an HTTP endpoint in the Tenant Pulse service (service/server.js) and call it from the web app, covering the route table, error conventions, the local-only guard, run/check locking, write-method safety, secrets, web types and tests. Use it whenever the browser needs to ask the service for something new or an existing /api route changes, for example "add an endpoint to export all reports", "let the UI rename a report", "add a route that clears old runs", "return X from /api/live", or any feature whose UI needs data the service doesn't expose yet.
---

# Adding an API route

The service is plain Node `http` with no framework, and there is no other backend. In dev, Next proxies `/api/*` to it (`web/next.config.mjs` rewrites). In the packaged app, the same process serves the web files and `/api`. A route added to `service/server.js` therefore works in both modes with no extra wiring, as long as its path starts with `/api/`.

## 1. The route table

Routes are entries in the `routes` array in `service/server.js`:

```js
["METHOD", "/api/things/:id/action", async (params, body, url) => result],
```

- `params`: `:name` segments, URL-decoded. Each matches `[^/]+`.
- `body`: parsed JSON. It is read **only for POST, PUT and DELETE**; a PATCH handler gets `{}`. Bodies over 1 MB get 413 and invalid JSON gets 400, both automatically.
- `url`: a `URL`, for query strings (`url.searchParams.get("format")`).
- Return a value for `200` + JSON. Return a tuple `[status, data]` for another status (the run route returns `[202, { id }]`), or `[status, string, contentType]` for non-JSON (see the CSV export at `/api/reports/:id/export`).

**Matching order matters.** The dispatcher collects every route whose pattern matches the path, then takes the *first one in array order* with the right method. A literal route such as `GET /api/reports/summary` must come **before** `GET /api/reports/:id`, or `:id` will capture `"summary"`. If the path matches but no route has that method, the response is 405; if nothing matches, 404.

Group the new route next to its neighbours (plans, run/live, try/auth, reports) and keep the handler thin: validation in `schema.js`, persistence in `store.js`, traffic in `engine.js`.

## 2. Errors

Never build error responses by hand. Throw, and the server maps the error:

| Throw | Response |
|---|---|
| `schema.fail("field.path", "Message.")` (or any validator) | 400 `{ error, field }` |
| `httpError(404, "Report not found.")` | that status, `{ error }` |
| `httpError(400, "…", { field: "allowWrites" })` | status + `field` |
| anything else | 500 with a generic message; the real error is logged to the service console |

Messages are shown to the user as-is in a toast, so write them as short instructions ("Plan not found.", "Confirm that write requests may change data.").

## 3. Guards to reuse

- **The local-only guard is already applied to every request** (`checkLocal`): Host must be `127.0.0.1:<API_PORT>` or `localhost:<API_PORT>`, and every non-GET request must carry an allowed `Origin`. This blocks other websites and DNS-rebinding from driving the tool. Do not add a bypass; it is what makes storing tokens locally acceptable. That is also why curl tests need `-H "origin: http://127.0.0.1:<port>"`.
- **`assertIdle()`** for anything that sends traffic or otherwise conflicts with a run (409 "A check or run is already active.").
- **`assertWritesAllowed(requests, body)`** for anything that sends plan requests: POST/PUT/PATCH/DELETE requests need `body.allowWrites === true`.
- **`loadPlan(id)`** to get a run-ready plan (`store.runPlan`: the plan joined with its environment, enabled tenants only, plus secrets). Use `store.plans()[id]` for the editable plan and `store.environments()[id]` for an environment with every tenant.
- **Long work:** don't hold the HTTP request open for minutes. Follow the run pattern: start the work, answer `202`, and expose progress through `/api/live` (the `Run.snapshot` shape) or a status route the web app polls.

## 4. Data safety

- **Secrets never leave the service.** Return plans through `store.publicPlan(plan)` and environments through `store.publicEnvironment(env)`, never the raw stored data or `runPlan().secrets`. If a response includes request or login data, make sure it cannot echo a password or token (for example, `testLogin` returns only a `tokenPreview`).
- **Ids that become file names** must be checked, like `store.report(id)` does with `/^[\w-]+$/`, before touching the filesystem.
- **Writes** go through `store.write`, which writes a temp file and then renames it into place. Secrets are written before plans, so a crash never leaves a plan without its credentials.

## 5. Web side

- Add the response type to `web/lib/types.ts`, matching exactly what the handler returns (this file mirrors the API shapes by hand).
- Call it with `api<T>(path, options)` from `web/lib/api.ts`. The path has **no** `/api` prefix (`api<Report>(`/reports/${encodeURIComponent(id)}`)`). It sends `content-type: application/json` and throws an `Error` with `.field` on non-2xx. Encode path params with `encodeURIComponent`. Send `body: "{}"` for bodiless POST/DELETE, as existing calls do.
- Show failures with `setNotice({ type: "error", text: error.message })` from `useWorkspace()`. Mutations that change the plan should `adopt` the returned plan, as `save` and `duplicate` do in `workspace-provider.tsx`.
- For downloads (non-JSON), link to or fetch `/api/...` directly instead of using `api()`, which parses JSON.
- If the route changes run state, remember that `live-provider.tsx` polls `/api/live` (1 s while active, 4 s idle), so the global run bar picks up the new state on the next poll with no extra code.

## 6. Tests

Add checks to `testRoutes` in `service/test/mock.test.js`, using its `call(method, route, body)` helper (it already sends the Host and Origin headers the guard needs):

- the success response and its shape
- each error path you added (status and, for validation, `data.field`)
- 409 while busy, if you used `assertIdle`
- that no secret appears in the response, if the route returns plan or tenant data
- a literal-vs-`:param` ordering check, if the new route sits next to a param route

## 7. Verify

Follow `.claude/skills/add-feature/references/verify.md`: `npm test`, the web type-check, then `.claude/skills/add-feature/scripts/sandbox.sh start` and call the route with curl (non-GET calls need the `origin` header), including one error case. If the web app calls it, screenshot the screen that uses it. Then `sandbox.sh stop`.

Update the route list in `README.md` or the root `CLAUDE.md` if they describe the routes involved. Do not commit; the owner asks for commits explicitly.
