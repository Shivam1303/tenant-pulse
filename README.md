# Tenant Pulse

A local web app for editing API requests and running them across multiple tenants with virtual users (VUs). This project is separate from the original `multi-tenant-load.js` script.

## Structure

- `web/` — TypeScript + Next.js interface with separate Requests, Tenants, Load setup, and Results screens.
- `service/` — Node.js API, load engine, secret storage, saved plans/reports, optional MySQL sampling, and CLI.

The Node service uses asynchronous HTTP and persistent connections. Every tenant gets its own token. Each VU independently loops through the enabled requests in collection order. A plan is capped at 1,000 VUs. All VUs run in one Node process, so at high counts the machine running Tenant Pulse can become the bottleneck: the live view warns when its own event loop falls behind, which means latencies include the tool's delay, not only the API's.

## Start the web app

Use Node.js 24 (20.9 or later works too). The quickest way is `./run.sh`, which runs `nvm use 24`, installs the web dependencies if needed and starts both the API and the web app in development mode; `./run.sh prod` builds and starts the production version.

To run the steps yourself:

```sh
cd tenant-pulse
nvm use
npm --prefix web install
npm run build
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Set `WEB_PORT` and `API_PORT` to use other ports (defaults 3000 and 4174); `API_PORT` must also be set for `npm run build`, because Next.js reads the proxy target at build time. The Next.js app and Node service bind only to `127.0.0.1`. For development, use `npm run dev` instead of building and starting.

## Share it as a single executable

`npm run package` (Node 24, web dependencies installed) builds apps that need nothing installed:

- `dist/tenant-pulse-win-x64.exe` (Windows x64)
- `dist/tenant-pulse-linux-x64` (Linux x64)

Send one file. The recipient runs it (double-click on Windows; `chmod +x` then `./tenant-pulse-linux-x64` on Linux). It serves the app and the API on [http://127.0.0.1:4174](http://127.0.0.1:4174), opens the browser, and keeps plans, secrets and reports in a `tenant-pulse-data` folder next to the executable. Closing the window stops it. Set `API_PORT` to use another port, or `TENANT_PULSE_NO_OPEN=1` to skip opening the browser.

The script exports the web app as static files (`web/out`), bundles `service/app.js` and the service modules into one script, and embeds both into the Node binary as a [single executable application](https://nodejs.org/api/single-executable-applications.html). It downloads the matching Node build for the other platform from nodejs.org (checksum-verified, cached in `dist/.cache`) and uses `npx postject`. Pass targets to build only some: `node scripts/package.js win-x64`. The Windows executable is unsigned, so SmartScreen may ask the recipient to confirm ("More info" → "Run anyway"). MySQL observation still needs the `mysql` client on the recipient's PATH.

## Workflow

1. **Requests:** Build the collection in a three-pane editor: method, path, query params, headers, body (JSON, text or form) and authorization. Switch requests in or out of the run. Use `{{name}}` for tenant variables. The base URL is editable at the top of the collection. A request's URL can be a path on it (`/orders`), a full URL that overrides it (`https://other-host/orders`), or start with a variable: `{{baseUrl}}/orders`, or a tenant variable such as `{{apiHost}}/orders` so each tenant can point at its own server. Pick a tenant and click **Send** to call the unsaved request once and inspect the response.
2. **Tenants:** Add each client's number, and either a username/password (login) or a pasted bearer token, plus values such as `orderId`, `departmentId` and `posId`. Variables that requests need show up as fields automatically, and each tenant shows whether it is ready. **Import CSV** takes columns `client,username,password,token`; every other column becomes a variable.
3. **Login request** (a tab on Tenants): the call preflight makes for each login tenant. Set the method, path, body template (`{{client}}`, `{{username}}`, `{{password}}` and tenant variables, JSON-escaped automatically) and where the token is in the response (for example `token` or `data.accessToken`). The token is stored as `{{token}}`. Requests set to *Tenant bearer token* send `Authorization: Bearer {{token}}`, and `{{token}}` works in any header. Tokens are not refreshed during a run; if the API rejects one, those calls count as failures. **Test login** checks one tenant.
4. **Run:** Pick which tenants take part (switched-off tenants stay in the plan but are skipped, also switchable in the Tenants table). Set the total duration (up to 10 minutes, ramp-up included; 1m/2m/5m/10m shortcuts), VUs per tenant, ramp-up, think time and timeout. Each VU behaves like one user: it calls a request, pauses for the think time (varied ±50% so users drift apart), then calls the next. The screen shows the most requests/sec that setup can produce and warns when think time is 0. The load shape and total peak VUs (`tenants × VUs per tenant`, capped at 1,000) update as you type. **Pass criteria** (p95 limit, error-rate limit) give every report a PASS or FAIL verdict. **Start run** saves the plan, runs preflight (every login and every enabled request once per tenant) and starts the load only if everything passed. **Check only** runs just the preflight.
5. **Results:** While a run is active, a bar at the top of every screen shows progress, requests/sec, p95, errors and a Stop button. The live view has per-second throughput, p50/p95/p99 latency, error rate and active-VU charts, a failure breakdown, and sortable tables by request and by tenant. **Reports** lists saved runs with their verdict. Open one, export JSON or CSV, or tick two to compare them. **Trends** plots every saved run of the current plan, oldest to newest: p95, p50, p99, error rate or requests/sec, overall or one line per request, with the pass-criteria limit as a dashed line and an optional label filter (e.g. `release`).

POST, PUT, PATCH and DELETE requests need a clear confirmation before Send, preflight or load, because they can change API data. Unsaved edits are marked in the top bar. Save with Ctrl/⌘+S; switching plans or closing the tab with unsaved edits asks first.

## Saved data

`service/data/` holds plans and reports. Passwords and tokens live separately in `service/data/secrets.json`, written with private file permissions. The data folder is ignored by Git. Reports and exports exclude passwords, tokens, and request authorization headers. The browser masks saved secrets and leaves password fields blank when a saved value already exists.

## MySQL observation

The optional MySQL panel samples `Threads_connected` and `Threads_running` once per second (skipping a second if the previous sample is still running) per configured host through the installed `mysql` command-line client. Give it a user allowed to read global status. The dashboard labels each MySQL host and says **Not measured** when no host is configured. HTTP VUs are different from MySQL connections.

## Command line and tests

The CLI uses plans created in the UI and produces the same report format:

```sh
node service/cli.js --plan default --preflight-only
node service/cli.js --plan default
npm test
```

Add `--allow-writes` for a plan with write methods. The CLI exits with code 1 when preflight fails, or when the report's verdict is FAIL (or, without pass criteria, when any call failed). Ctrl+C stops scheduling new requests and waits for in-flight calls. The test checks four isolated tenants against a mock API, all default templates, bad IDs, draft Send requests, a custom login endpoint, pass criteria, percentile accuracy, and the HTTP routes against a temporary data folder.
