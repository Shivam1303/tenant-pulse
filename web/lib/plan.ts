import type { Environment, LoginSpec, Method, Plan, RequestSpec, Tenant } from "./types";

// Mirrors MAX_VUS in service/schema.js.
export const MAX_VUS = 1000;
// Mirrors MAX_RUN_SECONDS: longest run, ramp-up included.
export const MAX_RUN_SECONDS = 600;
export const inRun = (env: Environment) => env.tenants.filter((t) => t.enabled !== false);
export const unsafeMethods = new Set<Method>(["POST", "PUT", "PATCH", "DELETE"]);
export const builtins = new Set(["token", "client", "username", "baseUrl"]);
const pattern = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

// A request path may be a full URL that overrides the plan's base URL.
export const isAbsolute = (path: string) => /^https?:\/\//i.test(path || "");
// True when the path does not use the plan's base URL prefix as typed.
export const ownsUrl = (path: string) => isAbsolute(path) || (path || "").startsWith("{{");

export const names = (text: string) => [...(text || "").matchAll(pattern)].map((m) => m[1]);

// Mirrors service/schema.js requestVariables.
export function requestVariables(r: Pick<RequestSpec, "path" | "query" | "headers" | "form" | "bodyType" | "body">) {
  return [
    r.path,
    ...(r.query || []).filter((p) => p.enabled).flatMap((p) => [p.key, p.value]),
    ...(r.headers || []).filter((p) => p.enabled).map((p) => p.value),
    ...(r.bodyType === "form" ? (r.form || []).filter((p) => p.enabled).flatMap((p) => [p.key, p.value]) : []),
    ...(r.bodyType === "json" || r.bodyType === "text" ? [r.body] : []),
  ].flatMap(names);
}

export function requiredVariables(plan: Plan) {
  const forRequests = new Set<string>();
  for (const r of plan.requests.filter((r) => r.enabled)) requestVariables(r).forEach((n) => forRequests.add(n));
  const forLogin = new Set(requestVariables(plan.login as LoginSpec).filter((n) => n !== "password"));
  for (const n of builtins) {
    forRequests.delete(n);
    forLogin.delete(n);
  }
  return { requests: [...forRequests], login: [...forLogin] };
}

// What a tenant still needs before a run. A variable the environment shares
// counts as filled in.
export function tenantProblems(plan: Plan, env: Environment, tenant: Tenant) {
  const need = requiredVariables(plan);
  const keys = [...need.requests, ...(tenant.authMode !== "token" ? need.login : [])];
  const missing = [...new Set(keys)].filter((k) => !tenant.variables?.[k] && !env.variables?.[k]);
  const auth =
    tenant.authMode === "token"
      ? !(tenant.token || tenant.hasToken)
      : !(tenant.password || tenant.hasPassword);
  return { missing, auth };
}

export const blankRequest = (n: number): RequestSpec => ({
  name: `New request ${n}`,
  method: "GET",
  path: "/",
  enabled: true,
  authMode: "tenantBearer",
  query: [],
  headers: [],
  form: [],
  bodyType: "none",
  body: "",
});

export const blankTenant = (): Tenant => ({
  client: "",
  username: "",
  authMode: "login",
  variables: {},
  enabled: true,
});

export function uniqueName(base: string, taken: string[]) {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}
