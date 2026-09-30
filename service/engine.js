"use strict";

const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const { monitorEventLoopDelay } = require("perf_hooks");
const { group, add, summary, percentile, verdict, isSuccess } = require("./stats");
const { isAbsolute } = require("./schema");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const MAX_BODY = 1024 * 1024;
const PREFLIGHT_CONCURRENCY = 8;
const LAG_RESOLUTION = 10;
const networkError = (error) =>
  ["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN"].includes(
    error.code,
  )
    ? "connection"
    : "network";

// mode: "raw" (headers, query, text), "url" (path segments) or "json"
// (escaped so quotes in values cannot break a JSON body).
function interpolate(value, variables, mode = "raw") {
  return value.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, key) => {
    if (variables[key] == null) throw new Error(`Missing variable {{${key}}}`);
    const v = String(variables[key]);
    if (mode === "url") return encodeURIComponent(v);
    if (mode === "json") return JSON.stringify(v).slice(1, -1);
    return v;
  });
}

// Variables available to a tenant's requests, including the built-ins.
function tenantVariables(tenant, token) {
  return {
    ...tenant.variables,
    client: tenant.client,
    username: tenant.username || "",
    token: token || "",
  };
}

function hasHeader(headers, name) {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

function makeRequest(baseUrl, spec, tenantVars) {
  const vars = { ...tenantVars, baseUrl };
  let url;
  if (spec.path.startsWith("{{")) {
    // The URL (or its host) comes from a variable, e.g. {{baseUrl}}/orders.
    const resolved = interpolate(spec.path, vars, "raw").replace(/ /g, "%20");
    if (!isAbsolute(resolved) && !resolved.startsWith("/"))
      throw new Error(`URL "${resolved}" must start with http(s):// or /.`);
    url = new URL(resolved, baseUrl);
  } else if (isAbsolute(spec.path)) {
    // Variables in a full URL may hold a host or port, so only encode
    // characters that would break the URL.
    url = new URL(interpolate(spec.path, vars, "raw").replace(/ /g, "%20"));
  } else {
    url = new URL(interpolate(spec.path, vars, "url"), baseUrl);
    if (url.origin !== new URL(baseUrl).origin) throw new Error("Request path changed the API origin.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http:// and https:// URLs are supported.");
  for (const p of spec.query || [])
    if (p.enabled)
      url.searchParams.append(interpolate(p.key, vars), interpolate(p.value, vars));
  const headers = {};
  for (const p of spec.headers || [])
    if (p.enabled) headers[p.key] = interpolate(p.value, vars);
  if (spec.authMode === "tenantBearer" && vars.token)
    headers.authorization = `Bearer ${vars.token}`;
  let body;
  let contentType;
  if (spec.bodyType === "form") {
    const form = new URLSearchParams();
    for (const p of spec.form || [])
      if (p.enabled) form.append(interpolate(p.key, vars), interpolate(p.value, vars));
    body = form.toString();
    contentType = "application/x-www-form-urlencoded";
  } else if (spec.bodyType !== "none" && spec.body) {
    body = interpolate(spec.body, vars, spec.bodyType === "json" ? "json" : "raw");
    if (spec.bodyType === "json") {
      try {
        JSON.parse(body);
      } catch (_) {
        throw new Error("Body is not valid JSON after filling in variables.");
      }
      contentType = "application/json";
    } else contentType = "text/plain; charset=utf-8";
  }
  if (body != null) {
    if (!hasHeader(headers, "content-type")) headers["content-type"] = contentType;
    headers["content-length"] = Buffer.byteLength(body);
  }
  return { url, method: spec.method, headers, body };
}

// Sends one request. The body is only buffered when someone needs it.
function send(request, timeoutMs, agent, { keepBody = false, checkBody = true } = {}) {
  return new Promise((resolve) => {
    const start = nowMs();
    const transport = request.url.protocol === "https:" ? https : http;
    let done = false;
    let timer;
    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...result, ms: Math.max(0, nowMs() - start) });
    }
    const req = transport.request(
      request.url,
      { method: request.method, headers: request.headers, agent: agent[request.url.protocol === "https:" ? "https" : "http"] },
      (res) => {
        if (!keepBody && !checkBody) {
          res.resume();
          res.on("end", () => finish({ status: res.statusCode }));
          res.on("error", (err) => finish({ error: networkError(err) }));
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          if (bytes < MAX_BODY) chunks.push(chunk);
          bytes += chunk.length;
        });
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let successFalse = false;
          if (raw.trimStart().startsWith("{")) {
            try {
              successFalse = JSON.parse(raw).success === false;
            } catch (_) {
              /* not JSON, or truncated */
            }
          }
          finish({
            status: res.statusCode,
            successFalse,
            ...(keepBody
              ? {
                  body: raw.slice(0, 65536),
                  bytes,
                  contentType: res.headers["content-type"] || "",
                }
              : {}),
          });
        });
        res.on("error", (err) => finish({ error: networkError(err) }));
      },
    );
    timer = setTimeout(() => {
      req.destroy();
      finish({ error: "timeout" });
    }, timeoutMs);
    req.on("error", (err) => finish({ error: networkError(err) }));
    if (request.body) req.write(request.body);
    req.end();
  });
}

// Keep-alive pools for both protocols: requests with a full URL may use
// another host or scheme than the base URL. No socket cap: each VU has at
// most one call in flight, and a cap would add queueing time to latency.
function agentFor() {
  const pool = {
    http: new http.Agent({ keepAlive: true }),
    https: new https.Agent({ keepAlive: true }),
  };
  pool.destroy = () => {
    pool.http.destroy();
    pool.https.destroy();
  };
  return pool;
}

function readPath(value, path) {
  return path.split(".").reduce((v, key) => (v == null ? undefined : v[key]), value);
}

function describe(result) {
  return result.error || `HTTP ${result.status}${result.successFalse ? ", success: false" : ""}`;
}

// Runs the plan's login request for one tenant and extracts the token.
// Returns the raw response too so the UI can show what came back.
async function login(ctx, tenant, secret, agent) {
  if (tenant.authMode === "token") {
    if (!secret || !secret.token) throw new Error("No bearer token saved");
    return { token: secret.token.replace(/^Bearer\s+/i, "") };
  }
  if (!secret || !secret.password) throw new Error("No password saved");
  const vars = { ...tenantVariables(tenant, ""), password: secret.password };
  const result = await send(makeRequest(ctx.baseUrl, ctx.login, vars), ctx.settings.timeoutMs, agent, {
    keepBody: true,
  });
  let token;
  try {
    token = readPath(JSON.parse(result.body), ctx.login.tokenPath);
  } catch (_) {
    /* not JSON */
  }
  const ok = isSuccess(result, ctx.settings.checkSuccessField) && typeof token === "string" && token;
  if (!ok) {
    const error = new Error(
      `Login ${describe(result)}${isSuccess(result) ? `, no token at "${ctx.login.tokenPath}"` : ""}`,
    );
    error.response = result;
    throw error;
  }
  return { token, response: result };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

// Authenticates every tenant and calls each enabled request once.
async function preflight(plan, secrets, { onRow, shouldStop } = {}) {
  const agent = agentFor();
  const tokens = new Map();
  const enabled = plan.requests.filter((r) => r.enabled);
  try {
    const perTenant = await mapLimit(plan.tenants, PREFLIGHT_CONCURRENCY, async (tenant) => {
      const rows = [];
      const push = (request, ok, detail) => {
        const row = { tenant: tenant.client, request, ok, detail };
        rows.push(row);
        if (onRow) onRow(row);
      };
      if (shouldStop && shouldStop()) return rows;
      let token;
      try {
        ({ token } = await login(plan, tenant, secrets[tenant.client], agent));
        tokens.set(tenant.client, token);
        push("Authentication", true, "Ready");
      } catch (error) {
        push("Authentication", false, error.message);
        return rows;
      }
      for (const spec of enabled) {
        if (shouldStop && shouldStop()) break;
        try {
          const result = await send(
            makeRequest(plan.baseUrl, spec, tenantVariables(tenant, token)),
            plan.settings.timeoutMs,
            agent,
            { checkBody: plan.settings.checkSuccessField },
          );
          push(spec.name, isSuccess(result, plan.settings.checkSuccessField), describe(result));
        } catch (error) {
          push(spec.name, false, error.message);
        }
      }
      return rows;
    });
    const rows = perTenant.flat();
    return { ok: rows.length > 0 && rows.every((r) => r.ok), rows, tokens };
  } finally {
    agent.destroy();
  }
}

// One request for one tenant, used by Send in the request builder.
async function tryRequest(ctx, tenant, secret, spec) {
  const agent = agentFor();
  try {
    const needsToken = spec.authMode === "tenantBearer";
    const { token } = needsToken ? await login(ctx, tenant, secret, agent) : { token: "" };
    const request = makeRequest(ctx.baseUrl, spec, tenantVariables(tenant, token));
    const result = await send(request, ctx.settings.timeoutMs, agent, { keepBody: true });
    return { ...result, url: request.url.pathname + request.url.search, method: spec.method };
  } finally {
    agent.destroy();
  }
}

// Runs only the login request for one tenant, used by "Test login".
async function testLogin(ctx, tenant, secret) {
  const agent = agentFor();
  try {
    const { token, response } = await login(ctx, tenant, secret, agent);
    return {
      ok: true,
      tokenPreview: `${token.slice(0, 6)}…${token.slice(-4)}`,
      status: response && response.status,
      ms: response && response.ms,
    };
  } catch (error) {
    const r = error.response || {};
    return { ok: false, detail: error.message, status: r.status, ms: r.ms, body: r.body };
  } finally {
    agent.destroy();
  }
}

function mysqlSample(config, password) {
  return new Promise((resolve) => {
    const args = [
      "--batch",
      "--skip-column-names",
      "--connect-timeout=2",
      "--host",
      config.host,
      "--port",
      String(config.port),
      "--user",
      config.user,
      "--execute",
      "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running')",
    ];
    const child = spawn("mysql", args, {
      env: { ...process.env, MYSQL_PWD: password || "" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    const timer = setTimeout(() => {
      if (!child.killed) child.kill();
    }, 3000).unref();
    child.stdout.on("data", (data) => {
      if (output.length < 4096) output += data;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ error: "MySQL client unavailable" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ error: "MySQL connection or permission error" });
      const values = {};
      for (const line of output.trim().split("\n")) {
        const [key, value] = line.split("\t");
        if (key) values[key] = Number(value);
      }
      resolve({ connected: values.Threads_connected, running: values.Threads_running });
    });
  });
}

async function sleepUnless(ms, stopped) {
  while (ms > 0 && !stopped()) {
    const slice = Math.min(ms, 100);
    await wait(slice);
    ms -= slice;
  }
}

class Run {
  constructor(plan, secrets, mysqlSecrets, onDone) {
    this.plan = plan;
    this.secrets = secrets;
    this.mysqlSecrets = mysqlSecrets || {};
    this.onDone = onDone;
    this.id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
    this.state = "idle";
    this.stopRequested = false;
    this.activeVUs = 0;
    this.events = [];
    this.enabled = plan.requests.filter((r) => r.enabled);
    this.preflight = { rows: [], total: plan.tenants.length * (1 + this.enabled.length) };
    this.stats = group();
    this.window = group();
    this.byTenant = Object.fromEntries(plan.tenants.map((t) => [t.client, group()]));
    this.byRequest = Object.fromEntries(this.enabled.map((r) => [r.name, group()]));
    this.series = [];
    this.mysqlSeries = [];
    this.summaries = this.summarize();
  }
  event(message) {
    this.events.push({ time: new Date().toISOString(), message });
  }
  stop() {
    if (this.stopRequested || ["finished", "failed"].includes(this.state)) return;
    this.stopRequested = true;
    if (this.state === "running") this.state = "stopping";
    this.event("Stop requested");
  }
  summarize() {
    const map = (groups) =>
      Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, summary(v)]));
    return {
      overall: summary(this.stats),
      byTenant: map(this.byTenant),
      byRequest: map(this.byRequest),
    };
  }
  elapsedSeconds() {
    if (!this.startedAt) return 0;
    return Math.max(0.001, ((this.endedAt || Date.now()) - this.startedAt) / 1000);
  }
  // Cheap: summaries are computed once per tick, not per request for data.
  snapshot(since = -1) {
    const elapsed = this.elapsedSeconds();
    return {
      id: this.id,
      planId: this.plan.id,
      planName: this.plan.name,
      environment: this.plan.environment || null,
      state: this.state,
      error: this.error,
      activeVUs: this.activeVUs,
      targetVUs: this.plan.tenants.length * this.plan.settings.vusPerTenant,
      plannedSeconds: this.plan.settings.rampUpSeconds + this.plan.settings.durationSeconds,
      elapsedSeconds: Math.round(elapsed * 10) / 10,
      rate: elapsed ? Math.round((this.summaries.overall.total / elapsed) * 10) / 10 : 0,
      ...this.summaries,
      thresholds: this.plan.thresholds,
      verdict: verdict(this.plan.thresholds, this.summaries.overall),
      preflight: {
        done: this.preflight.rows.length,
        total: this.preflight.total,
        failures: this.preflight.rows.filter((r) => !r.ok),
      },
      since,
      series: this.series.filter((p) => p.second > since),
      mysqlSeries: this.mysqlSeries.filter((p) => p.second > since),
      events: this.events,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
    };
  }
  tick() {
    const w = this.window;
    const second = Math.round((Date.now() - this.startedAt) / 1000);
    this.series.push({
      second,
      rate: w.total,
      errorRate: w.total ? Math.round((w.failed / w.total) * 1000) / 10 : 0,
      p50Ms: percentile(w, 0.5),
      p95Ms: percentile(w, 0.95),
      p99Ms: percentile(w, 0.99),
      activeVUs: this.activeVUs,
      // How late the load generator's own event loop ran (p99, ms). High
      // values mean this machine, not the API, is adding latency.
      // The monitor samples every LAG_RESOLUTION ms; subtract that baseline.
      lagMs: Math.max(0, Math.round(((this.lag.percentile(99) || 0) / 1e6 - LAG_RESOLUTION) * 10) / 10),
    });
    this.lag.reset();
    this.window = group();
    this.summaries = this.summarize();
    if (this.plan.mysql.length && !this.sampling) {
      this.sampling = true;
      Promise.all(
        this.plan.mysql.map(async (m) => ({
          second,
          host: m.id,
          ...(await mysqlSample(m, this.mysqlSecrets[m.id] && this.mysqlSecrets[m.id].password)),
        })),
      )
        .then((samples) => this.mysqlSeries.push(...samples))
        .finally(() => (this.sampling = false));
    }
  }
  record(tenant, spec, result) {
    const ok = isSuccess(result, this.plan.settings.checkSuccessField);
    add(this.stats, result, ok);
    add(this.window, result, ok);
    add(this.byTenant[tenant.client], result, ok);
    add(this.byRequest[spec.name], result, ok);
  }
  async virtualUser(tenant, delay, deadline, agent) {
    const stopped = () => this.stopRequested;
    await sleepUnless(delay, stopped);
    if (stopped() || Date.now() >= deadline) return;
    const vars = tenantVariables(tenant, this.tokens.get(tenant.client));
    const checkBody = this.plan.settings.checkSuccessField;
    this.activeVUs++;
    try {
      let cursor = 0;
      while (!stopped() && Date.now() < deadline) {
        const spec = this.enabled[cursor++ % this.enabled.length];
        const result = await send(
          makeRequest(this.plan.baseUrl, spec, vars),
          this.plan.settings.timeoutMs,
          agent,
          { checkBody },
        );
        this.record(tenant, spec, result);
        // Real users do not pause for exactly the same time: vary each
        // think time between 50% and 150% so VUs drift apart.
        if (this.plan.settings.pacingMs)
          await sleepUnless(this.plan.settings.pacingMs * (0.5 + Math.random()), stopped);
      }
    } finally {
      this.activeVUs--;
    }
  }
  // Preflight, then the timed load. Resolves when everything has stopped.
  async start() {
    this.state = "preflight";
    this.event("Preflight started");
    const check = await preflight(this.plan, this.secrets, {
      onRow: (row) => this.preflight.rows.push(row),
      shouldStop: () => this.stopRequested,
    });
    if (this.stopRequested || !check.ok) {
      this.state = "failed";
      this.error = this.stopRequested
        ? "Stopped during preflight."
        : "Preflight found failures. Fix them before starting.";
      this.event(this.error);
      return null;
    }
    this.tokens = check.tokens;
    this.state = "running";
    this.startedAt = Date.now();
    this.event("Load started");
    const { settings, tenants } = this.plan;
    const totalVUs = tenants.length * settings.vusPerTenant;
    const deadline = this.startedAt + (settings.rampUpSeconds + settings.durationSeconds) * 1000;
    const agent = agentFor();
    this.lag = monitorEventLoopDelay({ resolution: LAG_RESOLUTION });
    this.lag.enable();
    const ticker = setInterval(() => this.tick(), 1000);
    try {
      const users = [];
      let index = 0;
      for (const tenant of tenants)
        for (let i = 0; i < settings.vusPerTenant; i++) {
          const delay = totalVUs === 1 ? 0 : (index++ * settings.rampUpSeconds * 1000) / (totalVUs - 1);
          users.push(this.virtualUser(tenant, delay, deadline, agent));
        }
      await Promise.all(users);
    } finally {
      clearInterval(ticker);
      this.lag.disable();
      agent.destroy();
      this.endedAt = Date.now();
      this.summaries = this.summarize();
      this.state = "finished";
      this.event(this.stopRequested ? "Stopped early" : "Finished");
    }
    const report = this.report();
    if (this.onDone) await this.onDone(report);
    return report;
  }
  report() {
    const snapshot = this.snapshot();
    delete snapshot.since;
    delete snapshot.preflight;
    delete snapshot.error;
    return {
      ...snapshot,
      name: this.plan.name,
      label: this.plan.label,
      apiHost: new URL(this.plan.baseUrl).host,
      endedAt: new Date(this.endedAt).toISOString(),
      stopped: this.stopRequested,
      settings: this.plan.settings,
      tenants: this.plan.tenants.map((t) => t.client),
      requests: this.enabled.map((r) => ({ name: r.name, method: r.method })),
      mysqlMeasured: this.plan.mysql.length > 0,
    };
  }
}

module.exports = { Run, preflight, tryRequest, testLogin, makeRequest, interpolate, tenantVariables };
