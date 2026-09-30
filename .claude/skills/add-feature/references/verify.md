# Verifying a change in Tenant Pulse

Shared by every Tenant Pulse skill. Pick the checks that match what changed; a pure service change does not need screenshots, a UI change does.

## 0. Use the right Node

Non-interactive shells do not load nvm, and the default `node` may be v14, which cannot run the app or Next 16. Put Node 24 first on PATH for the whole session:

```sh
export PATH="$(ls -d ~/.nvm/versions/node/v24.*/bin | sort -V | tail -1):$PATH"
node -v   # v24.x
```

## 1. Always

```sh
npm test                          # service/test/mock.test.js: engine + HTTP routes against a mock API
(cd web && npx tsc --noEmit -p .) # type-check; there is no linter
```

`npm test` is one script of plain `assert` calls. It prints one summary line on success and a stack trace on failure. Add assertions for new behaviour to it (engine checks go in `testEngine`, HTTP checks in `testRoutes`). It uses its own temp data folder and port 4999, so it is safe to run while the owner's dev server is up.

## 2. Service behaviour end to end: the sandbox

`scripts/sandbox.sh` (in the add-feature skill, `.claude/skills/add-feature/scripts/sandbox.sh`) starts an isolated copy of the app:

- Tenant Pulse on **4990** with throwaway data (never `service/data`)
- a fake target API on **4991**: every path returns `{"success":true}` after about 20 ms; `/fail` returns `success:false`; `/slow` takes 800 ms; `/status/<code>` returns that status; `POST /login` returns `{"token":"tok-<client>"}`
- the `default` plan seeded with two token tenants (`t-1`, `t-2`), two GET requests (one using `{{departmentId}}`), and a 5-second run with no pacing

```sh
S=.claude/skills/add-feature/scripts/sandbox.sh
$S start            # add --no-web for service-only checks (skips the ~20 s web export)
U=http://127.0.0.1:4990
H=(-H "origin: $U" -H "content-type: application/json")   # every non-GET call needs an allowed Origin
curl -s "$U/api/plans/default"
curl -s -X POST "${H[@]}" -d '{"planId":"default"}' "$U/api/preflight"
curl -s -X POST "${H[@]}" -d '{"planId":"default"}' "$U/api/run"   # 202; poll /api/live
sleep 7; curl -s "$U/api/live"                                       # state should be "finished"
$S stop             # always, even when a check failed
```

To test other situations, change the seeded plan: GET it, edit the JSON, and PUT it back (blank `token`/`password` fields keep the saved secret). For example, point a request at `/fail` or `/status/503`, switch a tenant to `authMode: "login"` with `password` (the plan's default login is `POST /pos-login`; set `login.path` to `/login` for the fake target), or add a POST request (then pass `"allowWrites": true`).

## 3. UI changes: look at the page

Next refuses a second `next dev` in the same folder, and the owner usually has one running on 3000 against their real data, so do not start another one and do not click around theirs. `sandbox.sh start` (without `--no-web`) exports the web app to `web/out` and the sandbox service serves it on 4990 with the seeded plan. Screenshot a page and read the PNG:

```sh
$S shot /workspace/run /tmp/run.png          # SHOT_SIZE=390,844 for a phone width, SHOT_WAIT_MS for slow pages
```

Headless screenshots cannot click. To see a state (a finished run, a validation error, a report), create it through the API first, then take the screenshot. The export reflects the source at the time of `start`; after editing the UI, run `start` again.

What to look for: the new UI renders with real data, nothing overflows, colours come from `web/styles/tokens.css`, and other screens that read the same data still look right. A blank page or missing styles usually means a client-side exception; check that `(cd web && npx tsc --noEmit -p .)` passes and that no Next API from training data is used (see `web/node_modules/next/dist/docs/`).

## 4. Cleanup and hand-off

- `$S stop`, and kill any other process you started (check with `ss -ltnp`). Never stop the owner's processes on 3000/4174.
- `git status`: the export can rewrite `web/next-env.d.ts` (the sandbox restores it) and `next dev` can re-add a block to `web/AGENTS.md`; neither belongs in your change.
- Do not commit. The owner commits; when they ask, split the work into small logical commits with no AI attribution lines.
- Report what you ran and what you saw, including anything you could not check.
