"use client";

import { useMemo, useState } from "react";
import {
  CheckCircle2,
  FileUp,
  KeyRound,
  Loader2,
  LogIn,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useWorkspace } from "../../../components/workspace-provider";
import { Dialog, Empty, Field, PairEditor, Switch, useConfirm } from "../../../components/ui";
import { api } from "../../../lib/api";
import { tenantsFromCsv } from "../../../lib/csv";
import type { ImportRow } from "../../../lib/csv";
import { blankTenant, builtins, inRun, requiredVariables, tenantProblems } from "../../../lib/plan";
import { ms } from "../../../lib/format";
import type { BodyType, Environment, LoginSpec, LoginTest, Method, Plan, Tenant } from "../../../lib/types";

type View = "tenants" | "login";

function StatusBadge({ plan, env, tenant }: { plan: Plan; env: Environment; tenant: Tenant }) {
  const { missing, auth } = tenantProblems(plan, env, tenant);
  if (!tenant.client) return <span className="badge warning">No client</span>;
  if (tenant.enabled === false) return <span className="badge">Skipped</span>;
  if (auth) return <span className="badge warning">{tenant.authMode === "token" ? "No token" : "No password"}</span>;
  if (missing.length)
    return (
      <span className="badge warning" title={missing.join(", ")}>
        {missing.length} missing
      </span>
    );
  return (
    <span className="badge success">
      <CheckCircle2 /> Ready
    </span>
  );
}

function VariableRow({
  name,
  value,
  required,
  shared,
  onRename,
  onChange,
  onRemove,
}: {
  name: string;
  value: string;
  required?: boolean;
  // The environment's shared value, used when this tenant leaves it empty.
  shared?: string;
  onRename?: (name: string) => void;
  onChange: (value: string) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="var-row">
      {required ? (
        <code className="var-name">{name}</code>
      ) : (
        <input
          className="input mono"
          aria-label="Variable name"
          defaultValue={name}
          key={name}
          onBlur={(e) => e.target.value !== name && onRename?.(e.target.value.trim())}
        />
      )}
      <input
        className={`input mono ${required && !value && !shared ? "invalid" : ""}`}
        aria-label={`${name} value`}
        value={value}
        placeholder={shared ? `${shared}  (shared)` : required ? "Required by a request" : "Value"}
        title={shared && !value ? "Empty uses the environment’s shared value" : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {onRemove ? (
        <button className="btn ghost icon sm" onClick={onRemove} aria-label={`Remove ${name}`}>
          <X />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

function TenantEditor({
  plan,
  env,
  index,
  onRemove,
}: {
  plan: Plan;
  env: Environment;
  index: number;
  onRemove: () => void;
}) {
  const { updateEnv, setNotice } = useWorkspace();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<LoginTest | null>(null);
  const tenant = env.tenants[index];
  const need = requiredVariables(plan);
  const required = [...new Set([...need.requests, ...(tenant.authMode !== "token" ? need.login : [])])];
  const extra = Object.keys(tenant.variables || {}).filter((k) => !required.includes(k));

  function update(patch: Partial<Tenant>) {
    setResult(null);
    updateEnv((current) => ({
      ...current,
      tenants: current.tenants.map((t, i) => (i === index ? { ...t, ...patch } : t)),
    }));
  }
  const setVar = (key: string, value: string) => update({ variables: { ...tenant.variables, [key]: value } });
  function renameVar(from: string, to: string) {
    if (!to || to === from) return;
    if (builtins.has(to) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(to)) {
      setNotice({ type: "error", text: `“${to}” can’t be a variable name.` });
      return;
    }
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(tenant.variables)) next[k === from ? to : k] = v;
    update({ variables: next });
  }
  function removeVar(key: string) {
    const next = { ...tenant.variables };
    delete next[key];
    update({ variables: next });
  }
  function addVar() {
    let name = "variable";
    let n = 1;
    while (name in (tenant.variables || {})) name = `variable${n++}`;
    setVar(name, "");
  }
  async function testLogin() {
    setTesting(true);
    setResult(null);
    try {
      setResult(
        await api<LoginTest>("/auth/test", {
          method: "POST",
          body: JSON.stringify({
            environmentId: env.id,
            baseUrl: env.baseUrl,
            variables: env.variables,
            settings: plan.settings,
            login: plan.login,
            tenant,
          }),
        }),
      );
    } catch (error) {
      setNotice({ type: "error", text: (error as Error).message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="card tenant-editor">
      <div className="card-head">
        <div>
          <h2>{tenant.client || "New tenant"}</h2>
          <p>Credentials and values for this tenant in {env.name}.</p>
        </div>
        <button className="btn ghost icon sm" onClick={onRemove} aria-label="Remove tenant" title="Remove tenant">
          <Trash2 />
        </button>
      </div>
      <div className="card-body stack">
        <div className="form-grid">
          <Field label="Client number" htmlFor="client" hint="Available as {{client}}">
            <input
              id="client"
              className="input mono"
              value={tenant.client}
              placeholder="client-1001"
              onChange={(e) => update({ client: e.target.value })}
            />
          </Field>
          <Field label="Authentication">
            <div className="segmented" role="tablist">
              <button role="tab" aria-selected={tenant.authMode !== "token"} onClick={() => update({ authMode: "login" })}>
                <LogIn size={14} /> Login
              </button>
              <button role="tab" aria-selected={tenant.authMode === "token"} onClick={() => update({ authMode: "token" })}>
                <KeyRound size={14} /> Token
              </button>
            </div>
          </Field>
          {tenant.authMode === "token" ? (
            <Field
              label="Bearer token"
              htmlFor="token"
              className="full"
              hint={tenant.hasToken ? "A token is saved. Leave blank to keep it." : "Sent as {{token}} on every request."}
            >
              <input
                id="token"
                className="input mono"
                type="password"
                autoComplete="off"
                value={tenant.token || ""}
                placeholder={tenant.hasToken ? "••••••••  saved" : "Paste token"}
                onChange={(e) => update({ token: e.target.value })}
              />
            </Field>
          ) : (
            <>
              <Field label="Username" htmlFor="username" hint="Available as {{username}}">
                <input
                  id="username"
                  className="input"
                  autoComplete="off"
                  value={tenant.username || ""}
                  placeholder="test-user"
                  onChange={(e) => update({ username: e.target.value })}
                />
              </Field>
              <Field
                label="Password"
                htmlFor="password"
                hint={tenant.hasPassword ? "A password is saved. Leave blank to keep it." : "Used only by the login request."}
              >
                <input
                  id="password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={tenant.password || ""}
                  placeholder={tenant.hasPassword ? "••••••••  saved" : "Password"}
                  onChange={(e) => update({ password: e.target.value })}
                />
              </Field>
            </>
          )}
        </div>
        <div className="login-test">
          <button className="btn sm" onClick={() => void testLogin()} disabled={testing || !tenant.client}>
            {testing ? <Loader2 className="spin" /> : <ShieldCheck />}
            {tenant.authMode === "token" ? "Check token" : "Test login"}
          </button>
          {result ? (
            result.ok ? (
              <span className="success-text small">
                Token received <code>{result.tokenPreview}</code>
                {result.ms != null ? <span className="muted"> · {ms(result.ms)}</span> : null}
              </span>
            ) : (
              <span className="danger-text small">{result.detail}</span>
            )
          ) : null}
        </div>
        {result && !result.ok && result.body ? <pre className="login-body">{result.body}</pre> : null}

        <div className="section-title">
          <h3>Variables</h3>
          <button className="btn ghost sm" onClick={addVar}>
            <Plus /> Add variable
          </button>
        </div>
        <div className="var-list">
          {required.map((k) => (
            <VariableRow
              key={k}
              name={k}
              value={tenant.variables?.[k] || ""}
              shared={env.variables?.[k]}
              required
              onChange={(v) => setVar(k, v)}
            />
          ))}
          {extra.map((k) => (
            <VariableRow
              key={k}
              name={k}
              value={tenant.variables[k]}
              shared={env.variables?.[k]}
              onRename={(to) => renameVar(k, to)}
              onChange={(v) => setVar(k, v)}
              onRemove={() => removeVar(k)}
            />
          ))}
          {!required.length && !extra.length ? (
            <p className="muted small">No variables yet. Requests that use {"{{name}}"} add their fields here automatically.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function LoginSetup({ plan, env }: { plan: Plan; env: Environment }) {
  const { updatePlan } = useWorkspace();
  const login = plan.login;
  const update = (patch: Partial<LoginSpec>) =>
    updatePlan((current) => ({ ...current, login: { ...current.login, ...patch } }));
  return (
    <section className="card login-setup">
      <div className="card-head">
        <div>
          <h2>Login request</h2>
          <p>Preflight calls this once per tenant that uses Login, then stores the token in {"{{token}}"}.</p>
        </div>
      </div>
      <div className="card-body stack">
        <div className="url-bar compact">
          <select
            className={`select method-select method ${login.method}`}
            aria-label="Login method"
            value={login.method}
            onChange={(e) => update({ method: e.target.value as Method })}
          >
            {["POST", "GET", "PUT"].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <div className="url-input">
            <span className="url-base mono" title={`Base URL of ${env.name}`}>
              {env.baseUrl.replace(/^https?:\/\//, "")}
            </span>
            <input
              className="input mono"
              aria-label="Login path"
              value={login.path}
              onChange={(e) => update({ path: e.target.value })}
            />
          </div>
        </div>
        <div className="form-grid">
          <Field label="Body type">
            <select
              className="select"
              value={login.bodyType}
              onChange={(e) => update({ bodyType: e.target.value as BodyType })}
            >
              <option value="json">JSON</option>
              <option value="form">Form (URL-encoded)</option>
              <option value="text">Text</option>
              <option value="none">None</option>
            </select>
          </Field>
          <Field label="Token location" hint="Dot path in the JSON response, e.g. token or data.accessToken">
            <input
              className="input mono"
              value={login.tokenPath}
              onChange={(e) => update({ tokenPath: e.target.value })}
            />
          </Field>
        </div>
        {login.bodyType === "form" ? (
          <PairEditor pairs={login.form} onChange={(form) => update({ form })} addLabel="Add field" />
        ) : login.bodyType !== "none" ? (
          <Field label="Body">
            <textarea
              className="textarea"
              spellCheck={false}
              rows={7}
              value={login.body}
              onChange={(e) => update({ body: e.target.value })}
            />
          </Field>
        ) : null}
        <div>
          <span className="label">Headers</span>
          <PairEditor pairs={login.headers} onChange={(headers) => update({ headers })} addLabel="Add header" />
        </div>
        <div className="callout info">
          <KeyRound />
          <span>
            Use <code>{"{{client}}"}</code>, <code>{"{{username}}"}</code>, <code>{"{{password}}"}</code> and any tenant
            variable. Values are escaped for JSON automatically. If the API later rejects a token, the calls count as
            failures. Log in again with a new run, or paste a fresh token on the tenant.
          </span>
        </div>
      </div>
    </section>
  );
}

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { env, updateEnv, setNotice } = useWorkspace();
  const [text, setText] = useState("");
  const parsed = useMemo(() => (text.trim() ? tenantsFromCsv(text) : null), [text]);
  const rows: ImportRow[] = parsed?.rows || [];
  const valid = rows.filter((r) => !r.problems.length);
  const existing = new Set(env?.tenants.map((t) => t.client));
  const replaced = valid.filter((r) => existing.has(r.tenant.client)).length;

  async function readFile(file: File) {
    setText(await file.text());
  }
  function apply() {
    updateEnv((current) => {
      const byClient = new Map(current.tenants.map((t) => [t.client, t]));
      for (const { tenant } of valid) {
        const prior = byClient.get(tenant.client);
        byClient.set(tenant.client, {
          ...prior,
          ...tenant,
          savedClient: prior?.savedClient,
          hasPassword: prior?.hasPassword,
          hasToken: prior?.hasToken,
          variables: { ...(prior?.variables || {}), ...tenant.variables },
        });
      }
      return { ...current, tenants: [...byClient.values()] };
    });
    setNotice({ type: "success", text: `Imported ${valid.length} tenants into ${env?.name}. Save to keep them.` });
    onClose();
  }
  const columns = rows.length ? Object.keys(rows[0].tenant.variables) : [];

  return (
    <Dialog
      wide
      title={`Import tenants into ${env?.name || "the environment"}`}
      description={
        <>
          Columns <code>client</code>, <code>username</code>, <code>password</code>, <code>token</code>. Every other
          column becomes a variable. Tenants with the same client are updated.
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!valid.length} onClick={apply}>
            Import {valid.length || ""} tenant{valid.length === 1 ? "" : "s"}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="import-source">
          <label className="btn">
            <FileUp /> Choose file
            <input
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])}
            />
          </label>
          <span className="muted small">or paste below</span>
        </div>
        <textarea
          className="textarea"
          rows={5}
          spellCheck={false}
          placeholder={"client,username,password,orderId,departmentId,posId\n1001,test,secret,55,3,7"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {parsed?.error ? <div className="callout danger">{parsed.error}</div> : null}
        {rows.length ? (
          <>
            <p className="muted small">
              {valid.length} ready{replaced ? `, ${replaced} will update existing tenants` : ""}
              {rows.length - valid.length ? `, ${rows.length - valid.length} skipped` : ""}.
            </p>
            <div className="table-wrap import-preview">
              <table className="table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Auth</th>
                    {columns.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 50).map((r, i) => (
                    <tr key={i}>
                      <td className="mono">{r.tenant.client || "—"}</td>
                      <td>{r.tenant.authMode === "token" ? "Token" : r.tenant.password ? "Login" : "Login (no password)"}</td>
                      {columns.map((c) => (
                        <td key={c} className="mono">
                          {r.tenant.variables[c]}
                        </td>
                      ))}
                      <td>
                        {r.problems.length ? (
                          <span className="badge danger">{r.problems[0]}</span>
                        ) : existing.has(r.tenant.client) ? (
                          <span className="badge info">Update</span>
                        ) : (
                          <span className="badge success">New</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

export default function TenantsPage() {
  const { plan, env, updateEnv } = useWorkspace();
  const confirm = useConfirm();
  const [view, setView] = useState<View>("tenants");
  const [selected, setSelected] = useState(0);
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  if (!plan || !env) return null;
  const tenants = env.tenants;
  const index = Math.min(selected, Math.max(0, tenants.length - 1));
  const loginTenants = tenants.filter((t) => t.authMode !== "token").length;
  const running = inRun(env);
  const ready = running.filter((t) => {
    const p = tenantProblems(plan, env, t);
    return t.client && !p.auth && !p.missing.length;
  }).length;
  const rows = tenants
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => `${t.client} ${t.username}`.toLowerCase().includes(query.toLowerCase()));

  function add() {
    updateEnv((current) => ({ ...current, tenants: [...current.tenants, blankTenant()] }));
    setSelected(tenants.length);
  }
  async function remove() {
    const t = tenants[index];
    const ok = await confirm({
      title: `Remove ${t.client || "this tenant"}?`,
      description: `It is removed from ${env?.name} for every plan, with its saved password or token, when you save.`,
      confirmLabel: "Remove tenant",
      danger: true,
    });
    if (!ok) return;
    updateEnv((current) => ({ ...current, tenants: current.tenants.filter((_, i) => i !== index) }));
    setSelected(Math.max(0, index - 1));
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={view === "tenants"} onClick={() => setView("tenants")}>
            <Users size={14} /> Tenants <span className="faint num">{tenants.length}</span>
          </button>
          <button role="tab" aria-selected={view === "login"} onClick={() => setView("login")}>
            <LogIn size={14} /> Login request
          </button>
        </div>
        {view === "tenants" ? (
          <div className="page-actions">
            <span className="muted small num">
              <span className="env-tag">{env.name}</span> {running.length} of {tenants.length} in the run · {ready} ready
            </span>
            <button className="btn" onClick={() => setImporting(true)}>
              <FileUp /> Import CSV
            </button>
            <button className="btn primary" onClick={add}>
              <UserPlus /> Add tenant
            </button>
          </div>
        ) : (
          <span className="muted small">
            Used by {loginTenants} tenant{loginTenants === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {view === "login" ? (
        <LoginSetup plan={plan} env={env} />
      ) : !tenants.length ? (
        <div className="card">
          <Empty
            icon={<Users />}
            title={`No tenants in ${env.name} yet`}
            action={
              <div className="page-actions">
                <button className="btn" onClick={() => setImporting(true)}>
                  <FileUp /> Import CSV
                </button>
                <button className="btn primary" onClick={add}>
                  <UserPlus /> Add tenant
                </button>
              </div>
            }
          >
            Each tenant runs the same requests with its own token and IDs. Tenants belong to the environment, so every
            plan that runs against {env.name} uses them. Add them one by one or import a CSV.
          </Empty>
        </div>
      ) : (
        <div className="tenants-layout">
          <section className="card tenant-table">
            <div className="table-toolbar">
              <div className="collection-search">
                <Search />
                <input
                  className="input"
                  placeholder="Filter tenants"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Filter tenants"
                />
              </div>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th title="Include in runs">Run</th>
                    <th>Client</th>
                    <th>Auth</th>
                    <th>Username</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ t, i }) => (
                    <tr
                      key={i}
                      className={`clickable ${i === index ? "selected" : ""} ${t.enabled === false ? "off" : ""}`}
                      onClick={() => setSelected(i)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <Switch
                          checked={t.enabled !== false}
                          label={`Include ${t.client || "tenant"} in runs`}
                          onChange={(enabled) =>
                            updateEnv((c) => ({
                              ...c,
                              tenants: c.tenants.map((x, n) => (n === i ? { ...x, enabled } : x)),
                            }))
                          }
                        />
                      </td>
                      <td className="mono">{t.client || <span className="faint">unnamed</span>}</td>
                      <td>
                        <span className="muted">{t.authMode === "token" ? "Token" : "Login"}</span>
                      </td>
                      <td className="muted">{t.authMode === "token" ? "—" : t.username || "—"}</td>
                      <td>
                        <StatusBadge plan={plan} env={env} tenant={t} />
                      </td>
                    </tr>
                  ))}
                  {!rows.length ? (
                    <tr>
                      <td colSpan={5} className="empty">
                        No tenants match “{query}”.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
          <TenantEditor
            key={`${env.id}-${index}`}
            plan={plan}
            env={env}
            index={index}
            onRemove={() => void remove()}
          />
        </div>
      )}
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
    </div>
  );
}
