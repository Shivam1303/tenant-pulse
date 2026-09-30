"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Copy, Download, Globe, MoreHorizontal, Plus, Trash2, Users, X } from "lucide-react";
import { useWorkspace } from "../../../components/workspace-provider";
import { ImportDialog } from "../../../components/import-dialog";
import { Empty, Field, Menu } from "../../../components/ui";
import { builtins, requiredVariables, uniqueName } from "../../../lib/plan";
import type { Environment } from "../../../lib/types";

// Shared variables: name → value, used by every tenant that has no value of its own.
function VariableMap({ env, needed }: { env: Environment; needed: string[] }) {
  const { updateEnv, setNotice } = useWorkspace();
  const vars = env.variables || {};
  const set = (variables: Record<string, string>) => updateEnv((c) => ({ ...c, variables }), env.id);
  function rename(from: string, to: string) {
    if (!to || to === from) return;
    if (builtins.has(to) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(to)) {
      setNotice({ type: "error", text: `“${to}” can’t be a variable name.` });
      return;
    }
    if (to in vars) {
      setNotice({ type: "error", text: `{{${to}}} already exists.` });
      return;
    }
    set(Object.fromEntries(Object.entries(vars).map(([k, v]) => [k === from ? to : k, v])));
  }
  function add(name = "") {
    let key = name || "variable";
    for (let n = 1; key in vars; n++) key = `${name || "variable"}${n}`;
    set({ ...vars, [key]: "" });
  }
  const missing = needed.filter((k) => !(k in vars));
  return (
    <div className="stack">
      <div className="var-list">
        {Object.entries(vars).map(([k, v]) => (
          <div className="var-row" key={k}>
            <input
              className="input mono"
              aria-label="Variable name"
              defaultValue={k}
              key={k}
              onBlur={(e) => rename(k, e.target.value.trim())}
            />
            <input
              className="input mono"
              aria-label={`${k} value`}
              value={v}
              placeholder="Value for every tenant"
              onChange={(e) => set({ ...vars, [k]: e.target.value })}
            />
            <button
              className="btn ghost icon sm"
              aria-label={`Remove ${k}`}
              onClick={() => set(Object.fromEntries(Object.entries(vars).filter(([x]) => x !== k)))}
            >
              <X />
            </button>
          </div>
        ))}
        {!Object.keys(vars).length ? (
          <p className="muted small">
            No shared variables. Values that are the same for every tenant here, such as <code>{"{{departmentId}}"}</code>,
            can live here instead of on each tenant.
          </p>
        ) : null}
      </div>
      <div className="var-suggest">
        <button className="btn ghost sm" onClick={() => add()}>
          <Plus /> Add variable
        </button>
        {missing.length ? (
          <>
            <span className="faint small">Used by requests:</span>
            {missing.map((k) => (
              <button key={k} className="badge clickable" onClick={() => add(k)} title={`Add {{${k}}} as a shared variable`}>
                + {`{{${k}}}`}
              </button>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

function EnvironmentEditor({ env }: { env: Environment }) {
  const { plan, updateEnv, selectEnvironment, duplicateEnvironment, removeEnvironment, dirtyEnvironments } = useWorkspace();
  if (!plan) return null;
  const active = plan.environmentId === env.id;
  const need = requiredVariables(plan);
  const needed = [...new Set([...need.requests, ...need.login])];
  const usedBy = (env.plans || []).filter((p) => p.id !== plan.id);
  const update = (patch: Partial<Environment>) => updateEnv((c) => ({ ...c, ...patch }), env.id);
  return (
    <section className="card env-editor">
      <div className="card-head">
        <div>
          <h2>{env.name || "Unnamed environment"}</h2>
          <p>
            {active ? "This plan runs against it." : "Not used by this plan."}
            {usedBy.length ? ` Also used by ${usedBy.map((p) => p.name).join(", ")}.` : ""}
          </p>
        </div>
        <div className="page-actions">
          {!active ? (
            <button className="btn sm" onClick={() => selectEnvironment(env.id)}>
              <CheckCircle2 /> Use for this plan
            </button>
          ) : null}
          <Menu
            trigger={(toggle) => (
              <button className="btn ghost icon sm" onClick={toggle} aria-label="Environment actions">
                <MoreHorizontal />
              </button>
            )}
          >
            <button onClick={() => void duplicateEnvironment(env.id)} disabled={dirtyEnvironments.includes(env.id)}>
              <Copy /> Duplicate with tenants
            </button>
            <hr />
            <button className="danger" onClick={() => void removeEnvironment(env.id)}>
              <Trash2 /> Delete
            </button>
          </Menu>
        </div>
      </div>
      <div className="card-body stack">
        <div className="form-grid">
          <Field label="Name" htmlFor="env-name">
            <input
              id="env-name"
              className="input"
              value={env.name}
              placeholder="Staging"
              onChange={(e) => update({ name: e.target.value })}
            />
          </Field>
          <Field label="Base URL" htmlFor="env-url" hint="Origin only; requests use it as {{baseUrl}}">
            <input
              id="env-url"
              className="input mono"
              value={env.baseUrl}
              placeholder="https://staging.example.com"
              onChange={(e) => update({ baseUrl: e.target.value })}
            />
          </Field>
        </div>
        <div className="section-title">
          <h3>Shared variables</h3>
          <span className="faint small">A tenant’s own value wins</span>
        </div>
        <VariableMap env={env} needed={needed} />
        <div className="section-title">
          <h3>Tenants</h3>
          <span className="faint small num">{env.tenants.length}</span>
        </div>
        <div className="env-tenants">
          {env.tenants.length ? (
            <div className="tenant-chips">
              {env.tenants.slice(0, 24).map((t, i) => (
                <span key={i} className={`tenant-chip ${t.enabled !== false ? "on" : ""}`}>
                  <span className="mono">{t.client || "unnamed"}</span>
                </span>
              ))}
              {env.tenants.length > 24 ? <span className="faint small">+{env.tenants.length - 24} more</span> : null}
            </div>
          ) : (
            <p className="muted small">No tenants yet.</p>
          )}
          {active ? (
            <Link href="/workspace/tenants" className="btn sm">
              <Users /> Edit tenants
            </Link>
          ) : (
            <p className="faint small">Use this environment for the plan to edit its tenants on the Tenants screen.</p>
          )}
        </div>
      </div>
    </section>
  );
}

export default function EnvironmentsPage() {
  const { plan, env, environments, addEnvironment, dirtyEnvironments } = useWorkspace();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  if (!plan || !env) return null;
  const selected = environments.find((e) => e.id === selectedId) || env;

  function create() {
    const id = `env-${Date.now()}`;
    addEnvironment({
      id,
      name: uniqueName("New environment", environments.map((e) => e.name)),
      baseUrl: env!.baseUrl,
      variables: {},
      tenants: [],
    });
    setSelectedId(id);
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">Environments</h1>
          <p className="muted small">
            Each environment is a system you test: its base URL, shared variables and its own tenants. Switch with the
            picker at the top.
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" onClick={() => setImporting(true)} title="Import a Postman environment export">
            <Download /> Import Postman
          </button>
          <button className="btn primary" onClick={create}>
            <Plus /> New environment
          </button>
        </div>
      </div>
      {!environments.length ? (
        <div className="card">
          <Empty icon={<Globe />} title="No environments">
            Create one to set a base URL and tenants.
          </Empty>
        </div>
      ) : (
        <div className="env-layout">
          <section className="card env-list">
            {environments.map((e) => (
              <button
                key={e.id}
                className={`env-item ${e.id === selected.id ? "active" : ""}`}
                onClick={() => setSelectedId(e.id)}
              >
                <span className="env-item-text">
                  <strong>
                    {e.name || "Unnamed"}
                    {dirtyEnvironments.includes(e.id) ? <span className="dot stopping" title="Unsaved changes" /> : null}
                  </strong>
                  <small className="mono">{e.baseUrl.replace(/^https?:\/\//, "")}</small>
                </span>
                <span className="env-item-meta">
                  {e.id === plan.environmentId ? <span className="badge accent">This plan</span> : null}
                  <span className="faint small num">
                    {e.tenants.length} tenant{e.tenants.length === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
            ))}
          </section>
          <EnvironmentEditor key={selected.id} env={selected} />
        </div>
      )}
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
    </div>
  );
}
