# Environments and request import

Status: approved in chat on 2026-10-01. Chaining is out of scope for now.

## Environments

An environment is a target system: a base URL, shared variables, and the tenants (with their credentials) that exist on that system. Tenant client numbers, usernames, passwords, tokens and variables differ between local, staging and so on, so tenants belong to the environment, not to the plan.

| Environment (`environments.json`, global) | Plan (`plans.json`) |
|---|---|
| `id`, `name`, `baseUrl`, `variables` (shared by all its tenants) | requests, login request, settings, thresholds, MySQL |
| `tenants[]`: client, username, authMode, variables, enabled | `environmentId` |

- Secrets: `secrets.json` becomes `{ version: 2, plans: { [planId]: { mysql } }, environments: { [envId]: { tenants: { [client]: { password | token } } } } }`.
- Variables: a tenant's variable wins over the environment's shared variable. `{{baseUrl}}` is the environment's base URL.
- A run joins plan + environment into the shape the engine already uses (`baseUrl`, enabled `tenants` with merged variables); the engine is unchanged apart from recording `environment: { id, name }` in reports.
- Several plans may share one environment and therefore its tenants and the tenant run switch.
- An environment used by a plan, or the last remaining one, cannot be deleted. Duplicating an environment copies its tenants and secrets.
- Migration (once, automatic): each old plan's `baseUrl` + `tenants` (+ tenant secrets) becomes an environment named after its host; plans with identical base URL and tenants share one. Old files are backed up as `plans.json.bak` / `secrets.json.bak`. A plan whose `environmentId` is unknown falls back to the first environment on read.
- API: `GET /api/environments` (public, with `plans` using each), `PUT /api/environments/:id`, `DELETE /api/environments/:id`, `POST /api/environments/:id/duplicate`. Send / Test login take the draft environment (`environmentId`, `baseUrl`, `variables`) and fall back to its saved secrets.
- UI: environment switcher in the top bar; Environments screen (name, base URL, shared variables, usage, duplicate, delete, Postman environment import); Tenants screen edits the active environment's tenants; Save saves the plan and the active environment together; reports and Trends show and filter by environment. CLI: `--env <id>`.

## Import from Postman / cURL

- `service/importer.js` + `POST /api/import { text, baseUrl }` → preview `{ kind, requests: [{ request, warnings, error? }], environment?, warnings }`. Nothing is saved on the server.
- cURL (bash style): `-X`, `-H`, `-d`/`--data*`, `--json`, `-G`, `--url`; ignores `-k`, `-L`, `--compressed`, `-s`, `-v`, `-i`; warns on `-F`, `-u`, `-b`.
- Postman v2.1 collection: folders become name prefixes; raw/JSON, urlencoded, formdata (text fields), GraphQL bodies; `:param` path variables; bearer/inherited bearer → tenant token, noauth → none; collection variables → suggested environment variables; scripts skipped with a warning. Postman environment files → environment.
- Mapping: query strings → Params; `Authorization: Bearer` dropped in favour of the tenant token; `Host`, `Content-Length`, `Connection` dropped; URLs on the current base URL become relative paths. Each request passes `validateRequest`.
- UI: Import dialog on the Requests screen (paste or file), preview with checkboxes and warnings, appends to the plan with unique names within the 100-request cap; optional "add variables to environment".
