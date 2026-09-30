"use strict";

const fs = require("fs");
const path = require("path");
const { newPlan, migratePlan } = require("./defaults");
const { validatePlan } = require("./schema");

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

const emptySecrets = () => ({ tenants: {}, mysql: {} });
function secrets() {
  return read("secrets.json", {});
}
function plans() {
  const data = read("plans.json", null);
  if (!data) return { default: newPlan() };
  const allSecrets = secrets();
  const result = {};
  for (const [id, plan] of Object.entries(data)) {
    const tenantSecrets = (allSecrets[id] || emptySecrets()).tenants;
    const migrated = migratePlan(plan);
    // Older plans picked the login mode from whichever secret was saved.
    migrated.tenants = migrated.tenants.map((t) => ({
      ...t,
      authMode:
        t.authMode ||
        (tenantSecrets[t.client] && tenantSecrets[t.client].token ? "token" : "login"),
    }));
    result[id] = migrated;
  }
  return result;
}

// The plan as the browser sees it: secrets replaced by "has…" flags.
function publicPlan(plan) {
  const privateData = secrets()[plan.id] || emptySecrets();
  return {
    ...plan,
    tenants: plan.tenants.map((t) => {
      const secret = privateData.tenants[t.client] || {};
      return {
        ...t,
        savedClient: t.client,
        hasPassword: !!secret.password,
        hasToken: !!secret.token,
      };
    }),
    mysql: plan.mysql.map((m) => ({
      ...m,
      hasPassword: !!(privateData.mysql[m.id] && privateData.mysql[m.id].password),
    })),
  };
}

// Merge secrets typed in the browser with those already saved. Blank fields
// keep the saved value; `savedClient` keeps secrets across a client rename.
function mergeTenantSecret(existing, t) {
  const prior = existing.tenants[t.savedClient || t.client] || {};
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

function savePlan(input) {
  const all = plans();
  const allSecrets = secrets();
  const existing = allSecrets[input.id] || emptySecrets();
  const tenantSecrets = {};
  for (const t of input.tenants || [])
    if (t && typeof t.client === "string")
      tenantSecrets[t.client.trim()] = mergeTenantSecret(existing, t);
  const mysqlSecrets = {};
  for (const m of input.mysql || [])
    mysqlSecrets[m.id] = {
      password: m.password
        ? String(m.password)
        : (existing.mysql[m.id] || {}).password || "",
    };
  const plan = validatePlan(input, tenantSecrets, false);
  all[plan.id] = plan;
  allSecrets[plan.id] = { tenants: tenantSecrets, mysql: mysqlSecrets };
  // Secrets first: a crash in between leaves unused secrets, never a plan
  // without its credentials.
  write("secrets.json", allSecrets);
  write("plans.json", all);
  return publicPlan(plan);
}

function getPlan(id, requireTenants) {
  const plan = plans()[id];
  if (!plan) return null;
  const privateData = secrets()[id] || emptySecrets();
  return {
    plan: validatePlan(plan, privateData.tenants, requireTenants),
    secrets: privateData.tenants,
    mysqlSecrets: privateData.mysql,
  };
}

// Copies a saved plan together with its secrets.
function duplicatePlan(id) {
  const all = plans();
  const source = all[id];
  if (!source) return null;
  const allSecrets = secrets();
  const copy = { ...structuredClone(source), id: `plan-${Date.now()}`, name: `${source.name} copy` };
  all[copy.id] = copy;
  allSecrets[copy.id] = structuredClone(allSecrets[id] || emptySecrets());
  write("secrets.json", allSecrets);
  write("plans.json", all);
  return publicPlan(copy);
}

function removePlan(id) {
  if (id === "default")
    throw Object.assign(new Error("The default plan cannot be deleted."), { status: 400 });
  const all = read("plans.json", {});
  if (!all[id]) return false;
  delete all[id];
  write("plans.json", all);
  const privateData = secrets();
  delete privateData[id];
  write("secrets.json", privateData);
  return true;
}

// Reports: full files per run plus a small index for the list view.
function reportSummary(r) {
  return {
    id: r.id,
    name: r.name,
    label: r.label,
    planId: r.planId,
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
  // Rebuild when missing, or written by a version without per-request data.
  if (!index || index.some((r) => !r.byRequest)) {
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
  getPlan,
  removePlan,
  duplicatePlan,
  saveReport,
  reports,
  report,
  removeReport,
  dir,
};
