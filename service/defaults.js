"use strict";

const requests = [
  { name: "Products", method: "GET", path: "/products", enabled: true },
  { name: "Customers", method: "GET", path: "/customers/", enabled: true },
  {
    name: "Order details",
    method: "GET",
    path: "/orders/fetch-order-details",
    query: [{ key: "orderId", value: "{{orderId}}", enabled: true }],
    enabled: true,
  },
  {
    name: "Cloud order list",
    method: "GET",
    path: "/orders/fetch-order-list",
    query: [
      { key: "searchString", value: "", enabled: true },
      { key: "page_size", value: "50", enabled: true },
      { key: "sort_order", value: "DESC", enabled: true },
      { key: "departmentId", value: "{{departmentId}}", enabled: true },
      { key: "posId", value: "{{posId}}", enabled: true },
    ],
    enabled: true,
  },
];

// Matches the original hard-coded /pos-login behaviour.
function defaultLogin() {
  return {
    method: "POST",
    path: "/pos-login",
    headers: [],
    query: [],
    form: [],
    bodyType: "json",
    body: '{\n  "client": "{{client}}",\n  "username": "{{username}}",\n  "password": "{{password}}"\n}',
    tokenPath: "token",
  };
}

const requestDefaults = () => ({
  query: [],
  headers: [],
  form: [],
  body: "",
  bodyType: "none",
  authMode: "tenantBearer",
});

function newPlan() {
  return {
    id: "default",
    name: "Duell API baseline",
    label: "",
    environmentId: "local",
    settings: {
      vusPerTenant: 2,
      rampUpSeconds: 30,
      durationSeconds: 270,
      timeoutMs: 15000,
      // A pause after each call, like a user reading the screen.
      pacingMs: 1000,
      checkSuccessField: true,
    },
    thresholds: { p95Ms: null, errorRatePct: null },
    login: defaultLogin(),
    requests: requests.map((r) => ({ ...requestDefaults(), ...structuredClone(r) })),
    mysql: [],
  };
}

// The environment new installs start with.
function newEnvironment() {
  return { id: "local", name: "Local", baseUrl: "http://localhost:8080", variables: {}, tenants: [] };
}

// Bring plans saved by older versions up to the current shape. Tenants and
// the base URL moved to environments; store.js moves those between files.
function migratePlan(plan) {
  const settings = { ...plan.settings };
  if (settings.vusPerTenant == null) settings.vusPerTenant = settings.workersPerTenant;
  delete settings.workersPerTenant;
  if (settings.checkSuccessField == null) settings.checkSuccessField = true;
  // Runs are capped at 10 minutes now; older plans could hold for an hour.
  settings.rampUpSeconds = Math.min(settings.rampUpSeconds || 0, 599);
  settings.durationSeconds = Math.max(1, Math.min(settings.durationSeconds, 600 - settings.rampUpSeconds));
  return {
    ...plan,
    settings,
    thresholds: plan.thresholds || { p95Ms: null, errorRatePct: null },
    login: plan.login || defaultLogin(),
    requests: plan.requests.map((r) => ({ ...requestDefaults(), ...r })),
    mysql: plan.mysql || [],
  };
}

function migrateEnvironment(env) {
  return {
    variables: {},
    ...env,
    tenants: (env.tenants || []).map((t) => ({ variables: {}, enabled: true, authMode: "login", ...t })),
  };
}

module.exports = { newPlan, newEnvironment, migratePlan, migrateEnvironment, defaultLogin };
