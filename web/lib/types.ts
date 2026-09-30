export type Method = "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE";
export type Pair = { key: string; value: string; enabled: boolean };
export type BodyType = "none" | "json" | "text" | "form";
export type RequestSpec = {
  name: string;
  method: Method;
  path: string;
  enabled: boolean;
  authMode?: "tenantBearer" | "none";
  query: Pair[];
  headers: Pair[];
  form: Pair[];
  bodyType: BodyType;
  body: string;
};
export type LoginSpec = Omit<RequestSpec, "name" | "enabled" | "authMode"> & {
  tokenPath: string;
};
export type Tenant = {
  client: string;
  savedClient?: string;
  username: string;
  authMode?: "login" | "token";
  password?: string;
  token?: string;
  hasPassword?: boolean;
  hasToken?: boolean;
  variables: Record<string, string>;
  // Off = kept in the plan but left out of runs.
  enabled?: boolean;
};
export type MysqlHost = {
  id: string;
  host: string;
  port: number;
  user: string;
  password?: string;
  hasPassword?: boolean;
};
export type Settings = {
  vusPerTenant: number;
  rampUpSeconds: number;
  durationSeconds: number;
  timeoutMs: number;
  pacingMs: number;
  checkSuccessField: boolean;
};
export type Thresholds = { p95Ms: number | null; errorRatePct: number | null };
// What to call and how hard. Where to call it comes from its environment.
export type Plan = {
  id: string;
  name: string;
  label: string;
  environmentId: string;
  settings: Settings;
  thresholds: Thresholds;
  login: LoginSpec;
  requests: RequestSpec[];
  mysql: MysqlHost[];
};
export type PlanSummary = { id: string; name: string };
// A target system: its base URL, variables shared by its tenants, and the
// tenants (accounts) that exist there.
export type Environment = {
  id: string;
  name: string;
  baseUrl: string;
  variables: Record<string, string>;
  tenants: Tenant[];
  // Plans that run against it (read-only, from the service).
  plans?: PlanSummary[];
};
export type EnvironmentRef = { id: string; name: string } | null;
export type Notice = {
  type: "error" | "success" | "info";
  text: string;
  field?: string;
} | null;
export type Stats = {
  total: number;
  successful: number;
  failed: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  statuses?: Record<string, number>;
  errors: Record<string, number>;
};
export type SeriesPoint = {
  second: number;
  rate: number;
  errorRate: number;
  p50Ms?: number;
  p95Ms: number;
  p99Ms?: number;
  activeVUs: number;
  lagMs?: number;
};
export type MysqlPoint = {
  second: number;
  host: string;
  connected?: number;
  running?: number;
  error?: string;
};
export type Verdict = {
  pass: boolean;
  checks: { name: string; limit: number; actual: number; unit: string; pass: boolean }[];
} | null;
export type PreflightRow = {
  tenant: string;
  request: string;
  ok: boolean;
  detail: string;
};
export type RunState = "idle" | "preflight" | "running" | "stopping" | "finished" | "failed";
export type Live = {
  id?: string;
  planId?: string;
  planName?: string;
  environment?: EnvironmentRef;
  state: RunState;
  error?: string;
  activeVUs?: number;
  targetVUs?: number;
  plannedSeconds?: number;
  elapsedSeconds?: number;
  rate?: number;
  overall?: Stats;
  byTenant?: Record<string, Stats>;
  byRequest?: Record<string, Stats>;
  verdict?: Verdict;
  thresholds?: Thresholds;
  preflight?: { done: number; total: number; failures: PreflightRow[] };
  series?: SeriesPoint[];
  mysqlSeries?: MysqlPoint[];
  events?: { time: string; message: string; tenant?: string }[];
  startedAt?: string | null;
};
export type Report = {
  id: string;
  planId?: string;
  environment?: EnvironmentRef;
  name: string;
  label: string;
  apiHost: string;
  startedAt: string;
  endedAt: string;
  elapsedSeconds: number;
  rate?: number;
  stopped: boolean;
  settings: Settings;
  targetVUs: number;
  tenants: string[];
  requests: { name: string; method: string }[];
  mysqlMeasured: boolean;
  overall: Stats;
  byTenant: Record<string, Stats>;
  byRequest: Record<string, Stats>;
  series: SeriesPoint[];
  mysqlSeries: MysqlPoint[];
  events?: Live["events"];
  verdict?: Verdict;
};
export type ReportSummary = Pick<
  Report,
  "id" | "name" | "label" | "startedAt" | "elapsedSeconds" | "targetVUs" | "stopped" | "overall" | "rate"
> & {
  planId?: string;
  environment?: EnvironmentRef;
  verdict?: Verdict;
  byRequest?: Record<string, Pick<Stats, "total" | "failed" | "p50Ms" | "p95Ms" | "p99Ms">>;
};
export type TryResult = {
  status?: number;
  error?: string;
  ms: number;
  body?: string;
  bytes?: number;
  contentType?: string;
  successFalse?: boolean;
  url?: string;
  method?: string;
};
export type LoginTest = {
  ok: boolean;
  tokenPreview?: string;
  detail?: string;
  status?: number;
  ms?: number;
  body?: string;
};
export type ImportResult = {
  kind: "curl" | "postman" | "postman-environment";
  name: string | null;
  requests: { request: RequestSpec; warnings: string[]; error?: string }[];
  environment: { name: string; baseUrl: string | null; variables: Record<string, string> } | null;
  warnings: string[];
};
