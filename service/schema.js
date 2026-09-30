"use strict";

const tokenPattern = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;
const allowedMethods = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const unsafeMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Variables every tenant provides without the user typing them.
const builtins = new Set(["token", "client", "username", "baseUrl"]);
// Safety cap on concurrent virtual users for one run.
const MAX_VUS = 1000;
// Longest run, ramp-up included.
const MAX_RUN_SECONDS = 600;
const managedHeaders = ["authorization", "host", "content-length", "connection"];

function fail(field, message) {
  const error = new Error(message);
  error.field = field;
  throw error;
}
function text(value, field, max, required) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    fail(field, `Enter ${field} (${max} characters max).`);
  return value.trim();
}
function rawText(value, field, max) {
  if (typeof value !== "string" || value.length > max)
    fail(field, `Enter ${field} (${max} characters max).`);
  return value;
}
function number(value, field, min, max, integer) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    fail(
      field,
      `${field} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}.`,
    );
  return value;
}
function optionalNumber(value, field, min, max) {
  return value == null || value === "" ? null : number(value, field, min, max);
}
function pairs(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 50)
    fail(field, `${field} must have at most 50 entries.`);
  return value.map((p, i) => {
    if (!p || typeof p !== "object") fail(`${field}.${i}`, "Invalid entry.");
    const key = text(p.key, `${field}.${i}.key`, 128, true);
    const val = rawText(
      p.value == null ? "" : p.value,
      `${field}.${i}.value`,
      4096,
    );
    if (/[\r\n]/.test(key) || /[\r\n]/.test(val))
      fail(`${field}.${i}`, "Line breaks are not allowed here.");
    return { key, value: val, enabled: p.enabled !== false };
  });
}
function origin(value) {
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    fail("baseUrl", "Enter an HTTP or HTTPS API origin.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    fail(
      "baseUrl",
      "Use an HTTP or HTTPS origin without a path, query, or credentials.",
    );
  return url.origin;
}
// Request paths may be full URLs that override the plan's base URL.
const isAbsolute = (path) => /^https?:\/\//i.test(path);

function names(template) {
  return [...template.matchAll(tokenPattern)].map((match) => match[1]);
}

// Every {{variable}} a request needs, in the order they appear.
function requestVariables(r) {
  return [
    r.path,
    ...r.query.filter((p) => p.enabled).flatMap((p) => [p.key, p.value]),
    ...r.headers.filter((p) => p.enabled).map((p) => p.value),
    ...(r.bodyType === "form"
      ? r.form.filter((p) => p.enabled).flatMap((p) => [p.key, p.value])
      : []),
    ...(r.bodyType === "json" || r.bodyType === "text" ? [r.body] : []),
  ].flatMap(names);
}

function validateRequest(r, field) {
  if (!r || typeof r !== "object") fail(field, "Invalid request.");
  const name = text(r.name, `${field}.name`, 120, true);
  const method = text(r.method, `${field}.method`, 10, true).toUpperCase();
  if (!allowedMethods.has(method))
    fail(`${field}.method`, "Unsupported HTTP method.");
  const authMode = r.authMode || "tenantBearer";
  if (!["tenantBearer", "none"].includes(authMode))
    fail(`${field}.authMode`, "Choose tenant bearer token or no authorization.");
  const path = text(r.path, `${field}.path`, 2048, true);
  if (/[\r\n#\\\s]/.test(path))
    fail(`${field}.path`, "Remove spaces, line breaks, # fragments and backslashes from the URL.");
  if (path.startsWith("{{")) {
    // The URL comes from a variable such as {{baseUrl}} or {{apiHost}};
    // it is checked once the variable is filled in.
  } else if (isAbsolute(path)) {
    // A full URL overrides the plan's base URL for this request.
    let url;
    try {
      url = new URL(path.replace(tokenPattern, "x"));
    } catch (_) {
      fail(`${field}.path`, "Enter a valid http:// or https:// URL.");
    }
    if (url.username || url.password)
      fail(`${field}.path`, "Put credentials in headers, not in the URL.");
  } else if (!path.startsWith("/") || path.startsWith("//"))
    fail(`${field}.path`, "Start with / for a path on the base URL, a full http(s):// URL, or a {{variable}} holding the URL.");
  const query = pairs(r.query, `${field}.query`);
  const headers = pairs(r.headers, `${field}.headers`);
  const form = pairs(r.form, `${field}.form`);
  if (headers.some((h) => managedHeaders.includes(h.key.toLowerCase())))
    fail(
      `${field}.headers`,
      "Authorization, Host, Content-Length, and Connection are managed by the tool.",
    );
  const bodyType = r.bodyType || "none";
  if (!["none", "json", "text", "form"].includes(bodyType))
    fail(`${field}.bodyType`, "Choose no body, JSON, text, or URL-encoded form.");
  const body = rawText(r.body || "", `${field}.body`, 65536);
  if (bodyType === "json" && body && !names(body).length) {
    try {
      JSON.parse(body);
    } catch (_) {
      fail(`${field}.body`, "Enter valid JSON.");
    }
  }
  return {
    name,
    method,
    path,
    authMode,
    query,
    headers,
    form,
    bodyType,
    body,
    enabled: r.enabled !== false,
  };
}

function validateLogin(l) {
  const spec = validateRequest(
    { name: "Login", authMode: "none", ...(l || {}) },
    "login",
  );
  const tokenPath = text((l && l.tokenPath) || "", "login.tokenPath", 200, true);
  if (!/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/.test(tokenPath))
    fail("login.tokenPath", "Use a dot path such as token or data.accessToken.");
  return { ...spec, authMode: "none", enabled: true, tokenPath };
}

// durationSeconds is the hold after ramp-up; ramp-up + hold is the total.
function validateSettings(s = {}) {
  const settings = {
    vusPerTenant: number(s.vusPerTenant, "settings.vusPerTenant", 1, MAX_VUS, true),
    rampUpSeconds: number(s.rampUpSeconds, "settings.rampUpSeconds", 0, MAX_RUN_SECONDS - 1),
    durationSeconds: number(s.durationSeconds, "settings.durationSeconds", 1, MAX_RUN_SECONDS),
    timeoutMs: number(s.timeoutMs, "settings.timeoutMs", 100, 120000, true),
    pacingMs: number(s.pacingMs || 0, "settings.pacingMs", 0, 60000, true),
    checkSuccessField: s.checkSuccessField !== false,
  };
  if (settings.rampUpSeconds + settings.durationSeconds > MAX_RUN_SECONDS)
    fail("settings.durationSeconds", `A run can last at most ${MAX_RUN_SECONDS / 60} minutes, ramp-up included.`);
  return settings;
}

function validateTenant(t, field) {
  if (!t || typeof t !== "object") fail(field, "Invalid tenant.");
  const client = text(t.client, `${field}.client`, 120, true);
  const username = text(t.username || "", `${field}.username`, 200, false);
  const authMode = t.authMode || "login";
  if (!["login", "token"].includes(authMode))
    fail(`${field}.authMode`, "Choose login or bearer token.");
  const variables = t.variables || {};
  if (
    typeof variables !== "object" ||
    Array.isArray(variables) ||
    Object.keys(variables).length > 100
  )
    fail(`${field}.variables`, "Enter variable names and values.");
  const cleaned = {};
  for (const [key, value] of Object.entries(variables)) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(key) ||
      builtins.has(key) ||
      !["string", "number", "boolean"].includes(typeof value) ||
      String(value).length > 4096
    )
      fail(
        `${field}.variables`,
        builtins.has(key)
          ? `{{${key}}} is provided automatically; remove it from variables.`
          : "Variables need simple names and text or numeric values.",
      );
    cleaned[key] = String(value);
  }
  return { client, username, authMode, variables: cleaned, enabled: t.enabled !== false };
}

// Variables a tenant must fill in before a run, grouped by what needs them.
function requiredVariables(requests, login) {
  const needed = new Set();
  for (const r of requests.filter((r) => r.enabled))
    requestVariables(r).forEach((n) => needed.add(n));
  const forLogin = new Set(
    login ? requestVariables(login).filter((n) => n !== "password") : [],
  );
  for (const n of builtins) {
    needed.delete(n);
    forLogin.delete(n);
  }
  return { requests: [...needed], login: [...forLogin] };
}

function validatePlan(input, secrets, requireTenants) {
  if (
    !input ||
    typeof input !== "object" ||
    JSON.stringify(input).length > 1000000
  )
    fail("plan", "Plan is too large.");
  const id = text(input.id, "id", 80, true);
  if (!/^[a-zA-Z0-9_-]+$/.test(id))
    fail("id", "Plan ID may contain letters, numbers, underscores, and dashes.");
  const name = text(input.name, "name", 120, true);
  const label = text(input.label || "", "label", 120, false);
  const baseUrl = origin(input.baseUrl);
  const settings = validateSettings(input.settings);
  const t = input.thresholds || {};
  const thresholds = {
    p95Ms: optionalNumber(t.p95Ms, "thresholds.p95Ms", 1, 120000),
    errorRatePct: optionalNumber(t.errorRatePct, "thresholds.errorRatePct", 0, 100),
  };
  const login = validateLogin(input.login);
  if (
    !Array.isArray(input.requests) ||
    !input.requests.length ||
    input.requests.length > 100
  )
    fail("requests", "Add 1 to 100 requests.");
  const requestNames = new Set();
  const requests = input.requests.map((r, i) => {
    const spec = validateRequest(r, `requests.${i}`);
    if (requestNames.has(spec.name))
      fail(`requests.${i}.name`, "Request names must be unique.");
    requestNames.add(spec.name);
    return spec;
  });
  if (!requests.some((r) => r.enabled))
    fail("requests", "Enable at least one request.");
  if (
    !Array.isArray(input.tenants) ||
    input.tenants.length > 100 ||
    (requireTenants && !input.tenants.length)
  )
    fail("tenants", "Add 1 to 100 tenants.");
  const required = requiredVariables(requests, login);
  const tenantIds = new Set();
  const tenants = input.tenants.map((raw, i) => {
    const field = `tenants.${i}`;
    const tenant = validateTenant(raw, field);
    if (tenantIds.has(tenant.client))
      fail(`${field}.client`, "Client numbers must be unique.");
    tenantIds.add(tenant.client);
    if (requireTenants && tenant.enabled) {
      const secret = secrets[tenant.client] || {};
      if (tenant.authMode === "token" ? !secret.token : !secret.password)
        fail(
          `${field}.auth`,
          tenant.authMode === "token"
            ? `Enter a bearer token for ${tenant.client}.`
            : `Enter a password for ${tenant.client}.`,
        );
      const keys = [
        ...required.requests,
        ...(tenant.authMode === "login" ? required.login : []),
      ];
      for (const key of keys)
        if (!tenant.variables[key])
          fail(`${field}.variables.${key}`, `Enter ${key} for ${tenant.client}.`);
    }
    return tenant;
  });
  // Only tenants switched on take part in a run.
  const inRun = tenants.filter((t) => t.enabled);
  if (requireTenants && !inRun.length) fail("tenants", "Switch on at least one tenant for the run.");
  if (inRun.length * settings.vusPerTenant > MAX_VUS)
    fail("settings.vusPerTenant", `The plan exceeds the ${MAX_VUS} VU safety limit.`);
  const mysql = (input.mysql || []).map((m, i) => {
    if (!m || typeof m !== "object") fail(`mysql.${i}`, "Invalid MySQL host.");
    const host = text(m.host, `mysql.${i}.host`, 255, true);
    if (!/^[a-zA-Z0-9._:-]+$/.test(host))
      fail(`mysql.${i}.host`, "Invalid MySQL hostname.");
    return {
      id: text(m.id, `mysql.${i}.id`, 80, true),
      host,
      port: number(m.port || 3306, `mysql.${i}.port`, 1, 65535, true),
      user: text(m.user, `mysql.${i}.user`, 128, true),
    };
  });
  if (mysql.length > 10 || new Set(mysql.map((m) => m.id)).size !== mysql.length)
    fail("mysql", "Use at most 10 MySQL hosts with unique IDs.");
  return {
    id,
    name,
    label,
    baseUrl,
    settings,
    thresholds,
    login,
    requests,
    // A plan validated for a run holds only the tenants in the run.
    tenants: requireTenants ? inRun : tenants,
    mysql,
  };
}

module.exports = {
  validatePlan,
  validateRequest,
  validateTenant,
  validateLogin,
  validateSettings,
  requiredVariables,
  origin,
  names,
  isAbsolute,
  unsafeMethods,
  builtins,
  MAX_VUS,
  MAX_RUN_SECONDS,
  tokenPattern,
  fail,
};
