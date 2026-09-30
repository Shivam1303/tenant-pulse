"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, ChevronRight, Database, Loader2, Play, Plus, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { useWorkspace } from "../../../components/workspace-provider";
import { useLive } from "../../../components/live-provider";
import { Field } from "../../../components/ui";
import { api } from "../../../lib/api";
import { duration, num } from "../../../lib/format";
import { MAX_RUN_SECONDS, MAX_VUS, inRun, tenantProblems, unsafeMethods } from "../../../lib/plan";
import type { MysqlHost, Plan, PreflightRow, Settings, Thresholds } from "../../../lib/types";

function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  unit,
  placeholder,
  step,
}: {
  step?: number;
  id: string;
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  min: number;
  max: number;
  unit?: string;
  placeholder?: string;
}) {
  const input = (
    <input
      id={id}
      className="input num"
      type="number"
      min={min}
      max={max}
      step={step}
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
    />
  );
  return unit ? (
    <div className="suffix-input">
      {input}
      <span>{unit}</span>
    </div>
  ) : (
    input
  );
}

// Ramp-up and hold shape of the planned load.
function LoadShape({ vus, ramp, hold }: { vus: number; ramp: number; hold: number }) {
  const total = Math.max(1, ramp + hold);
  const rx = (ramp / total) * 100;
  return (
    <div className="load-shape">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="shape" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`M0 40 L${rx} 14 L100 14 L100 40 Z`} fill="url(#shape)" />
        <path d={`M0 40 L${rx} 14 L100 14`} fill="none" stroke="var(--accent)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="load-shape-labels num">
        <span>0s</span>
        {ramp ? <span style={{ left: `${rx}%` }}>{duration(ramp)}</span> : null}
        <span>{duration(total)}</span>
      </div>
      <div className="load-shape-peak num">{vus} VUs</div>
    </div>
  );
}

function PreflightTable({ rows, title }: { rows: PreflightRow[]; title: string }) {
  const failed = rows.filter((r) => !r.ok);
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          <p>{failed.length ? "Fix these, then start again. Nothing ran under load." : "Every tenant logged in and every request answered."}</p>
        </div>
        <span className={`badge ${failed.length ? "danger" : "success"}`}>
          {failed.length ? `${failed.length} failed` : `${rows.length} passed`}
        </span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Tenant</th>
              <th>Check</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {(failed.length ? failed : rows).map((row, i) => (
              <tr key={i}>
                <td className="mono">{row.tenant}</td>
                <td>{row.request}</td>
                <td className={row.ok ? "success-text" : "danger-text"}>
                  {row.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />} {row.detail}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// Choose which tenants take part; the rest stay in the plan, switched off.
function TenantPicker({ plan }: { plan: Plan }) {
  const { updatePlan } = useWorkspace();
  const setAll = (enabled: boolean) =>
    updatePlan((c) => ({ ...c, tenants: c.tenants.map((t) => ({ ...t, enabled })) }));
  const toggle = (index: number) =>
    updatePlan((c) => ({
      ...c,
      tenants: c.tenants.map((t, i) => (i === index ? { ...t, enabled: t.enabled === false } : t)),
    }));
  const on = inRun(plan).length;
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Tenants</h2>
          <p>
            {on} of {plan.tenants.length} in this run. Switched-off tenants are kept but skipped.
          </p>
        </div>
        {plan.tenants.length ? (
          <div className="page-actions">
            <button className="btn ghost sm" onClick={() => setAll(true)} disabled={on === plan.tenants.length}>
              All
            </button>
            <button className="btn ghost sm" onClick={() => setAll(false)} disabled={!on}>
              None
            </button>
          </div>
        ) : null}
      </div>
      <div className="card-body">
        {plan.tenants.length ? (
          <div className="tenant-chips">
            {plan.tenants.map((t, i) => {
              const p = tenantProblems(plan, t);
              const ready = t.client && !p.auth && !p.missing.length;
              const onRun = t.enabled !== false;
              return (
                <label key={i} className={`tenant-chip ${onRun ? "on" : ""}`} title={ready ? undefined : "Not ready: see Tenants"}>
                  <input type="checkbox" checked={onRun} onChange={() => toggle(i)} />
                  <span className="mono">{t.client || "unnamed"}</span>
                  {!ready ? <AlertTriangle className="warning-text" /> : null}
                </label>
              );
            })}
          </div>
        ) : (
          <p className="muted small">No tenants yet. Add them on the Tenants screen.</p>
        )}
      </div>
    </section>
  );
}

function MysqlHosts({ plan }: { plan: Plan }) {
  const { updatePlan } = useWorkspace();
  const set = (index: number, patch: Partial<MysqlHost>) =>
    updatePlan((current) => ({
      ...current,
      mysql: current.mysql.map((m, i) => (i === index ? { ...m, ...patch } : m)),
    }));
  return (
    <div className="stack">
      {plan.mysql.map((host, i) => (
        <div className="mysql-host" key={i}>
          <div className="form-grid three">
            <Field label="Label">
              <input className="input" value={host.id} onChange={(e) => set(i, { id: e.target.value })} />
            </Field>
            <Field label="Host">
              <input className="input mono" value={host.host} onChange={(e) => set(i, { host: e.target.value })} />
            </Field>
            <Field label="Port">
              <input
                className="input num"
                type="number"
                value={host.port}
                onChange={(e) => set(i, { port: Number(e.target.value) })}
              />
            </Field>
            <Field label="Read-only user">
              <input className="input" value={host.user} onChange={(e) => set(i, { user: e.target.value })} />
            </Field>
            <Field label="Password" hint={host.hasPassword ? "Saved. Leave blank to keep." : undefined}>
              <input
                className="input"
                type="password"
                value={host.password || ""}
                placeholder={host.hasPassword ? "••••••••  saved" : "Optional"}
                onChange={(e) => set(i, { password: e.target.value })}
              />
            </Field>
            <div className="mysql-remove">
              <button
                className="btn ghost sm"
                onClick={() => updatePlan((c) => ({ ...c, mysql: c.mysql.filter((_, n) => n !== i) }))}
              >
                <Trash2 /> Remove
              </button>
            </div>
          </div>
        </div>
      ))}
      <div>
        <button
          className="btn sm"
          onClick={() =>
            updatePlan((c) => ({
              ...c,
              mysql: [...c.mysql, { id: `db-${c.mysql.length + 1}`, host: "127.0.0.1", port: 3306, user: "monitor" }],
            }))
          }
        >
          <Plus /> Add MySQL host
        </button>
      </div>
    </div>
  );
}

export default function RunPage() {
  const { plan, updatePlan, save, dirty, setNotice } = useWorkspace();
  const { live, active, refresh } = useLive();
  const router = useRouter();
  const [busy, setBusy] = useState<"check" | "start" | null>(null);
  const [allowWrites, setAllowWrites] = useState(false);
  const [checkRows, setCheckRows] = useState<PreflightRow[] | null>(null);
  const startedId = useRef<string | null>(null);

  // After Start: go to Results once the load begins; stay here on failure.
  useEffect(() => {
    if (!startedId.current || live.id !== startedId.current) return;
    if (live.state === "running") {
      startedId.current = null;
      router.push("/workspace/results");
    } else if (live.state === "failed") {
      startedId.current = null;
      setBusy(null);
    }
  }, [live, router]);

  if (!plan) return null;
  const s = plan.settings;
  const t = plan.thresholds;
  const running = inRun(plan);
  const totalVUs = running.length * Number(s.vusPerTenant || 0);
  const ramp = s.rampUpSeconds || 0;
  const total = ramp + (s.durationSeconds || 0);
  const durationError =
    total > MAX_RUN_SECONDS
      ? `A run can last at most ${MAX_RUN_SECONDS / 60} minutes.`
      : ramp >= total
        ? "Ramp-up must be shorter than the total duration."
        : null;
  const enabled = plan.requests.filter((r) => r.enabled);
  const hasWrites = enabled.some((r) => unsafeMethods.has(r.method));
  const overLimit = totalVUs > MAX_VUS;
  const failedRun = live.state === "failed" && live.planId === plan.id ? live : null;
  const preflighting = live.state === "preflight";

  const setting = (key: keyof Settings, value: number | boolean | null) =>
    updatePlan((c) => ({ ...c, settings: { ...c.settings, [key]: value } }));
  // The total is what people set; the hold is whatever remains after ramp-up.
  const setTotal = (seconds: number) =>
    updatePlan((c) => ({
      ...c,
      settings: {
        ...c.settings,
        durationSeconds: Math.max(1, Math.min(MAX_RUN_SECONDS, seconds) - (c.settings.rampUpSeconds || 0)),
      },
    }));
  const setRamp = (seconds: number) =>
    updatePlan((c) => {
      const total = (c.settings.rampUpSeconds || 0) + c.settings.durationSeconds;
      const rampUpSeconds = Math.max(0, Math.min(seconds, total - 1));
      return { ...c, settings: { ...c.settings, rampUpSeconds, durationSeconds: total - rampUpSeconds } };
    });
  const threshold = (key: keyof Thresholds, value: number | null) =>
    updatePlan((c) => ({ ...c, thresholds: { ...c.thresholds, [key]: value } }));

  async function savedPlan() {
    return dirty ? await save() : plan;
  }
  async function check() {
    setBusy("check");
    setCheckRows(null);
    try {
      const saved = await savedPlan();
      if (!saved) return;
      const result = await api<{ ok: boolean; rows: PreflightRow[] }>("/preflight", {
        method: "POST",
        body: JSON.stringify({ planId: saved.id, allowWrites }),
      });
      setCheckRows(result.rows);
      setNotice({ type: result.ok ? "success" : "error", text: result.ok ? "All checks passed." : "Some checks failed." });
    } catch (error) {
      setNotice({ type: "error", text: (error as Error).message });
    } finally {
      setBusy(null);
    }
  }
  async function start() {
    setBusy("start");
    setCheckRows(null);
    try {
      const saved = await savedPlan();
      if (!saved) {
        setBusy(null);
        return;
      }
      const { id } = await api<{ id: string }>("/run", {
        method: "POST",
        body: JSON.stringify({ planId: saved.id, allowWrites }),
      });
      startedId.current = id;
      await refresh();
    } catch (error) {
      setNotice({ type: "error", text: (error as Error).message });
      setBusy(null);
    }
  }

  const blocked = active || !!busy || !running.length || overLimit || !!durationError || (hasWrites && !allowWrites);

  return (
    <div className="page run-page">
      <div className="run-grid">
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div>
                <h2>Target</h2>
                <p>The API every tenant calls, and how reports are named.</p>
              </div>
            </div>
            <div className="card-body form-grid">
              <Field label="API base URL" htmlFor="base-url" className="full" hint="Origin only, e.g. https://api.example.com">
                <input
                  id="base-url"
                  className="input mono"
                  value={plan.baseUrl}
                  onChange={(e) => updatePlan((c) => ({ ...c, baseUrl: e.target.value }))}
                />
              </Field>
              <Field label="Plan name" htmlFor="plan-name">
                <input
                  id="plan-name"
                  className="input"
                  value={plan.name}
                  onChange={(e) => updatePlan((c) => ({ ...c, name: e.target.value }))}
                />
              </Field>
              <Field label="Run label" htmlFor="run-label" hint="Shown on saved reports, e.g. “after index fix”">
                <input
                  id="run-label"
                  className="input"
                  value={plan.label || ""}
                  placeholder="Optional"
                  onChange={(e) => updatePlan((c) => ({ ...c, label: e.target.value }))}
                />
              </Field>
            </div>
          </section>

          <TenantPicker plan={plan} />

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Load profile</h2>
                <p>Each virtual user (VU) acts like one person: call a request, pause, call the next.</p>
              </div>
              <span className={`badge ${overLimit ? "danger" : "accent"} num`}>
                {running.length} tenants × {s.vusPerTenant || 0} = {totalVUs} VUs
              </span>
            </div>
            <div className="card-body stack">
              <LoadShape vus={totalVUs} ramp={ramp} hold={Math.max(0, total - ramp)} />
              <div className="form-grid three">
                <Field
                  label="Total duration"
                  htmlFor="total"
                  className="full"
                  error={durationError}
                  hint={`${duration(total)} in total: ${duration(ramp)} ramp-up, then ${duration(Math.max(0, total - ramp))} at full load. Up to ${MAX_RUN_SECONDS / 60} minutes.`}
                >
                  <div className="duration-row">
                    <NumberInput
                      id="total"
                      value={Math.round((total / 60) * 100) / 100}
                      min={0.1}
                      max={MAX_RUN_SECONDS / 60}
                      step={0.5}
                      unit="min"
                      onChange={(v) => setTotal(Math.round((v ?? 1) * 60))}
                    />
                    <div className="segmented" role="group" aria-label="Duration presets">
                      {[1, 2, 5, 10].map((m) => (
                        <button key={m} aria-selected={total === m * 60} onClick={() => setTotal(m * 60)}>
                          {m}m
                        </button>
                      ))}
                    </div>
                  </div>
                </Field>
                <Field label="VUs per tenant" htmlFor="vus" error={overLimit ? `Over the ${MAX_VUS} VU safety limit` : null}>
                  <NumberInput id="vus" value={s.vusPerTenant} min={1} max={MAX_VUS} onChange={(v) => setting("vusPerTenant", v ?? 1)} />
                </Field>
                <Field label="Ramp-up" htmlFor="ramp" hint="Part of the total; VUs start evenly">
                  <NumberInput
                    id="ramp"
                    value={s.rampUpSeconds}
                    min={0}
                    max={MAX_RUN_SECONDS - 1}
                    unit="s"
                    onChange={(v) => setRamp(v ?? 0)}
                  />
                </Field>
                <Field label="Think time" htmlFor="pacing" hint="Average pause after each call, varies ±50%">
                  <NumberInput id="pacing" value={s.pacingMs} min={0} max={60000} unit="ms" onChange={(v) => setting("pacingMs", v ?? 0)} />
                </Field>
                <Field label="Request timeout" htmlFor="timeout">
                  <NumberInput id="timeout" value={s.timeoutMs} min={100} max={120000} unit="ms" onChange={(v) => setting("timeoutMs", v ?? 15000)} />
                </Field>
              </div>
              {s.pacingMs ? (
                <p className="muted small">
                  At most about <strong className="num">{num((totalVUs * 1000) / s.pacingMs)} requests/sec</strong> ({totalVUs}{" "}
                  VUs ÷ {num(s.pacingMs / 1000, 2)} s think time), less once response time is added.
                </p>
              ) : (
                <div className="callout warning">
                  <AlertTriangle />
                  <span>
                    No think time: every VU fires its next call the moment the last one returns, so {totalVUs} VUs can mean
                    thousands of requests per second. Real users pause. Try 1,000–3,000 ms.
                  </span>
                </div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Pass criteria</h2>
                <p>Every report gets a PASS or FAIL verdict against these. Leave blank to skip.</p>
              </div>
            </div>
            <div className="card-body stack">
              <div className="form-grid">
                <Field label="p95 latency at most" htmlFor="t-p95">
                  <NumberInput id="t-p95" value={t.p95Ms} min={1} max={120000} unit="ms" placeholder="No limit" onChange={(v) => threshold("p95Ms", v)} />
                </Field>
                <Field label="Error rate at most" htmlFor="t-err">
                  <NumberInput id="t-err" value={t.errorRatePct} min={0} max={100} unit="%" placeholder="No limit" onChange={(v) => threshold("errorRatePct", v)} />
                </Field>
              </div>
              <label className="check-line">
                <input
                  type="checkbox"
                  checked={s.checkSuccessField !== false}
                  onChange={(e) => setting("checkSuccessField", e.target.checked)}
                />
                <span>
                  Count <code>{'"success": false'}</code> in a JSON response as a failure, even with HTTP 2xx.
                  <small className="faint block">Turn off for APIs without this field; it saves parsing every response.</small>
                </span>
              </label>
            </div>
          </section>

          <details className="card advanced">
            <summary>
              <ChevronRight className="chev" />
              <Database size={15} />
              <span>
                <strong>MySQL observation</strong>
                <small className="muted">
                  {plan.mysql.length ? `${plan.mysql.length} host${plan.mysql.length === 1 ? "" : "s"}` : "Optional · not measured"}
                </small>
              </span>
            </summary>
            <div className="card-body stack">
              <p className="muted small">
                Samples connected and running threads once per second through the installed <code>mysql</code> client.
                Use a user that can read global status.
              </p>
              <MysqlHosts plan={plan} />
            </div>
          </details>
        </div>

        <aside className="run-side">
          <section className="card run-summary">
            <div className="card-body stack">
              <div className="summary-rows num">
                <div>
                  <span>Tenants in the run</span>
                  <strong>
                    {running.length}
                    {running.length !== plan.tenants.length ? <span className="faint"> of {plan.tenants.length}</span> : null}
                  </strong>
                </div>
                <div>
                  <span>Requests in the run</span>
                  <strong>{enabled.length}</strong>
                </div>
                <div>
                  <span>Peak VUs</span>
                  <strong className={overLimit ? "danger-text" : ""}>{totalVUs}</strong>
                </div>
                <div>
                  <span>Total time</span>
                  <strong>{duration(total)}</strong>
                </div>
              </div>
              {!running.length ? (
                <div className="callout warning">
                  <AlertTriangle /> {plan.tenants.length ? "Switch on at least one tenant." : "Add at least one tenant first."}
                </div>
              ) : null}
              {hasWrites ? (
                <label className="check-line write-confirm">
                  <input type="checkbox" checked={allowWrites} onChange={(e) => setAllowWrites(e.target.checked)} />
                  <span>
                    I understand the enabled {enabled.filter((r) => unsafeMethods.has(r.method)).map((r) => r.method).join("/")}{" "}
                    requests can change data on <code>{plan.baseUrl}</code>.
                  </span>
                </label>
              ) : null}
              <button className="btn primary lg" disabled={blocked} onClick={() => void start()}>
                {busy === "start" || preflighting ? <Loader2 className="spin" /> : <Play />}
                {preflighting
                  ? `Checking ${live.preflight?.done || 0}/${live.preflight?.total || 0}…`
                  : active
                    ? "A run is in progress"
                    : dirty
                      ? "Save & start run"
                      : "Start run"}
              </button>
              <button className="btn" disabled={blocked} onClick={() => void check()}>
                {busy === "check" ? <Loader2 className="spin" /> : <ShieldCheck />} Check only
              </button>
              <p className="faint small">
                Start logs in every tenant and calls each request once. If anything fails, the load does not start.
              </p>
            </div>
          </section>
        </aside>
      </div>
      {failedRun?.preflight?.failures.length ? (
        <PreflightTable rows={failedRun.preflight.failures} title="Preflight failed" />
      ) : failedRun?.error ? (
        <div className="callout danger">
          <XCircle /> {failedRun.error}
        </div>
      ) : null}
      {checkRows ? <PreflightTable rows={checkRows} title="Check results" /> : null}
    </div>
  );
}
