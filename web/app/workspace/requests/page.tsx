"use client";

import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Braces,
  Copy,
  Download,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Send,
  Trash2,
  Unplug,
} from "lucide-react";
import { useWorkspace } from "../../../components/workspace-provider";
import { Empty, Field, Menu, PairEditor, Switch, useConfirm } from "../../../components/ui";
import { ImportDialog } from "../../../components/import-dialog";
import { api } from "../../../lib/api";
import { blankRequest, builtins, isAbsolute, ownsUrl, requestVariables, uniqueName, unsafeMethods } from "../../../lib/plan";
import { bytes, ms } from "../../../lib/format";
import type { BodyType, Method, RequestSpec, TryResult } from "../../../lib/types";

const methods: Method[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
type Tab = "params" | "headers" | "body" | "auth";
const bodyTypes: { id: BodyType; label: string }[] = [
  { id: "none", label: "None" },
  { id: "json", label: "JSON" },
  { id: "text", label: "Text" },
  { id: "form", label: "Form" },
];

function pretty(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function ResponsePanel({ response, sending }: { response: TryResult | null; sending: boolean }) {
  if (sending)
    return (
      <div className="response-empty">
        <Loader2 className="spin" /> Sending…
      </div>
    );
  if (!response)
    return (
      <Empty icon={<Send />} title="No response yet">
        Pick a tenant and press Send to call this request once with that tenant’s token and variables.
      </Empty>
    );
  const ok = !response.error && response.status! >= 200 && response.status! < 300 && !response.successFalse;
  return (
    <div className="response-body">
      <div className="response-meta">
        <span className={`badge ${ok ? "success" : "danger"}`}>
          {response.error ? response.error : `${response.status}`}
        </span>
        {response.successFalse ? <span className="badge warning">success: false</span> : null}
        <span className="num muted">{ms(response.ms)}</span>
        {response.bytes != null ? <span className="num muted">{bytes(response.bytes)}</span> : null}
      </div>
      {response.url ? (
        <code className="response-url">
          <span className={`method ${response.method}`}>{response.method}</span> {response.url}
        </code>
      ) : null}
      <pre className="response-pre">{response.body ? pretty(response.body) : "Empty response body"}</pre>
    </div>
  );
}

export default function RequestsPage() {
  const { plan, env, updatePlan, updateEnv, setNotice } = useWorkspace();
  const confirm = useConfirm();
  const [selected, setSelected] = useState(0);
  const [tab, setTab] = useState<Tab>("params");
  const [query, setQuery] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [response, setResponse] = useState<TryResult | null>(null);
  const [sending, setSending] = useState(false);
  const [importing, setImporting] = useState(false);

  const knownVariables = useMemo(() => {
    const set = new Set(builtins);
    Object.keys(env?.variables || {}).forEach((k) => set.add(k));
    env?.tenants.forEach((t) => Object.keys(t.variables || {}).forEach((k) => set.add(k)));
    return set;
  }, [env]);

  if (!plan || !env) return null;
  const tenants = env.tenants;
  const index = Math.min(selected, plan.requests.length - 1);
  const request = plan.requests[index];
  const tenant = tenants.find((t) => t.client === tenantId) || tenants[0];
  const used = [...new Set(requestVariables(request))];
  const absolute = ownsUrl(request.path);
  const fromVariable = request.path.startsWith("{{");
  const unknown = used.filter((v) => !knownVariables.has(v));
  const filtered = plan.requests
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => `${r.name} ${r.path} ${r.method}`.toLowerCase().includes(query.toLowerCase()));

  function update(patch: Partial<RequestSpec>) {
    updatePlan((current) => ({
      ...current,
      requests: current.requests.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));
  }
  function select(i: number) {
    setSelected(i);
    setResponse(null);
  }
  function add() {
    if (!plan) return;
    const next = blankRequest(plan.requests.length + 1);
    next.name = uniqueName(next.name, plan.requests.map((r) => r.name));
    updatePlan((current) => ({ ...current, requests: [...current.requests, next] }));
    select(plan.requests.length);
    setTab("params");
  }
  function duplicate() {
    if (!plan) return;
    const copy = { ...structuredClone(request), name: uniqueName(`${request.name} copy`, plan.requests.map((r) => r.name)) };
    updatePlan((current) => ({
      ...current,
      requests: [...current.requests.slice(0, index + 1), copy, ...current.requests.slice(index + 1)],
    }));
    select(index + 1);
  }
  function move(delta: number) {
    const target = index + delta;
    if (!plan || target < 0 || target >= plan.requests.length) return;
    updatePlan((current) => {
      const list = [...current.requests];
      [list[index], list[target]] = [list[target], list[index]];
      return { ...current, requests: list };
    });
    setSelected(target);
  }
  async function remove() {
    if (!plan) return;
    if (plan.requests.length === 1) {
      setNotice({ type: "error", text: "Keep at least one request in the collection." });
      return;
    }
    const ok = await confirm({
      title: `Delete “${request.name}”?`,
      description: "It is removed from this plan when you save.",
      confirmLabel: "Delete request",
      danger: true,
    });
    if (!ok) return;
    updatePlan((current) => ({ ...current, requests: current.requests.filter((_, i) => i !== index) }));
    select(Math.max(0, index - 1));
  }
  function formatBody() {
    try {
      update({ body: JSON.stringify(JSON.parse(request.body), null, 2) });
    } catch {
      setNotice({ type: "error", text: "Body is not valid JSON yet, so it can’t be formatted." });
    }
  }
  async function send() {
    if (!plan || !env) return;
    if (!tenant) {
      setNotice({ type: "error", text: `Add a tenant to ${env.name} first. Send uses a tenant’s token and variables.` });
      return;
    }
    if (unsafeMethods.has(request.method)) {
      const ok = await confirm({
        title: `Send ${request.method} to ${env.baseUrl}?`,
        description: "This request can change data on the API.",
        confirmLabel: "Send request",
      });
      if (!ok) return;
    }
    setSending(true);
    setResponse(null);
    try {
      const strip = (pairs: RequestSpec["query"]) => pairs.filter((p) => p.key.trim());
      const result = await api<TryResult>("/try", {
        method: "POST",
        body: JSON.stringify({
          environmentId: env.id,
          baseUrl: env.baseUrl,
          variables: env.variables,
          settings: plan.settings,
          login: { ...plan.login, headers: strip(plan.login.headers), query: strip(plan.login.query), form: strip(plan.login.form) },
          tenant,
          request: { ...request, query: strip(request.query), headers: strip(request.headers), form: strip(request.form) },
          allowWrites: true,
        }),
      });
      setResponse(result);
    } catch (error) {
      setNotice({ type: "error", text: (error as Error).message });
    } finally {
      setSending(false);
    }
  }

  const counts = {
    params: request.query.filter((p) => p.key).length,
    headers: request.headers.filter((p) => p.key).length,
  };

  return (
    <div className="requests-page">
      <aside className="card collection">
        <div className="collection-head">
          <div>
            <h2>Collection</h2>
            <small className="muted">
              {plan.requests.filter((r) => r.enabled).length} of {plan.requests.length} in the run
            </small>
          </div>
          <div className="collection-actions">
            <button
              className="btn ghost icon sm"
              onClick={() => setImporting(true)}
              aria-label="Import requests"
              title="Import from cURL or Postman"
            >
              <Download />
            </button>
            <button className="btn icon sm" onClick={add} aria-label="Add request" title="Add request">
              <Plus />
            </button>
          </div>
        </div>
        <div className="base-url">
          <label htmlFor="base-url-edit" className="label">
            Base URL <span className="faint mono">{"{{baseUrl}}"}</span>
            <span className="env-tag" title="Set per environment">
              {env.name}
            </span>
          </label>
          <input
            id="base-url-edit"
            className="input mono"
            value={env.baseUrl}
            placeholder="http://localhost:8080"
            onChange={(e) => updateEnv((c) => ({ ...c, baseUrl: e.target.value }))}
          />
        </div>
        <div className="collection-search">
          <Search />
          <input
            className="input"
            placeholder="Filter requests"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Filter requests"
          />
        </div>
        <div className="collection-list">
          {filtered.map(({ r, i }) => (
            <div
              key={i}
              className={`collection-item ${i === index ? "active" : ""} ${r.enabled ? "" : "off"}`}
              onClick={() => select(i)}
            >
              <span className={`method ${r.method}`}>{r.method === "DELETE" ? "DEL" : r.method === "OPTIONS" ? "OPT" : r.method}</span>
              <span className="collection-text">
                <strong>{r.name}</strong>
                <small className="mono" title={r.path}>
                  {isAbsolute(r.path) ? r.path.replace(/^https?:\/\//i, "") : r.path}
                </small>
              </span>
              <span onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={r.enabled}
                  label={`Include ${r.name} in the run`}
                  onChange={(enabled) =>
                    updatePlan((current) => ({
                      ...current,
                      requests: current.requests.map((x, n) => (n === i ? { ...x, enabled } : x)),
                    }))
                  }
                />
              </span>
            </div>
          ))}
          {!filtered.length ? <p className="muted collection-none">No requests match “{query}”.</p> : null}
        </div>
      </aside>

      <section className="card editor">
        <div className="editor-head">
          <input
            className="title-input"
            value={request.name}
            aria-label="Request name"
            onChange={(e) => update({ name: e.target.value })}
          />
          <Menu
            trigger={(toggle) => (
              <button className="btn ghost icon sm" onClick={toggle} aria-label="Request actions">
                <MoreHorizontal />
              </button>
            )}
          >
            <button onClick={duplicate}>
              <Copy /> Duplicate
            </button>
            <button onClick={() => move(-1)} disabled={index === 0}>
              <ArrowUp /> Move up
            </button>
            <button onClick={() => move(1)} disabled={index === plan.requests.length - 1}>
              <ArrowDown /> Move down
            </button>
            <hr />
            <button className="danger" onClick={() => void remove()}>
              <Trash2 /> Delete
            </button>
          </Menu>
        </div>
        <div className="url-bar">
          <select
            className={`select method-select method ${request.method}`}
            aria-label="HTTP method"
            value={request.method}
            onChange={(e) => update({ method: e.target.value as Method })}
          >
            {methods.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <div className="url-input">
            {absolute ? null : (
              <span
                className="url-base mono"
                title={`Base URL of ${env.name}: ${env.baseUrl}. Type a full http(s):// URL to override it for this request.`}
              >
                {env.baseUrl.replace(/^https?:\/\//, "")}
              </span>
            )}
            <input
              className={`input mono ${absolute ? "absolute" : ""}`}
              aria-label="Request URL or path"
              value={request.path}
              placeholder="/orders/{{orderId}}  or  https://host/path"
              onChange={(e) => update({ path: e.target.value })}
            />
          </div>
          <button className="btn primary" onClick={() => void send()} disabled={sending}>
            {sending ? <Loader2 className="spin" /> : <Send />} Send
          </button>
        </div>
        {fromVariable ? (
          <p className="url-note">
            URL from a variable. <code>{"{{baseUrl}}"}</code> is <code>{env.baseUrl}</code> in {env.name}; any other variable must hold
            a full URL or host for each tenant.
          </p>
        ) : absolute ? (
          <p className="url-note">
            Full URL: this request ignores the base URL <code>{env.baseUrl}</code>. Start with <code>/</code> to use it
            again.
          </p>
        ) : null}
        {used.length ? (
          <div className="var-chips">
            <span className="faint">Uses</span>
            {used.map((v) => (
              <span
                key={v}
                className={`badge ${unknown.includes(v) ? "warning" : ""}`}
                title={unknown.includes(v) ? "No tenant defines this variable yet" : undefined}
              >
                {`{{${v}}}`}
              </span>
            ))}
          </div>
        ) : null}
        <div className="tabs" role="tablist">
          {(
            [
              ["params", "Params", counts.params],
              ["headers", "Headers", counts.headers],
              ["body", "Body", request.bodyType === "none" ? 0 : request.bodyType.toUpperCase()],
              ["auth", "Auth", 0],
            ] as const
          ).map(([id, label, count]) => (
            <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {label}
              {count ? <span className="count">{count}</span> : null}
            </button>
          ))}
        </div>
        <div className="editor-body">
          {tab === "params" ? (
            <PairEditor
              pairs={request.query}
              onChange={(query) => update({ query })}
              keyPlaceholder="page_size"
              addLabel="Add parameter"
            />
          ) : null}
          {tab === "headers" ? (
            <>
              <PairEditor
                pairs={request.headers}
                onChange={(headers) => update({ headers })}
                keyPlaceholder="X-Header"
                addLabel="Add header"
              />
              <p className="faint editor-note">Authorization, Host, Content-Length and Connection are set by the tool.</p>
            </>
          ) : null}
          {tab === "body" ? (
            <div className="body-editor">
              <div className="body-toolbar">
                <div className="segmented" role="tablist" aria-label="Body type">
                  {bodyTypes.map((b) => (
                    <button
                      key={b.id}
                      role="tab"
                      aria-selected={request.bodyType === b.id}
                      onClick={() => update({ bodyType: b.id })}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
                {request.bodyType === "json" ? (
                  <button className="btn ghost sm" onClick={formatBody}>
                    <Braces /> Format
                  </button>
                ) : null}
              </div>
              {request.bodyType === "form" ? (
                <PairEditor
                  pairs={request.form}
                  onChange={(form) => update({ form })}
                  keyPlaceholder="field"
                  addLabel="Add field"
                />
              ) : request.bodyType === "none" ? (
                <p className="muted editor-note">This request sends no body.</p>
              ) : (
                <textarea
                  className="textarea"
                  aria-label="Request body"
                  spellCheck={false}
                  value={request.body}
                  rows={14}
                  placeholder={request.bodyType === "json" ? '{\n  "orderId": "{{orderId}}"\n}' : "Raw text body"}
                  onChange={(e) => update({ body: e.target.value })}
                />
              )}
            </div>
          ) : null}
          {tab === "auth" ? (
            <div className="auth-tab">
              <Field label="Authorization" htmlFor="auth-mode">
                <select
                  id="auth-mode"
                  className="select"
                  value={request.authMode || "tenantBearer"}
                  onChange={(e) => update({ authMode: e.target.value as RequestSpec["authMode"] })}
                >
                  <option value="tenantBearer">Tenant bearer token</option>
                  <option value="none">No authorization</option>
                </select>
              </Field>
              <div className="callout info">
                <Unplug />
                <span>
                  With a tenant bearer token, every call sends <code>Authorization: Bearer {"{{token}}"}</code>. The token
                  comes from the tenant’s login (set up on the Tenants screen) or a token pasted there. You can also use{" "}
                  <code>{"{{token}}"}</code> in any header.
                </span>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section className="card response">
        <div className="card-head">
          <h2>Response</h2>
          <select
            className="select response-tenant"
            aria-label="Tenant for Send"
            value={tenant?.client || ""}
            onChange={(e) => setTenantId(e.target.value)}
            disabled={!tenants.length}
          >
            {tenants.length ? (
              tenants.map((t, i) => (
                <option key={i} value={t.client}>
                  {t.client || "Unnamed tenant"}
                </option>
              ))
            ) : (
              <option value="">No tenants in {env.name}</option>
            )}
          </select>
        </div>
        <ResponsePanel response={response} sending={sending} />
      </section>
      {importing ? <ImportDialog onClose={() => setImporting(false)} onImported={(i) => select(i)} /> : null}
    </div>
  );
}
