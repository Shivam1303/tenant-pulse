"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  BarChart3,
  Copy,
  FilePlus2,
  Gauge,
  Layers,
  Loader2,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Save,
  Square,
  Trash2,
  Users,
} from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { useLive } from "./live-provider";
import { Menu, Toast } from "./ui";
import { duration, ms, num, pct } from "../lib/format";

const nav = [
  { href: "/workspace/requests", label: "Requests", icon: Layers },
  { href: "/workspace/tenants", label: "Tenants", icon: Users },
  { href: "/workspace/run", label: "Run", icon: Gauge },
  { href: "/workspace/results", label: "Results", icon: BarChart3 },
];

function RunBar() {
  const { live, active, stop } = useLive();
  const { setNotice } = useWorkspace();
  if (!active) return null;
  const o = live.overall;
  const planned = live.plannedSeconds || 0;
  const elapsed = live.elapsedSeconds || 0;
  const progress = planned ? Math.min(100, (elapsed / planned) * 100) : 0;
  const last = live.series?.[live.series.length - 1];
  return (
    <div className="run-bar" role="status">
      <div className="run-bar-progress" style={{ width: `${live.state === "preflight" ? 0 : progress}%` }} />
      <span className={`dot ${live.state}`} />
      <strong>
        {live.state === "preflight"
          ? `Preflight ${live.preflight?.done || 0}/${live.preflight?.total || 0}`
          : live.state === "stopping"
            ? "Stopping…"
            : "Running"}
      </strong>
      <span className="run-bar-plan">{live.planName}</span>
      {live.state !== "preflight" ? (
        <div className="run-bar-stats num">
          <span>
            {duration(elapsed)} <em>/ {duration(planned)}</em>
          </span>
          <span>
            {num(last?.rate)} <em>req/s</em>
          </span>
          <span>
            {ms(o?.p95Ms)} <em>p95</em>
          </span>
          <span className={o?.failed ? "danger-text" : ""}>
            {pct(o?.failed || 0, o?.total || 0)} <em>errors</em>
          </span>
          <span>
            {live.activeVUs}/{live.targetVUs} <em>VUs</em>
          </span>
        </div>
      ) : null}
      <div className="run-bar-actions">
        {live.state !== "preflight" ? (
          <Link href="/workspace/results" className="btn ghost sm">
            <Activity /> Live view
          </Link>
        ) : null}
        <button
          className="btn danger sm"
          disabled={live.state === "stopping"}
          onClick={() => stop().catch((e) => setNotice({ type: "error", text: (e as Error).message }))}
        >
          <Square /> Stop
        </button>
      </div>
    </div>
  );
}

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { plans, plan, loading, dirty, saving, notice, setNotice, load, save, createBlank, duplicate, remove } =
    useWorkspace();
  const [collapsed, setCollapsed] = useState(false);
  const [saveKey, setSaveKey] = useState("Ctrl S");
  const closeNotice = useCallback(() => setNotice(null), [setNotice]);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("tenant-pulse-sidebar") === "collapsed");
    } catch {}
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setSaveKey("⌘S");
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save().catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  function toggleSidebar() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem("tenant-pulse-sidebar", next ? "collapsed" : "open");
    } catch {}
  }

  return (
    <div className={`app-shell ${collapsed ? "collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Activity />
          </span>
          <span className="brand-name">Tenant Pulse</span>
        </div>
        <nav aria-label="Workspace">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={`nav-link ${pathname === href ? "active" : ""}`}
              title={collapsed ? label : undefined}
            >
              <Icon />
              <span>{label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="local-note" title="The app and API bind to 127.0.0.1 only">
            <span className="dot finished" />
            <span>Local only</span>
          </div>
          <button
            className="btn ghost icon sm"
            onClick={toggleSidebar}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
        </div>
      </aside>
      <div className="content">
        <header className="topbar">
          <div className="plan-picker">
            <label htmlFor="global-plan" className="sr-only">
              Plan
            </label>
            <select
              id="global-plan"
              className="select"
              value={plan?.id || ""}
              onChange={(event) => void load(event.target.value)}
              disabled={loading}
            >
              {plans.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
              {plan && !plans.some((item) => item.id === plan.id) ? (
                <option value={plan.id}>{plan.name} (unsaved)</option>
              ) : null}
            </select>
            {dirty ? (
              <span className="unsaved" title="Unsaved changes">
                <span className="dot stopping" /> Unsaved
              </span>
            ) : null}
          </div>
          <div className="topbar-actions">
            <button className="btn primary" onClick={() => save().catch(() => {})} disabled={!plan || saving || !dirty}>
              {saving ? <Loader2 className="spin" /> : <Save />}
              Save <span className="kbd">{saveKey}</span>
            </button>
            <Menu
              trigger={(toggle) => (
                <button className="btn icon" aria-label="Plan actions" onClick={toggle} disabled={!plan}>
                  <MoreHorizontal />
                </button>
              )}
            >
              <button role="menuitem" onClick={() => void createBlank()}>
                <FilePlus2 /> New blank plan
              </button>
              <button role="menuitem" onClick={() => void duplicate()}>
                <Copy /> Duplicate plan
              </button>
              {plan?.id !== "default" ? (
                <>
                  <hr />
                  <button role="menuitem" className="danger" onClick={() => void remove()}>
                    <Trash2 /> Delete plan
                  </button>
                </>
              ) : null}
            </Menu>
          </div>
        </header>
        <RunBar />
        <main className="main">
          {loading || !plan ? (
            <div className="loading">
              <Loader2 className="spin" /> Loading workspace…
            </div>
          ) : (
            children
          )}
        </main>
      </div>
      <Toast notice={notice} onClose={closeNotice} />
    </div>
  );
}
