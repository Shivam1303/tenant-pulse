"use strict";

const fs = require("fs");
const path = require("path");
const { newPlan, newEnvironment, migratePlan, migrateEnvironment } = require("./defaults");
const { validatePlan, validateEnvironment, resolveRun, fail } = require("./schema");
const { Counters } = require("./generate");

const dir = process.env.TENANT_PULSE_DATA || path.join(__dirname, "data");
let ensured = false;
function ensure() {
  if (ensured) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  ensured = true;
}
function read(name, fallback) {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
function write(name, value) {
  ensure();
  const target = path.join(dir, name);
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
}

// secrets.json: { version: 2, plans: { [planId]: { mysql } },
//   environments: { [envId]: { tenants: { [client]: { password | token } } } } }
// Before environments it was { [planId]: { tenants, mysql } }.
const emptySecrets = () => ({ version: 2, plans: {}, environments: {} });
function secrets() {
  const data = read("secrets.json", null);
  return data && data.version === 2 ? data : emptySecrets();
}
const planSecrets = (all, id) => all.plans[id] || { mysql: {} };
const envSecrets = (all, id) => all.environments[id] || { tenants: {} };

function backup(name) {
  const source = path.join(dir, name);
  const target = `${source}.bak`;
  if (fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target);
}

// Moves data saved before environments existed: each plan's base URL and
// tenants (with their secrets) become an environment the plan points to.
// Plans with the same base URL and tenants share one. Runs on every read
// but only writes when it finds the old shape.
function upgrade() {
  const rawPlans = read("plans.json", null);
  const rawSecrets = read("secrets.json", null);
  const legacyPlans = !!rawPlans && Object.values(rawPlans).some((p) => "tenants" in p || "baseUrl" in p);
  const legacySecrets = !!rawSecrets && rawSecrets.version !== 2 && Object.keys(rawSecrets).length > 0;
  if (!legacyPlans && !legacySecrets) return;
  backup("plans.json");
  backup("secrets.json");
  const envs = read("environments.json", {});
  const next = legacySecrets ? emptySecrets() : secrets();
  const byKey = new Map();
  for (const [id, plan] of Object.entries(rawPlans || {})) {
    const old = legacySecrets ? rawSecrets[id] || {} : { tenants: {}, mysql: planSecrets(next, id).mysql };
    next.plans[id] = { mysql: old.mysql || {} };
    if (!("tenants" in plan || "baseUrl" in plan)) continue;
    const tenantSecrets = old.tenants || {};
    const tenants = (plan.tenants || []).map((t) => ({
      ...t,
      // Older plans picked the login mode from whichever secret was saved.
      authMode: t.authMode || (tenantSecrets[t.client] && tenantSecrets[t.client].token ? "token" : "login"),
    }));
    const baseUrl = plan.baseUrl || "http://localhost:8080";
    const key = JSON.stringify([baseUrl, tenants, tenantSecrets]);
    let envId = byKey.get(key);
    if (!envId) {
      let host;
      try {
        host = new URL(baseUrl).host;
      } catch (_) {
        host = "local";
      }
      const base = host.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "") || "env";
      envId = base;
      for (let n = 2; envs[envId]; n++) envId = `${base}-${n}`;
      const names = new Set(Object.values(envs).map((e) => e.name));
      let name = host;
      for (let n = 2; names.has(name); n++) name = `${host} ${n}`;
      envs[envId] = { id: envId, name, baseUrl, variables: {}, tenants };
      next.environments[envId] = { tenants: tenantSecrets };
      byKey.set(key, envId);
    }
    plan.environmentId = envId;
    delete plan.tenants;
    delete plan.baseUrl;
  }
  // Secrets first: a crash in between leaves unused secrets, never a
  // tenant without its credentials.
  write("secrets.json", next);
  write("environments.json", envs);
  if (rawPlans) write("plans.json", rawPlans);
}

function environments() {
  upgrade();
  const data = read("environments.json", null);
  if (!data || !Object.keys(data).length) return { local: newEnvironment() };
  return Object.fromEntries(Object.entries(data).map(([id, env]) => [id, migrateEnvironment(env)]));
}

function plans() {
  upgrade();
  const data = read("plans.json", null);
  const envIds = Object.keys(environments());
  const fix = (plan) => ({
    ...plan,
    // A plan always points at an environment that exists.
    environmentId: envIds.includes(plan.environmentId) ? plan.environmentId : envIds[0],
  });
  if (!data) return { default: fix(newPlan()) };
  return Object.fromEntries(Object.entries(data).map(([id, plan]) => [id, fix(migratePlan(plan))]));
}

// The plan as the browser sees it: MySQL passwords replaced by flags.
function publicPlan(plan) {
  const mysql = planSecrets(secrets(), plan.id).mysql;
  return {
    ...plan,
    mysql: plan.mysql.map((m) => ({ ...m, hasPassword: !!(mysql[m.id] && mysql[m.id].password) })),
  };
}

// The environment as the browser sees it: secrets replaced by "has…"
// flags, plus the plans that run against it.
function publicEnvironment(env) {
  const tenantSecrets = envSecrets(secrets(), env.id).tenants;
  return {
    ...env,
    tenants: env.tenants.map((t) => {
      const secret = tenantSecrets[t.client] || {};
      return { ...t, savedClient: t.client, hasPassword: !!secret.password, hasToken: !!secret.token };
    }),
    plans: Object.values(plans())
      .filter((p) => p.environmentId === env.id)
      .map((p) => ({ id: p.id, name: p.name })),
  };
}

// Merge secrets typed in the browser with those already saved. Blank fields
// keep the saved value; `savedClient` keeps secrets across a client rename.
function mergeTenantSecret(existing, t) {
  const prior = existing[t.savedClient || t.client] || {};
  const next = { ...prior };
  if (t.authMode === "token") {
    delete next.password;
    if (t.token) next.token = String(t.token).replace(/^Bearer\s+/i, "");
  } else {
    delete next.token;
    if (t.password) next.password = String(t.password);
  }
  return next;
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

function savePlan(input) {
  const all = plans();
  const allSecrets = secrets();
  const existing = planSecrets(allSecrets, input.id).mysql;
  const mysql = {};
  for (const m of input.mysql || [])
    mysql[m.id] = { password: m.password ? String(m.password) : (existing[m.id] || {}).password || "" };
  const plan = validatePlan(input);
  if (!environments()[plan.environmentId]) fail("environmentId", "Choose an environment for this plan.");
  all[plan.id] = plan;
  allSecrets.plans[plan.id] = { mysql };
  write("secrets.json", allSecrets);
  write("plans.json", all);
  return publicPlan(plan);
}

function saveEnvironment(input) {
  const all = environments();
  const allSecrets = secrets();
  const existing = envSecrets(allSecrets, input && input.id).tenants;
  const tenantSecrets = {};
  for (const t of (input && Array.isArray(input.tenants) && input.tenants) || [])
    if (t && typeof t.client === "string") tenantSecrets[t.client.trim()] = mergeTenantSecret(existing, t);
  const env = validateEnvironment(input);
  if (Object.values(all).some((e) => e.id !== env.id && e.name.toLowerCase() === env.name.toLowerCase()))
    fail("name", `Another environment is already called ${env.name}.`);
  all[env.id] = env;
  allSecrets.environments[env.id] = { tenants: tenantSecrets };
  write("secrets.json", allSecrets);
  write("environments.json", all);
  return publicEnvironment(env);
}

function duplicateEnvironment(id) {
  const all = environments();
  const source = all[id];
  if (!source) return null;
  const names = new Set(Object.values(all).map((e) => e.name));
  let name = `${source.name} copy`;
  for (let n = 2; names.has(name); n++) name = `${source.name} copy ${n}`;
  const copy = { ...structuredClone(source), id: `env-${Date.now()}`, name };
  const allSecrets = secrets();
  all[copy.id] = copy;
  allSecrets.environments[copy.id] = structuredClone(envSecrets(allSecrets, id));
  write("secrets.json", allSecrets);
  write("environments.json", all);
  return publicEnvironment(copy);
}

function removeEnvironment(id) {
  const all = environments();
  if (!all[id]) return false;
  if (Object.keys(all).length === 1) throw httpError(400, "Keep at least one environment.");
  const users = Object.values(plans()).filter((p) => p.environmentId === id);
  if (users.length)
    throw httpError(400, `${all[id].name} is used by ${users.map((p) => p.name).join(", ")}. Switch those plans to another environment first.`);
  delete all[id];
  write("environments.json", all);
  const allSecrets = secrets();
  delete allSecrets.environments[id];
  write("secrets.json", allSecrets);
  return true;
}

function environmentSecrets(id) {
  return envSecrets(secrets(), id).tenants;
}

// counters.json: { [planId]: { [environmentId]: { "request::field": next } } }.
// Generated counters continue from where the last run ended, per environment
// because each one has its own database.
function counterState(planId, envId) {
  return ((read("counters.json", {})[planId] || {})[envId]) || {};
}
function saveCounters(planId, envId, snapshot) {
  const all = read("counters.json", {});
  all[planId] = { ...all[planId], [envId]: snapshot };
  write("counters.json", all);
}

// A saved plan joined with its environment, ready for preflight or a run.
// `environmentId` overrides the plan's own choice (CLI --env).
function runPlan(id, environmentId) {
  const stored = plans()[id];
  if (!stored) return null;
  const plan = validatePlan(stored);
  const envId = environmentId || plan.environmentId;
  const env = environments()[envId];
  if (!env) throw httpError(404, `Environment ${envId} not found.`);
  const allSecrets = secrets();
  const tenantSecrets = envSecrets(allSecrets, envId).tenants;
  return {
    plan: resolveRun(plan, validateEnvironment(env), tenantSecrets),
    secrets: tenantSecrets,
    mysqlSecrets: planSecrets(allSecrets, id).mysql,
    counters: new Counters(counterState(id, envId)),
    // Call with counters.snapshot() once sends are done.
    saveCounters: (snapshot) => saveCounters(id, envId, snapshot),
  };
}

// Copies a saved plan together with its MySQL passwords. The copy runs
// against the same environment.
function duplicatePlan(id) {
  const all = plans();
  const source = all[id];
  if (!source) return null;
  const allSecrets = secrets();
  const copy = { ...structuredClone(source), id: `plan-${Date.now()}`, name: `${source.name} copy` };
  all[copy.id] = copy;
  allSecrets.plans[copy.id] = structuredClone(planSecrets(allSecrets, id));
  write("secrets.json", allSecrets);
  write("plans.json", all);
  return publicPlan(copy);
}

function removePlan(id) {
  if (id === "default") throw httpError(400, "The default plan cannot be deleted.");
  upgrade();
  const all = read("plans.json", {});
  if (!all[id]) return false;
  delete all[id];
  write("plans.json", all);
  const allSecrets = secrets();
  delete allSecrets.plans[id];
  write("secrets.json", allSecrets);
  const counters = read("counters.json", {});
  if (counters[id]) {
    delete counters[id];
    write("counters.json", counters);
  }
  return true;
}

// Reports: full files per run plus a small index for the list view.
function reportSummary(r) {
  return {
    id: r.id,
    name: r.name,
    label: r.label,
    planId: r.planId,
    environment: r.environment || null,
    startedAt: r.startedAt,
    elapsedSeconds: r.elapsedSeconds,
    targetVUs: r.targetVUs,
    stopped: r.stopped,
    rate: r.rate,
    overall: { ...r.overall, statuses: undefined },
    verdict: r.verdict || null,
    // Per-request numbers for trend charts across runs.
    byRequest: Object.fromEntries(
      Object.entries(r.byRequest || {}).map(([name, s]) => [
        name,
        { total: s.total, failed: s.failed, p50Ms: s.p50Ms, p95Ms: s.p95Ms, p99Ms: s.p99Ms },
      ]),
    ),
  };
}
function reportFiles() {
  ensure();
  return fs.readdirSync(dir).filter((n) => /^report-[\w-]+\.json$/.test(n));
}
function reports() {
  let index = read("reports-index.json", null);
  // Rebuild when missing, or written by a version without per-request data
  // or environments.
  if (!index || index.some((r) => !r.byRequest || !("environment" in r))) {
    index = reportFiles()
      .map((n) => read(n, null))
      .filter(Boolean)
      .map(reportSummary);
    write("reports-index.json", index);
  }
  return [...index].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
function saveReport(report) {
  write(`report-${report.id}.json`, report);
  const index = reports().filter((r) => r.id !== report.id);
  index.push(reportSummary(report));
  write("reports-index.json", index);
}
function report(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  return read(`report-${id}.json`, null);
}
function removeReport(id) {
  if (!/^[\w-]+$/.test(id)) return false;
  try {
    fs.unlinkSync(path.join(dir, `report-${id}.json`));
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
  write("reports-index.json", reports().filter((r) => r.id !== id));
  return true;
}

module.exports = {
  plans,
  publicPlan,
  savePlan,
  runPlan,
  removePlan,
  duplicatePlan,
  environments,
  publicEnvironment,
  saveEnvironment,
  duplicateEnvironment,
  removeEnvironment,
  environmentSecrets,
  saveReport,
  reports,
  report,
  removeReport,
  dir,
};
