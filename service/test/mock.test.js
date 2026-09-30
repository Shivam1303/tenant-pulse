"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// Routes write to a throwaway data folder, never service/data.
process.env.TENANT_PULSE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "tenant-pulse-"));
process.env.API_PORT = "4999";

const { newPlan } = require("../defaults");
const { validatePlan, validateEnvironment, resolveRun, validateRequest } = require("../schema");
const { preflight, tryRequest, testLogin, Run } = require("../engine");
const stats = require("../stats");

function mockApi() {
  const seen = new Map();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/pos-login" || url.pathname === "/auth/v2") {
        const data = JSON.parse(body);
        if (data.password !== `pass-${data.client}`) {
          res.statusCode = 401;
          return res.end(JSON.stringify({ success: false }));
        }
        const token = `token-${data.client}`;
        return res.end(
          JSON.stringify(url.pathname === "/auth/v2" ? { data: { accessToken: token } } : { success: true, token }),
        );
      }
      const client = (req.headers.authorization || "").replace("Bearer token-", "");
      if (!/^tenant-[1-4]$/.test(client)) {
        res.statusCode = 401;
        return res.end("{}");
      }
      const reject = () => {
        res.statusCode = 400;
        res.end(JSON.stringify({ success: false }));
      };
      if (url.pathname === "/echo" && req.method === "POST") {
        if (
          url.searchParams.get("pos") !== `${client}-pos` ||
          req.headers["x-tenant"] !== `${client}-dept` ||
          JSON.parse(body).order !== `${client}-order`
        )
          return reject();
        return res.end(JSON.stringify({ success: true, client }));
      }
      if (url.pathname === "/form" && req.method === "POST") {
        const fields = new URLSearchParams(body);
        if (
          fields.get("order") !== `${client}-order` ||
          !String(req.headers["content-type"]).startsWith("application/x-www-form-urlencoded")
        )
          return reject();
        return res.end(JSON.stringify({ success: true, client }));
      }
      if (
        url.pathname === "/orders/fetch-order-details" &&
        url.searchParams.get("orderId") !== `${client}-order`
      ) {
        res.statusCode = 404;
        return res.end("{}");
      }
      if (
        url.pathname === "/orders/fetch-order-list" &&
        // tenant-4 has no departmentId of its own and gets the environment's.
        (![`${client}-dept`, "shared-dept"].includes(url.searchParams.get("departmentId")) ||
          url.searchParams.get("posId") !== `${client}-pos`)
      ) {
        res.statusCode = 404;
        return res.end("{}");
      }
      if (
        !["/products", "/customers/", "/orders/fetch-order-details", "/orders/fetch-order-list"].includes(
          url.pathname,
        )
      ) {
        res.statusCode = 404;
        return res.end("{}");
      }
      if (!seen.has(client)) seen.set(client, new Set());
      seen.get(client).add(req.url);
      res.end(JSON.stringify({ success: true }));
    });
  });
  return { server, seen };
}

function testStats() {
  const g = stats.group();
  for (let ms = 1; ms <= 1000; ms++) stats.add(g, { status: 200, ms }, true);
  for (const [q, expected] of [
    [0.5, 500],
    [0.95, 950],
    [0.99, 990],
  ]) {
    const actual = stats.percentile(g, q);
    assert(Math.abs(actual - expected) / expected <= 0.021, `p${q * 100} ${actual} vs ${expected}`);
  }
  const v = stats.verdict({ p95Ms: 900, errorRatePct: 1 }, stats.summary(g));
  assert.strictEqual(v.pass, false);
  assert.deepStrictEqual(
    v.checks.map((c) => c.pass),
    [false, true],
  );
  assert.strictEqual(stats.verdict({ p95Ms: null, errorRatePct: null }, stats.summary(g)), null);
}

async function testEngine(baseUrl, seen) {
  const plan = newPlan();
  plan.settings = {
    vusPerTenant: Number(process.env.BENCH_VUS || 1),
    rampUpSeconds: 0,
    durationSeconds: 1.5,
    timeoutMs: 2000,
    pacingMs: 20,
  };
  plan.thresholds = { p95Ms: 5000, errorRatePct: 0 };
  // Tenant 4 has no departmentId of its own: it uses the environment's.
  const env = {
    id: "local",
    name: "Local",
    baseUrl,
    variables: { departmentId: "shared-dept" },
    tenants: [1, 2, 3, 4].map((n) => ({
      client: `tenant-${n}`,
      username: "test",
      variables: {
        orderId: `tenant-${n}-order`,
        ...(n < 4 ? { departmentId: `tenant-${n}-dept` } : {}),
        posId: `tenant-${n}-pos`,
      },
    })),
  };
  const secrets = Object.fromEntries(env.tenants.map((t) => [t.client, { password: `pass-${t.client}` }]));
  const resolve = (p, e) => resolveRun(validatePlan(p), validateEnvironment(e), secrets);
  const valid = resolve(plan, env);
  assert.strictEqual(valid.baseUrl, baseUrl, "the run uses the environment's base URL");
  assert.deepStrictEqual(valid.environment, { id: "local", name: "Local" });
  assert.strictEqual(valid.tenants[0].variables.departmentId, "tenant-1-dept", "a tenant's variable wins");
  assert.strictEqual(valid.tenants[3].variables.departmentId, "shared-dept", "shared variables fill the gaps");
  const noShared = structuredClone(env);
  noShared.variables = {};
  assert.throws(() => resolve(plan, noShared), /Enter departmentId for tenant-4 in Local/);
  assert.throws(() => resolveRun(validatePlan(plan), validateEnvironment(env), {}), /password for tenant-1 in Local/);

  // Switched-off tenants are left out of a run, even without credentials.
  const partial = structuredClone(env);
  partial.tenants.push({ client: "tenant-off", username: "x", enabled: false, variables: {} });
  assert.deepStrictEqual(
    resolve(plan, partial).tenants.map((t) => t.client),
    env.tenants.map((t) => t.client),
  );
  assert.strictEqual(validateEnvironment(partial).tenants.length, 5, "saving keeps every tenant");
  const allOff = structuredClone(partial);
  allOff.tenants.forEach((t) => (t.enabled = false));
  assert.throws(() => resolve(plan, allOff), /at least one tenant/);
  const tooLong = structuredClone(plan);
  tooLong.settings = { ...plan.settings, rampUpSeconds: 60, durationSeconds: 560 };
  assert.throws(() => resolve(tooLong, env), /10 minutes/);

  const check = await preflight(valid, secrets);
  assert.strictEqual(check.ok, true, JSON.stringify(check.rows));
  assert.strictEqual(check.rows.length, 20);
  assert.deepStrictEqual(
    [...new Set(check.rows.map((r) => r.tenant))],
    env.tenants.map((t) => t.client),
    "preflight rows keep tenant order",
  );

  const run = new Run(valid, secrets, {}, null);
  const report = await run.start();
  assert(report.overall.total > 16);
  assert.strictEqual(report.overall.failed, 0);
  assert.strictEqual(Object.keys(report.byTenant).length, 4);
  assert.strictEqual(Object.keys(report.byRequest).length, 4);
  assert.strictEqual(report.mysqlMeasured, false);
  assert.strictEqual(report.verdict.pass, true);
  assert.strictEqual(report.targetVUs, 4 * plan.settings.vusPerTenant);
  assert.deepStrictEqual(report.environment, { id: "local", name: "Local" });
  assert(report.series.length >= 1 && report.series[0].p99Ms != null, "per-second percentiles");
  assert.strictEqual(run.snapshot(1e9).series.length, 0, "since filters old points");
  for (const tenant of env.tenants) {
    assert.strictEqual(seen.get(tenant.client).size, 4, `${tenant.client} did not receive all four requests`);
    assert([...seen.get(tenant.client)].some((x) => x.includes(`orderId=${tenant.client}-order`)));
  }
  assert([...seen.get("tenant-4")].some((x) => x.includes("departmentId=shared-dept")));
  assert(!JSON.stringify(report).includes("pass-tenant"));
  assert(!JSON.stringify(report).includes("token-tenant"));

  // Send works on a draft request without saving the plan.
  const ctx = { baseUrl, login: valid.login, settings: valid.settings };
  const echo = await tryRequest(ctx, valid.tenants[2], secrets["tenant-3"], {
    name: "Echo",
    method: "POST",
    path: "/echo",
    authMode: "tenantBearer",
    query: [{ key: "pos", value: "{{posId}}", enabled: true }],
    headers: [{ key: "X-Tenant", value: "{{departmentId}}", enabled: true }],
    form: [],
    bodyType: "json",
    body: '{"order":"{{orderId}}"}',
  });
  assert.strictEqual(echo.status, 200, echo.body);
  assert.strictEqual(JSON.parse(echo.body).client, "tenant-3");
  const form = await tryRequest(ctx, valid.tenants[1], secrets["tenant-2"], {
    name: "Form",
    method: "POST",
    path: "/form",
    authMode: "tenantBearer",
    query: [],
    headers: [],
    form: [{ key: "order", value: "{{orderId}}", enabled: true }],
    bodyType: "form",
    body: "",
  });
  assert.strictEqual(form.status, 200);

  // A full URL overrides the base URL (localhost is a different origin here).
  const absolute = await tryRequest(ctx, valid.tenants[0], secrets["tenant-1"], {
    name: "Absolute",
    method: "GET",
    path: `${baseUrl.replace("127.0.0.1", "localhost")}/orders/fetch-order-details`,
    authMode: "tenantBearer",
    query: [{ key: "orderId", value: "{{orderId}}", enabled: true }],
    headers: [],
    form: [],
    bodyType: "none",
    body: "",
  });
  assert.strictEqual(absolute.status, 200, absolute.body);
  // The URL can come from a variable: the built-in {{baseUrl}} or a tenant's own.
  const viaVar = (path, tenant) =>
    tryRequest(ctx, tenant, secrets[tenant.client], { ...structuredClone(valid.requests[2]), path });
  assert.strictEqual((await viaVar("{{baseUrl}}/orders/fetch-order-details", valid.tenants[1])).status, 200);
  const hosted = { ...valid.tenants[1], variables: { ...valid.tenants[1].variables, apiHost: baseUrl } };
  assert.strictEqual((await viaVar("{{apiHost}}/orders/fetch-order-details", hosted)).status, 200);
  assert.throws(() => validateRequest({ name: "x", method: "GET", path: "ftp://host/x" }, "r"), /Start with/);
  assert.throws(() => validateRequest({ name: "x", method: "GET", path: "http://u:p@host/x" }, "r"), /credentials/);

  // A configurable login: different path, token nested in the response.
  const custom = {
    ...ctx,
    login: { ...valid.login, path: "/auth/v2", tokenPath: "data.accessToken" },
  };
  const ok = await testLogin(custom, valid.tenants[0], secrets["tenant-1"]);
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  const wrong = await testLogin(custom, valid.tenants[0], { password: 'bad "quoted" pass' });
  assert.strictEqual(wrong.ok, false);
  assert.strictEqual(wrong.status, 401, "a quote in a password must not break the JSON body");

  const bad = structuredClone(valid);
  bad.tenants[0].variables.orderId = "wrong-id";
  const badCheck = await preflight(bad, secrets);
  assert.strictEqual(badCheck.ok, false);
  assert(badCheck.rows.some((row) => row.tenant === "tenant-1" && row.request === "Order details" && !row.ok));
  return report;
}

async function testRoutes(report) {
  const server = require("../server");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const call = (method, route, body) =>
    new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : "";
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: route,
          method,
          headers: {
            // The server checks Host against API_PORT; it listens on a random port.
            host: "127.0.0.1:4999",
            origin: "http://127.0.0.1:3000",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => resolve({ status: res.statusCode, data: raw ? JSON.parse(raw) : null }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
  try {
    const list = await call("GET", "/api/plans");
    assert.strictEqual(list.status, 200);
    const plan = (await call("GET", "/api/plans/default")).data;
    assert.strictEqual(plan.login.path, "/pos-login");
    assert.strictEqual(plan.environmentId, "local");
    assert(!("tenants" in plan) && !("baseUrl" in plan), "tenants and base URL live in environments");

    // Environments hold the tenants and their secrets.
    const envs = (await call("GET", "/api/environments")).data;
    assert.deepStrictEqual(envs.map((e) => e.id), ["local"]);
    const local = envs[0];
    local.tenants = [{ client: "c-1", username: "u", authMode: "login", password: "secret", variables: {} }];
    const saved = await call("PUT", "/api/environments/local", local);
    assert.strictEqual(saved.status, 200, JSON.stringify(saved.data));
    assert.strictEqual(saved.data.tenants[0].hasPassword, true);
    assert.deepStrictEqual(saved.data.plans, [{ id: "default", name: plan.name }]);
    assert(!JSON.stringify(saved.data).includes("secret"), "secrets never leave the service");
    // Renaming a client keeps its saved password.
    saved.data.tenants[0].client = "c-2";
    const renamed = await call("PUT", "/api/environments/local", saved.data);
    assert.strictEqual(renamed.data.tenants[0].hasPassword, true);
    const envCopy = await call("POST", "/api/environments/local/duplicate", {});
    assert.strictEqual(envCopy.data.name, "Local copy");
    assert.strictEqual(envCopy.data.tenants[0].hasPassword, true, "duplicate keeps secrets");
    assert.strictEqual((await call("PUT", "/api/environments/local", { ...local, baseUrl: "ftp://x" })).data.field, "baseUrl");
    assert.strictEqual((await call("PUT", `/api/environments/${envCopy.data.id}`, { ...envCopy.data, name: "local" })).data.field, "name");
    // A plan can switch environment; one in use cannot be deleted.
    const moved = await call("PUT", "/api/plans/default", { ...plan, environmentId: envCopy.data.id });
    assert.strictEqual(moved.data.environmentId, envCopy.data.id);
    const inUse = await call("DELETE", `/api/environments/${envCopy.data.id}`, {});
    assert.strictEqual(inUse.status, 400);
    assert.match(inUse.data.error, /used by/);
    assert.strictEqual((await call("PUT", "/api/plans/default", { ...plan, environmentId: "nope" })).data.field, "environmentId");
    await call("PUT", "/api/plans/default", plan);
    assert.strictEqual((await call("DELETE", `/api/environments/${envCopy.data.id}`, {})).data.removed, true);
    assert.strictEqual((await call("DELETE", "/api/environments/local", {})).status, 400, "keep one environment");

    const copy = await call("POST", "/api/plans/default/duplicate", {});
    assert.strictEqual(copy.data.environmentId, "local");
    const del = await call("DELETE", `/api/plans/${copy.data.id}`, {});
    assert.strictEqual(del.data && del.data.removed, true, JSON.stringify(del));
    assert.strictEqual((await call("PATCH", "/api/plans/default", {})).status, 405);
    assert.strictEqual((await call("GET", "/api/nope")).status, 404);
    assert.strictEqual((await call("DELETE", "/api/plans/default", {})).status, 400);

    // Send falls back to the tenant's password saved in the environment.
    const draft = await call("POST", "/api/auth/test", {
      environmentId: "local",
      baseUrl: "http://127.0.0.1:1",
      variables: {},
      login: plan.login,
      settings: { timeoutMs: 500 },
      tenant: { ...renamed.data.tenants[0], password: "" },
    });
    assert.strictEqual(draft.status, 200);
    assert.match(draft.data.detail, /connection|network/, "uses the saved password and tries to log in");

    assert.deepStrictEqual((await call("GET", "/api/reports")).data, []);
    // The index keeps per-request numbers for trends, and old indexes are rebuilt.
    const store = require("../store");
    store.saveReport({ ...report, id: "trend-test" });
    const indexed = (await call("GET", "/api/reports")).data[0];
    assert.strictEqual(indexed.byRequest["Order details"].p95Ms, report.byRequest["Order details"].p95Ms);
    const indexFile = path.join(process.env.TENANT_PULSE_DATA, "reports-index.json");
    fs.writeFileSync(indexFile, JSON.stringify([{ ...indexed, byRequest: undefined }]));
    assert(store.reports()[0].byRequest, "old index is rebuilt");
    assert.deepStrictEqual(store.reports()[0].environment, { id: "local", name: "Local" });
    store.removeReport("trend-test");
    assert.strictEqual((await call("GET", "/api/live")).data.state, "idle");
    testMigration(store);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Plans saved before environments: base URL and tenants move into an
// environment, secrets follow, identical setups share one, backups are kept.
function testMigration(store) {
  const dir = process.env.TENANT_PULSE_DATA;
  for (const f of fs.readdirSync(dir)) if (!f.startsWith("report")) fs.rmSync(path.join(dir, f));
  const old = (id, tenants) => {
    const p = { ...newPlan(), id, name: id, baseUrl: "http://api.test:8080", tenants };
    delete p.environmentId;
    return p;
  };
  const tenants = [{ client: "7", username: "u", variables: { posId: "1", orderId: "2", departmentId: "3" } }];
  fs.writeFileSync(
    path.join(dir, "plans.json"),
    JSON.stringify({ default: old("default", tenants), b: old("b", tenants), c: old("c", []) }),
  );
  fs.writeFileSync(
    path.join(dir, "secrets.json"),
    JSON.stringify({ default: { tenants: { 7: { token: "tok" } }, mysql: {} }, b: { tenants: { 7: { token: "tok" } }, mysql: {} } }),
  );
  const plans = store.plans();
  assert.strictEqual(plans.default.environmentId, "api-test-8080");
  assert.strictEqual(plans.b.environmentId, "api-test-8080", "identical setups share an environment");
  assert.strictEqual(plans.c.environmentId, "api-test-8080-2");
  const envs = store.environments();
  assert.strictEqual(envs["api-test-8080"].tenants[0].authMode, "token", "login mode taken from the saved secret");
  assert.strictEqual(envs["api-test-8080"].baseUrl, "http://api.test:8080");
  assert.strictEqual(store.environmentSecrets("api-test-8080")[7].token, "tok");
  assert(fs.existsSync(path.join(dir, "plans.json.bak")) && fs.existsSync(path.join(dir, "secrets.json.bak")));
  assert.strictEqual(store.runPlan("default").plan.tenants[0].client, "7", "a migrated plan still runs");
  // Idempotent: a second read changes nothing.
  const before = fs.readFileSync(path.join(dir, "environments.json"), "utf8");
  store.plans();
  assert.strictEqual(fs.readFileSync(path.join(dir, "environments.json"), "utf8"), before);
}

async function main() {
  testStats();
  const { server, seen } = mockApi();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const report = await testEngine(`http://127.0.0.1:${server.address().port}`, seen);
    await testRoutes(report);
    console.log(
      `Mock API: ${report.targetVUs} VUs, ${report.overall.total} calls, tenants isolated, environments, migration, login, thresholds, routes and stats checked.`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(process.env.TENANT_PULSE_DATA, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
