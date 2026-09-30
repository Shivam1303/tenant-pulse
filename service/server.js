"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const store = require("./store");
const { Run, preflight, tryRequest, testLogin } = require("./engine");
const schema = require("./schema");

const port = Number(process.env.API_PORT || 4174);
const webPort = Number(process.env.WEB_PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1–65535");
let currentRun = null;
let checking = false;

const httpError = (status, message, extra) =>
  Object.assign(new Error(message), { status, ...extra });

function respond(res, code, data, type) {
  const body = type ? data : JSON.stringify(data);
  res.writeHead(code, {
    "content-type": type || "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
  });
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1000000) {
        reject(httpError(413, "Request is too large."));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (_) {
        reject(httpError(400, "Invalid JSON."));
      }
    });
    req.on("error", reject);
  });
}
function checkLocal(req) {
  const host = req.headers.host || "";
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host)) return false;
  const origins = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://127.0.0.1:${webPort}`,
    `http://localhost:${webPort}`,
  ];
  if (req.headers.origin && !origins.includes(req.headers.origin)) return false;
  if (!["GET", "HEAD"].includes(req.method) && !req.headers.origin) return false;
  return true;
}
function csv(report) {
  const lines = [
    "scope,name,total,successful,failed,avg_ms,p50_ms,p95_ms,p99_ms,max_ms,unauthorized,rate_limited,server_errors,timeouts,connection_errors,api_failures,statuses",
  ];
  const row = (scope, name, s) =>
    [
      scope,
      name,
      s.total,
      s.successful,
      s.failed,
      s.avgMs,
      s.p50Ms,
      s.p95Ms,
      s.p99Ms,
      s.maxMs,
      s.errors.unauthorized,
      s.errors.rateLimited,
      s.errors.server,
      s.errors.timeout,
      s.errors.connection,
      s.errors.apiFailure,
      JSON.stringify(s.statuses),
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",");
  lines.push(row("overall", "All", report.overall));
  for (const [name, s] of Object.entries(report.byTenant)) lines.push(row("tenant", name, s));
  for (const [name, s] of Object.entries(report.byRequest)) lines.push(row("request", name, s));
  return lines.join("\n") + "\n";
}

// ---- guards shared by the routes -------------------------------------------

function assertIdle() {
  if (checking || (currentRun && !["finished", "failed"].includes(currentRun.state)))
    throw httpError(409, "A check or run is already active.");
}
function assertWritesAllowed(requests, body) {
  if (requests.some((r) => r.enabled !== false && schema.unsafeMethods.has(r.method)) && body.allowWrites !== true)
    throw httpError(400, "Confirm that write requests may change data.", { field: "allowWrites" });
}
function loadPlan(id) {
  const data = store.runPlan(id);
  if (!data) throw httpError(404, "Plan not found.");
  return data;
}

// Draft context for Send / Test login: the unsaved request, tenant, login and
// environment from the browser, with secrets falling back to the ones saved
// for that tenant in that environment.
function draftContext(body) {
  const tenant = schema.validateTenant(body.tenant, "tenant");
  const variables = schema.variableMap(body.variables, "variables");
  const saved = store.environmentSecrets(body.environmentId)[body.tenant.savedClient || tenant.client] || {};
  const secret = {
    token: body.tenant.token ? String(body.tenant.token) : saved.token,
    password: body.tenant.password ? String(body.tenant.password) : saved.password,
  };
  const settings = body.settings || {};
  return {
    ctx: {
      baseUrl: schema.origin(body.baseUrl),
      login: schema.validateLogin(body.login),
      settings: {
        timeoutMs: Math.min(120000, Math.max(100, Number(settings.timeoutMs) || 15000)),
        checkSuccessField: settings.checkSuccessField !== false,
      },
    },
    // The environment's shared variables, under the tenant's own.
    tenant: { ...tenant, variables: { ...variables, ...tenant.variables } },
    secret,
  };
}

// ---- routes ----------------------------------------------------------------

const routes = [
  ["GET", "/api/plans", () => Object.values(store.plans()).map((p) => ({ id: p.id, name: p.name }))],
  [
    "GET",
    "/api/plans/:id",
    ({ id }) => {
      const plan = store.plans()[id];
      if (!plan) throw httpError(404, "Plan not found.");
      return store.publicPlan(plan);
    },
  ],
  [
    "PUT",
    "/api/plans/:id",
    ({ id }, body) => {
      if (body.id !== id) throw httpError(400, "Plan ID does not match.");
      return store.savePlan(body);
    },
  ],
  ["DELETE", "/api/plans/:id", ({ id }) => ({ removed: store.removePlan(id) })],
  [
    "POST",
    "/api/plans/:id/duplicate",
    ({ id }) => {
      const copy = store.duplicatePlan(id);
      if (!copy) throw httpError(404, "Plan not found.");
      return copy;
    },
  ],
  [
    "GET",
    "/api/environments",
    () => Object.values(store.environments()).map((e) => store.publicEnvironment(e)),
  ],
  [
    "PUT",
    "/api/environments/:id",
    ({ id }, body) => {
      if (body.id !== id) throw httpError(400, "Environment ID does not match.");
      return store.saveEnvironment(body);
    },
  ],
  ["DELETE", "/api/environments/:id", ({ id }) => ({ removed: store.removeEnvironment(id) })],
  [
    "POST",
    "/api/environments/:id/duplicate",
    ({ id }) => {
      const copy = store.duplicateEnvironment(id);
      if (!copy) throw httpError(404, "Environment not found.");
      return copy;
    },
  ],
  [
    "POST",
    "/api/preflight",
    async (_, body) => {
      assertIdle();
      const data = loadPlan(body.planId);
      assertWritesAllowed(data.plan.requests, body);
      checking = true;
      try {
        const result = await preflight(data.plan, data.secrets);
        return { ok: result.ok, rows: result.rows };
      } finally {
        checking = false;
      }
    },
  ],
  [
    "POST",
    "/api/run",
    (_, body) => {
      assertIdle();
      const data = loadPlan(body.planId);
      assertWritesAllowed(data.plan.requests, body);
      currentRun = new Run(data.plan, data.secrets, data.mysqlSecrets, (report) => store.saveReport(report));
      currentRun.start().catch((error) => {
        console.error("Run stopped:", error);
        currentRun.state = "failed";
        currentRun.error = "The run stopped unexpectedly. See the service log.";
      });
      return [202, { id: currentRun.id }];
    },
  ],
  [
    "GET",
    "/api/live",
    (_, __, url) => {
      if (!currentRun) return { state: "idle" };
      const since = Number(url.searchParams.get("since"));
      return currentRun.snapshot(url.searchParams.has("since") && Number.isFinite(since) ? since : -1);
    },
  ],
  [
    "POST",
    "/api/stop",
    () => {
      if (currentRun) currentRun.stop();
      return { stopping: !!currentRun };
    },
  ],
  [
    "POST",
    "/api/try",
    async (_, body) => {
      assertIdle();
      const request = schema.validateRequest(body.request, "request");
      assertWritesAllowed([request], body);
      const { ctx, tenant, secret } = draftContext(body);
      return tryRequest(ctx, tenant, secret, request);
    },
  ],
  [
    "POST",
    "/api/auth/test",
    async (_, body) => {
      assertIdle();
      const { ctx, tenant, secret } = draftContext(body);
      return testLogin(ctx, tenant, secret);
    },
  ],
  ["GET", "/api/reports", () => store.reports()],
  [
    "GET",
    "/api/reports/:id",
    ({ id }) => {
      const report = store.report(id);
      if (!report) throw httpError(404, "Report not found.");
      return report;
    },
  ],
  [
    "DELETE",
    "/api/reports/:id",
    ({ id }) => {
      if (!store.removeReport(id)) throw httpError(404, "Report not found.");
      return { removed: true };
    },
  ],
  [
    "GET",
    "/api/reports/:id/export",
    ({ id }, _, url) => {
      const report = store.report(id);
      if (!report) throw httpError(404, "Report not found.");
      return url.searchParams.get("format") === "csv"
        ? [200, csv(report), "text/csv; charset=utf-8"]
        : [200, JSON.stringify(report, null, 2), "application/json; charset=utf-8"];
    },
  ],
].map(([method, pattern, handler]) => ({
  method,
  handler,
  keys: [...pattern.matchAll(/:(\w+)/g)].map((m) => m[1]),
  regex: new RegExp(`^${pattern.replace(/:(\w+)/g, "([^/]+)")}$`),
}));

async function api(req, res, url) {
  const matches = routes.filter((r) => r.regex.test(url.pathname));
  if (!matches.length) throw httpError(404, "Not found.");
  const route = matches.find((r) => r.method === req.method);
  if (!route) throw httpError(405, "Method not allowed.");
  const values = route.regex.exec(url.pathname).slice(1).map(decodeURIComponent);
  const params = Object.fromEntries(route.keys.map((k, i) => [k, values[i]]));
  const body = ["POST", "PUT", "DELETE"].includes(req.method) ? await readJson(req) : {};
  const result = await route.handler(params, body, url);
  if (Array.isArray(result) && typeof result[0] === "number") return respond(res, ...result);
  respond(res, 200, result);
}

// The packaged app (scripts/package.js) serves the exported web app from this process.
// staticFile(pathname) returns a Buffer or null; it is set by the entry point, or from TENANT_PULSE_WEB.
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
function webFile(req, res, url) {
  let name = url.pathname;
  if (name === "/" || name === "/workspace" || name === "/workspace/") {
    res.writeHead(302, { location: "/workspace/requests" });
    return res.end();
  }
  if (name.endsWith("/")) name = name.slice(0, -1);
  if (name.split("/").includes("..")) throw httpError(404, "Not found.");
  const candidates = /\.[a-z0-9]+$/i.test(name) ? [name] : [`${name}.html`, `${name}/index.html`];
  for (const candidate of candidates) {
    const body = server.staticFile(candidate);
    if (!body) continue;
    const type = types[path.extname(candidate)] || "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "cache-control": candidate.startsWith("/_next/static/") ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    });
    return res.end(req.method === "HEAD" ? undefined : body);
  }
  const missing = server.staticFile("/404.html");
  res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
  res.end(missing || "Not found.");
}

const server = http.createServer(async (req, res) => {
  try {
    if (!checkLocal(req)) return respond(res, 403, { error: "Local access only." });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (server.staticFile && !url.pathname.startsWith("/api/") && ["GET", "HEAD"].includes(req.method))
      return webFile(req, res, url);
    await api(req, res, url);
  } catch (error) {
    // Validation errors carry a field; known errors carry a status.
    if (error.field || error.status)
      return respond(res, error.status || 400, { error: error.message, field: error.field });
    console.error(error);
    respond(res, 500, { error: "Something went wrong in the service. See its log." });
  }
});
if (process.env.TENANT_PULSE_WEB) {
  const root = path.resolve(process.env.TENANT_PULSE_WEB);
  server.staticFile = (name) => {
    try {
      return fs.readFileSync(path.join(root, name));
    } catch (_) {
      return null;
    }
  };
}
if (require.main === module)
  server.listen(port, "127.0.0.1", () => console.log(`Tenant Pulse API: http://127.0.0.1:${port}`));
module.exports = server;
