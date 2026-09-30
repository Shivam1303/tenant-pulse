"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowLeftRight,
  BarChart3,
  CheckCircle2,
  Download,
  Gauge,
  Search,
  Trash2,
  TrendingUp,
  XCircle,
} from "lucide-react";
import { Chart } from "../../../components/chart";
import type { ChartSeries } from "../../../components/chart";
import { useLive } from "../../../components/live-provider";
import { useWorkspace } from "../../../components/workspace-provider";
import { Empty, useConfirm } from "../../../components/ui";
import { api } from "../../../lib/api";
import { dateTime, duration, ms, num, pct } from "../../../lib/format";
import type { Live, MysqlPoint, Report, ReportSummary, SeriesPoint, Stats, Verdict } from "../../../lib/types";

// Above this generator event-loop lag (p99 per second), results are skewed.
const LAG_WARN_MS = 50;

type RunData = Pick<Live, "overall" | "byTenant" | "byRequest" | "series" | "mysqlSeries" | "events" | "verdict"> & {
  elapsedSeconds?: number;
};

const errorKinds: { key: string; label: string; color: string }[] = [
  { key: "timeout", label: "Timeouts", color: "var(--warning)" },
  { key: "connection", label: "Connection", color: "var(--chart-5)" },
  { key: "network", label: "Network", color: "var(--teal)" },
  { key: "unauthorized", label: "401/403", color: "var(--chart-1)" },
  { key: "rateLimited", label: "429", color: "#c58af0" },
  { key: "server", label: "5xx", color: "var(--danger)" },
  { key: "apiFailure", label: "success: false", color: "#9aa3b5" },
];

function VerdictBadge({ verdict }: { verdict?: Verdict }) {
  if (!verdict) return null;
  return verdict.pass ? (
    <span className="badge success">
      <CheckCircle2 /> PASS
    </span>
  ) : (
    <span className="badge danger">
      <XCircle /> FAIL
    </span>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={`kpi ${tone || ""}`}>
      <span>{label}</span>
      <strong className="num">{value}</strong>
      {sub ? <small className="num">{sub}</small> : null}
    </div>
  );
}

function ErrorBreakdown({ stats }: { stats: Stats }) {
  const parts = errorKinds.map((k) => ({ ...k, count: stats.errors?.[k.key] || 0 })).filter((p) => p.count);
  const statuses = Object.entries(stats.statuses || {}).sort((a, b) => b[1] - a[1]);
  const total = parts.reduce((n, p) => n + p.count, 0);
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Failures</h2>
          <p>
            {stats.failed ? `${num(stats.failed)} of ${num(stats.total)} calls failed` : "No failed calls"}
          </p>
        </div>
        <span className={`badge ${stats.failed ? "danger" : "success"} num`}>{pct(stats.failed, stats.total)}</span>
      </div>
      <div className="card-body stack">
        {total ? (
          <>
            <div className="error-bar">
              {parts.map((p) => (
                <span key={p.key} style={{ flex: p.count, background: p.color }} title={`${p.label}: ${p.count}`} />
              ))}
            </div>
            <div className="error-legend">
              {parts.map((p) => (
                <span key={p.key}>
                  <i style={{ background: p.color }} /> {p.label} <strong className="num">{num(p.count)}</strong>
                </span>
              ))}
            </div>
          </>
        ) : null}
        <div className="status-chips">
          {statuses.map(([code, count]) => (
            <span
              key={code}
              className={`badge ${/^2/.test(code) ? "success" : /^[45]/.test(code) || isNaN(Number(code)) ? "danger" : ""}`}
            >
              {code} <span className="num">{num(count)}</span>
            </span>
          ))}
          {!statuses.length ? <span className="muted small">No responses yet</span> : null}
        </div>
      </div>
    </section>
  );
}

type SortKey = "name" | "total" | "failed" | "avgMs" | "p50Ms" | "p95Ms" | "p99Ms" | "maxMs";
function Breakdown({ title, values }: { title: string; values: Record<string, Stats> }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "p95Ms", desc: true });
  const rows = Object.entries(values).sort(([an, a], [bn, b]) => {
    const d = sort.key === "name" ? an.localeCompare(bn) : (a[sort.key] as number) - (b[sort.key] as number);
    return sort.desc ? -d : d;
  });
  const max = Math.max(1, ...rows.map(([, s]) => s.p95Ms));
  const head = (key: SortKey, label: string, right = true) => (
    <th
      className={`sortable ${right ? "r" : ""}`}
      onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}
      aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : undefined}
    >
      {label}
      {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
    </th>
  );
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <span className="muted small">{rows.length}</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {head("name", "Name", false)}
              {head("total", "Calls")}
              {head("failed", "Failed")}
              {head("avgMs", "Avg")}
              {head("p50Ms", "p50")}
              {head("p95Ms", "p95")}
              {head("p99Ms", "p99")}
              {head("maxMs", "Max")}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map(([name, s]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td className="r">{num(s.total)}</td>
                  <td className={`r ${s.failed ? "danger-text" : "faint"}`}>{num(s.failed)}</td>
                  <td className="r">{ms(s.avgMs)}</td>
                  <td className="r">{ms(s.p50Ms)}</td>
                  <td className="r p95-cell">
                    <span className="p95-bar" style={{ width: `${(s.p95Ms / max) * 100}%` }} />
                    <span>{ms(s.p95Ms)}</span>
                  </td>
                  <td className="r">{ms(s.p99Ms)}</td>
                  <td className="r faint">{ms(s.maxMs)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8} className="empty">
                  No calls yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MysqlChart({ points }: { points: MysqlPoint[] }) {
  const hosts = [...new Set(points.map((p) => p.host))];
  return (
    <>
      {hosts.map((host) => {
        const mine = points.filter((p) => p.host === host);
        const last = mine[mine.length - 1];
        return (
          <section className="card chart-card" key={host}>
            <div className="chart-head">
              <h3>MySQL · {host}</h3>
              <strong className="num">{last?.error ? "—" : `${num(last?.connected)} connected`}</strong>
            </div>
            {last?.error ? (
              <p className="danger-text small chart-note">{last.error}</p>
            ) : (
              <Chart
                x={mine.map((p) => p.second)}
                series={[
                  { label: "Connected", color: "--chart-3", values: mine.map((p) => p.connected ?? null) },
                  { label: "Running", color: "--chart-5", values: mine.map((p) => p.running ?? null) },
                ]}
              />
            )}
          </section>
        );
      })}
    </>
  );
}

function RunView({ data, live }: { data: RunData; live?: boolean }) {
  const o = data.overall;
  const series: SeriesPoint[] = data.series || [];
  const x = series.map((p) => p.second);
  const last = series[series.length - 1];
  const hasPercentiles = series.some((p) => p.p99Ms != null);
  const avgRate = data.elapsedSeconds && o ? o.total / data.elapsedSeconds : 0;
  // Event-loop lag of the load generator: recent for a live run, worst for a report.
  const lags = (live ? series.slice(-5) : series).map((p) => p.lagMs || 0);
  const lag = lags.length ? Math.max(...lags) : 0;
  if (!o) return null;
  return (
    <div className="stack">
      {lag > LAG_WARN_MS ? (
        <div className="callout warning">
          <AlertTriangle />
          <span>
            The machine running Tenant Pulse is overloaded: its event loop fell up to <strong>{ms(lag)}</strong> behind
            {live ? " in the last few seconds" : " during this run"}. Latencies include that delay, so they read higher
            than the API really is. Use fewer VUs, add think time, or turn off the <code>success: false</code> body check
            on the Run screen.
          </span>
        </div>
      ) : null}
      <div className="kpis">
        <Kpi
          label={live ? "Requests / sec" : "Avg requests / sec"}
          value={num(live ? last?.rate : avgRate, 1)}
          sub={live ? `avg ${num(avgRate, 1)}` : undefined}
        />
        <Kpi label="p95 latency" value={ms(o.p95Ms)} sub={`p50 ${ms(o.p50Ms)} · p99 ${ms(o.p99Ms)}`} />
        <Kpi
          label="Error rate"
          value={pct(o.failed, o.total)}
          sub={`${num(o.failed)} failed`}
          tone={o.failed ? "danger" : ""}
        />
        <Kpi label="Total calls" value={num(o.total)} sub={`avg ${ms(o.avgMs)}`} />
        {data.verdict ? (
          <div className={`kpi verdict ${data.verdict.pass ? "pass" : "fail"}`}>
            <span>Verdict {live ? "so far" : ""}</span>
            <strong>{data.verdict.pass ? "PASS" : "FAIL"}</strong>
            <small className="num">
              {data.verdict.checks.map((c) => `${c.name} ${c.actual}${c.unit} ≤ ${c.limit}${c.unit}`).join(" · ")}
            </small>
          </div>
        ) : null}
      </div>
      {series.length ? (
        <div className="chart-grid">
          <section className="card chart-card">
            <div className="chart-head">
              <h3>Throughput</h3>
              <span className="muted small">requests per second</span>
            </div>
            <Chart x={x} series={[{ label: "req/s", color: "--chart-1", values: series.map((p) => p.rate) }]} />
          </section>
          <section className="card chart-card">
            <div className="chart-head">
              <h3>Latency</h3>
              <span className="muted small">{hasPercentiles ? "per second" : "p95, cumulative (older report)"}</span>
            </div>
            <Chart
              x={x}
              unit=" ms"
              series={
                hasPercentiles
                  ? [
                      { label: "p50", color: "--chart-2", values: series.map((p) => p.p50Ms ?? null) },
                      { label: "p95", color: "--chart-1", values: series.map((p) => p.p95Ms) },
                      { label: "p99", color: "--chart-3", values: series.map((p) => p.p99Ms ?? null), dash: true },
                    ]
                  : [{ label: "p95", color: "--chart-1", values: series.map((p) => p.p95Ms) }]
              }
            />
          </section>
          <section className="card chart-card">
            <div className="chart-head">
              <h3>Error rate</h3>
              <span className="muted small">% of calls each second</span>
            </div>
            <Chart x={x} unit="%" series={[{ label: "errors", color: "--chart-4", values: series.map((p) => p.errorRate) }]} />
          </section>
          <section className="card chart-card">
            <div className="chart-head">
              <h3>Active VUs</h3>
              <span className="muted small">virtual users</span>
            </div>
            <Chart x={x} series={[{ label: "VUs", color: "--chart-2", values: series.map((p) => p.activeVUs) }]} />
          </section>
          {data.mysqlSeries?.length ? <MysqlChart points={data.mysqlSeries} /> : null}
        </div>
      ) : (
        <div className="card">
          <Empty icon={<Activity />} title="Waiting for the first second of data" />
        </div>
      )}
      <ErrorBreakdown stats={o} />
      <div className="breakdown-grid">
        <Breakdown title="By request" values={data.byRequest || {}} />
        <Breakdown title="By tenant" values={data.byTenant || {}} />
      </div>
      {data.events?.length ? (
        <section className="card">
          <div className="card-head">
            <h2>Events</h2>
          </div>
          <div className="events">
            {data.events.map((e, i) => (
              <div key={i}>
                <time className="mono faint">{new Date(e.time).toLocaleTimeString()}</time>
                <span>
                  {e.tenant ? <strong>{e.tenant}: </strong> : null}
                  {e.message}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function LiveTab() {
  const { live, active, stop } = useLive();
  const { setNotice } = useWorkspace();
  if (live.state === "idle")
    return (
      <div className="card">
        <Empty
          icon={<Gauge />}
          title="No run yet"
          action={
            <Link href="/workspace/run" className="btn primary">
              Set up a run
            </Link>
          }
        >
          Start a run and its live numbers appear here. Finished runs are saved under Reports.
        </Empty>
      </div>
    );
  if (live.state === "preflight")
    return (
      <div className="card">
        <Empty icon={<Activity />} title={`Preflight ${live.preflight?.done || 0}/${live.preflight?.total || 0}`}>
          Logging in tenants and calling every request once before the load starts.
        </Empty>
      </div>
    );
  if (live.state === "failed")
    return (
      <div className="card">
        <Empty
          icon={<XCircle />}
          title="The last run did not start"
          action={
            <Link href="/workspace/run" className="btn">
              See preflight results
            </Link>
          }
        >
          {live.error}
        </Empty>
      </div>
    );
  return (
    <div className="stack">
      <div className="run-head">
        <div>
          <div className="run-title">
            <span className={`dot ${live.state}`} />
            <h1>{live.planName}</h1>
            {live.environment ? <span className="env-tag">{live.environment.name}</span> : null}
            <VerdictBadge verdict={live.state === "finished" ? live.verdict : null} />
          </div>
          <p className="muted small num">
            {live.state === "finished" ? "Finished" : live.state === "stopping" ? "Stopping" : "Running"} ·{" "}
            {duration(live.elapsedSeconds)} of {duration(live.plannedSeconds)} · {live.activeVUs}/{live.targetVUs} VUs
            {live.startedAt ? ` · started ${dateTime(live.startedAt)}` : ""}
          </p>
        </div>
        {active ? (
          <button
            className="btn danger"
            disabled={live.state === "stopping"}
            onClick={() => stop().catch((e) => setNotice({ type: "error", text: (e as Error).message }))}
          >
            Stop run
          </button>
        ) : null}
      </div>
      <RunView data={live} live={active} />
    </div>
  );
}

function Delta({ label, a, b, unit, lowerIsBetter = true }: { label: string; a: number; b: number; unit: string; lowerIsBetter?: boolean }) {
  const diff = b - a;
  const rel = a ? (diff / a) * 100 : 0;
  const worse = lowerIsBetter ? diff > 0 : diff < 0;
  const tone = Math.abs(rel) < 2 ? "" : worse ? "danger-text" : "success-text";
  return (
    <div className="delta">
      <span>{label}</span>
      <div className="num">
        <span className="muted">{num(a, 1)}{unit}</span>
        <span className="faint"> → </span>
        <strong>{num(b, 1)}{unit}</strong>
      </div>
      <small className={`num ${tone}`}>
        {diff > 0 ? "+" : ""}
        {num(rel, 1)}%
      </small>
    </div>
  );
}

function Compare({ a, b, onBack }: { a: Report; b: Report; onBack: () => void }) {
  const [first, second] = a.startedAt < b.startedAt ? [a, b] : [b, a];
  const errRate = (r: Report) => (r.overall.total ? (r.overall.failed / r.overall.total) * 100 : 0);
  const rate = (r: Report) => (r.elapsedSeconds ? r.overall.total / r.elapsedSeconds : 0);
  const seconds = [...new Set([...first.series, ...second.series].map((p) => p.second))].sort((x, y) => x - y);
  const at = (r: Report, key: "p95Ms" | "rate") => {
    const map = new Map(r.series.map((p) => [p.second, p[key]]));
    return seconds.map((s) => map.get(s) ?? null);
  };
  const title = (r: Report) => r.label || dateTime(r.startedAt);
  const requests = [...new Set([...Object.keys(first.byRequest), ...Object.keys(second.byRequest)])];
  return (
    <div className="stack">
      <div className="run-head">
        <div>
          <button className="btn ghost sm" onClick={onBack}>
            <ArrowLeft /> Reports
          </button>
          <h1 className="compare-title">
            {title(first)} <ArrowLeftRight size={16} className="faint" /> {title(second)}
          </h1>
          <p className="muted small">Older run on the left. Colours show whether the newer run got better or worse.</p>
        </div>
      </div>
      <div className="card deltas">
        <Delta label="p95 latency" a={first.overall.p95Ms} b={second.overall.p95Ms} unit=" ms" />
        <Delta label="p50 latency" a={first.overall.p50Ms} b={second.overall.p50Ms} unit=" ms" />
        <Delta label="p99 latency" a={first.overall.p99Ms} b={second.overall.p99Ms} unit=" ms" />
        <Delta label="Error rate" a={errRate(first)} b={errRate(second)} unit="%" />
        <Delta label="Requests / sec" a={rate(first)} b={rate(second)} unit="" lowerIsBetter={false} />
      </div>
      <div className="chart-grid">
        <section className="card chart-card">
          <div className="chart-head">
            <h3>p95 latency</h3>
            <span className="muted small">by second since start</span>
          </div>
          <Chart
            x={seconds}
            unit=" ms"
            sync="compare"
            series={[
              { label: title(first), color: "--chart-5", values: at(first, "p95Ms"), dash: true },
              { label: title(second), color: "--chart-1", values: at(second, "p95Ms") },
            ]}
          />
        </section>
        <section className="card chart-card">
          <div className="chart-head">
            <h3>Throughput</h3>
            <span className="muted small">requests per second</span>
          </div>
          <Chart
            x={seconds}
            sync="compare"
            series={[
              { label: title(first), color: "--chart-5", values: at(first, "rate"), dash: true },
              { label: title(second), color: "--chart-1", values: at(second, "rate") },
            ]}
          />
        </section>
      </div>
      <section className="card">
        <div className="card-head">
          <h2>p95 by request</h2>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Request</th>
                <th className="r">{title(first)}</th>
                <th className="r">{title(second)}</th>
                <th className="r">Change</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((name) => {
                const x1 = first.byRequest[name]?.p95Ms;
                const x2 = second.byRequest[name]?.p95Ms;
                const rel = x1 && x2 ? ((x2 - x1) / x1) * 100 : null;
                return (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="r">{x1 != null ? ms(x1) : "—"}</td>
                    <td className="r">{x2 != null ? ms(x2) : "—"}</td>
                    <td className={`r ${rel == null || Math.abs(rel) < 2 ? "faint" : rel > 0 ? "danger-text" : "success-text"}`}>
                      {rel == null ? "—" : `${rel > 0 ? "+" : ""}${num(rel, 1)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ReportDetail({ report, onBack, backLabel }: { report: Report; onBack: () => void; backLabel: string }) {
  return (
    <div className="stack">
      <div className="run-head">
        <div>
          <button className="btn ghost sm" onClick={onBack}>
            <ArrowLeft /> {backLabel}
          </button>
          <div className="run-title">
            <h1>{report.label || report.name}</h1>
            <VerdictBadge verdict={report.verdict} />
            {report.stopped ? <span className="badge warning">Stopped early</span> : null}
          </div>
          <p className="muted small num">
            {dateTime(report.startedAt)} · {duration(report.elapsedSeconds)} · {report.targetVUs} VUs ·{" "}
            {report.tenants.length} tenants · {report.apiHost}
            {report.environment ? (
              <>
                {" "}
                <span className="env-tag">{report.environment.name}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="page-actions">
          <a className="btn" href={`/api/reports/${encodeURIComponent(report.id)}/export?format=csv`} download>
            <Download /> CSV
          </a>
          <a className="btn" href={`/api/reports/${encodeURIComponent(report.id)}/export?format=json`} download>
            <Download /> JSON
          </a>
        </div>
      </div>
      <RunView data={report} />
    </div>
  );
}

type TrendMetric = "p95Ms" | "p50Ms" | "p99Ms" | "errorRate" | "rate";
const trendMetrics: { id: TrendMetric; label: string; unit: string; lowerIsBetter: boolean }[] = [
  { id: "p95Ms", label: "p95", unit: " ms", lowerIsBetter: true },
  { id: "p50Ms", label: "p50", unit: " ms", lowerIsBetter: true },
  { id: "p99Ms", label: "p99", unit: " ms", lowerIsBetter: true },
  { id: "errorRate", label: "Error rate", unit: "%", lowerIsBetter: true },
  { id: "rate", label: "Req/s", unit: "", lowerIsBetter: false },
];
const trendColors = ["--chart-1", "--chart-2", "--chart-3", "--chart-5", "--chart-4", "--chart-6", "--chart-7", "--chart-8"];

type TrendStats = { total: number; failed: number; p50Ms: number; p95Ms: number; p99Ms: number };
function metricOf(s: TrendStats | undefined, metric: TrendMetric, seconds: number | undefined): number | null {
  if (!s || !s.total) return null;
  if (metric === "errorRate") return Math.round((s.failed / s.total) * 1000) / 10;
  if (metric === "rate") return seconds ? Math.round((s.total / seconds) * 10) / 10 : null;
  return s[metric];
}

// One point per saved run of the current plan, oldest on the left.
function TrendsTab() {
  const { plan, env, environments, setNotice } = useWorkspace();
  const { finishedCount } = useLive();
  const [reports, setReports] = useState<ReportSummary[] | null>(null);
  const [metric, setMetric] = useState<TrendMetric>("p95Ms");
  const [split, setSplit] = useState<"overall" | "requests">("overall");
  const [filter, setFilter] = useState("");
  // Only compare runs against the same system; defaults to the plan's environment.
  const [envId, setEnvId] = useState<string | null>(null);
  const [open, setOpen] = useState<Report | null>(null);

  useEffect(() => {
    api<ReportSummary[]>("/reports")
      .then(setReports)
      .catch((error) => setNotice({ type: "error", text: (error as Error).message }));
  }, [finishedCount, setNotice]);

  if (open) return <ReportDetail report={open} onBack={() => setOpen(null)} backLabel="Trends" />;
  if (!plan || !reports) return null;
  const envFilter = envId ?? env?.id ?? "all";
  const planRuns = reports
    // Reports saved before plan IDs were recorded are matched by plan name.
    .filter((r) => (r.planId ? r.planId === plan.id : r.name === plan.name));
  // Environments the plan has run against (reports from before environments have none).
  const runEnvs = [
    ...new Map(planRuns.filter((r) => r.environment).map((r) => [r.environment!.id, r.environment!])).values(),
  ];
  const envName = (id: string) =>
    environments.find((e) => e.id === id)?.name || runEnvs.find((e) => e.id === id)?.name || id;
  const runs = planRuns
    .filter((r) => envFilter === "all" || !r.environment || r.environment.id === envFilter)
    .filter((r) => `${r.label} ${r.name}`.toLowerCase().includes(filter.toLowerCase()))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const m = trendMetrics.find((t) => t.id === metric)!;
  const x = runs.map((_, i) => i);
  // Label points by time when every run is from the same day, else by date.
  const sameDay =
    runs.length > 0 && new Date(runs[0].startedAt).toDateString() === new Date(runs[runs.length - 1].startedAt).toDateString();
  const short = (i: number) => {
    if (!runs[i]) return "";
    const d = new Date(runs[i].startedAt);
    return sameDay
      ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };
  const full = (i: number) =>
    runs[i] ? `${dateTime(runs[i].startedAt)}${runs[i].label ? ` · ${runs[i].label}` : ""}` : "";
  const requestNames = [...new Set(runs.flatMap((r) => Object.keys(r.byRequest || {})))];
  const series: ChartSeries[] =
    split === "overall"
      ? [
          {
            label: "All requests",
            color: "--chart-1",
            values: runs.map((r) => metricOf(r.overall, metric, r.elapsedSeconds)),
          },
        ]
      : requestNames.map((name, i) => ({
          label: name,
          color: trendColors[i % trendColors.length],
          values: runs.map((r) => metricOf(r.byRequest?.[name], metric, r.elapsedSeconds)),
        }));
  const limit =
    metric === "p95Ms" ? plan.thresholds.p95Ms : metric === "errorRate" ? plan.thresholds.errorRatePct : null;
  if (limit != null) series.push({ label: "Limit", color: "--danger", values: runs.map(() => limit), dash: true });
  const overall = runs.map((r) => metricOf(r.overall, metric, r.elapsedSeconds));
  const first = overall.find((v) => v != null);
  const last = [...overall].reverse().find((v) => v != null);
  const change = first != null && last != null && first ? ((last - first) / first) * 100 : null;
  const worse = change != null && (m.lowerIsBetter ? change > 0 : change < 0);
  const passed = runs.filter((r) => r.verdict?.pass).length;
  const judged = runs.filter((r) => r.verdict).length;

  async function view(id: string) {
    try {
      setOpen(await api<Report>(`/reports/${encodeURIComponent(id)}`));
    } catch (error) {
      setNotice({ type: "error", text: (error as Error).message });
    }
  }

  return (
    <div className="stack">
      <div className="trend-toolbar">
        <div className="segmented" role="tablist" aria-label="Metric">
          {trendMetrics.map((t) => (
            <button key={t.id} role="tab" aria-selected={metric === t.id} onClick={() => setMetric(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="segmented" role="tablist" aria-label="Lines">
          <button role="tab" aria-selected={split === "overall"} onClick={() => setSplit("overall")}>
            Overall
          </button>
          <button role="tab" aria-selected={split === "requests"} onClick={() => setSplit("requests")}>
            By request
          </button>
        </div>
        <select
          className="select trend-env"
          aria-label="Environment"
          value={envFilter}
          onChange={(e) => setEnvId(e.target.value)}
        >
          {[...new Set([...(env ? [env.id] : []), ...runEnvs.map((e) => e.id)])].map((id) => (
            <option key={id} value={id}>
              {envName(id)}
            </option>
          ))}
          <option value="all">All environments</option>
        </select>
        <div className="collection-search trend-filter">
          <Search />
          <input
            className="input"
            placeholder="Filter by label, e.g. release"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter runs by label"
          />
        </div>
      </div>
      {runs.length < 2 ? (
        <div className="card">
          <Empty icon={<TrendingUp />} title={runs.length ? "One run so far" : "No runs for this plan yet"}>
            A trend needs at least two saved runs of “{plan.name}”
            {envFilter !== "all" ? ` in ${envName(envFilter)}` : ""}
            {filter ? ` matching “${filter}”` : ""}. Each finished run adds a point.
          </Empty>
        </div>
      ) : (
        <>
          <div className="kpis">
            <Kpi label="Runs" value={num(runs.length)} sub={`${short(0)} → ${short(runs.length - 1)}`} />
            <Kpi
              label={`${m.label}, first → last`}
              value={last != null ? `${num(last, 1)}${m.unit}` : "—"}
              sub={first != null ? `from ${num(first, 1)}${m.unit}` : undefined}
            />
            <Kpi
              label="Change"
              value={change == null ? "—" : `${change > 0 ? "+" : ""}${num(change, 1)}%`}
              tone={change != null && Math.abs(change) >= 2 && worse ? "danger" : ""}
              sub={change == null || Math.abs(change) < 2 ? "about the same" : worse ? "worse" : "better"}
            />
            <Kpi label="Passed" value={judged ? `${passed}/${judged}` : "—"} sub={judged ? "runs with pass criteria" : "no pass criteria set"} />
          </div>
          <section className="card chart-card">
            <div className="chart-head">
              <h3>
                {m.label} per run {split === "requests" ? "· by request" : ""}
              </h3>
              <span className="muted small">oldest → newest · hover for details</span>
            </div>
            <Chart
              key={`${runs.map((r) => r.id).join()}${metric}${split}`}
              x={x}
              series={series}
              unit={m.unit}
              sync="trend"
              height={260}
              points
              xFormat={short}
              xValue={full}
              xLabel="Run"
              showX
            />
          </section>
          <section className="card">
            <div className="card-head">
              <h2>Runs in this trend</h2>
              <span className="muted small">newest first</span>
            </div>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Verdict</th>
                    <th>Run</th>
                    <th>Started</th>
                    <th className="r">VUs</th>
                    <th className="r">p95</th>
                    <th className="r">Errors</th>
                    <th className="r">Req/s</th>
                  </tr>
                </thead>
                <tbody>
                  {[...runs].reverse().map((r) => (
                    <tr key={r.id} className="clickable" onClick={() => void view(r.id)}>
                      <td>{r.verdict ? <VerdictBadge verdict={r.verdict} /> : <span className="faint">—</span>}</td>
                      <td>
                        <strong>{r.label || r.name}</strong>
                        {r.stopped ? <span className="badge warning trend-stopped">stopped</span> : null}
                        {envFilter === "all" && r.environment ? (
                          <span className="env-tag trend-stopped">{r.environment.name}</span>
                        ) : null}
                      </td>
                      <td className="muted">{dateTime(r.startedAt)}</td>
                      <td className="r">{r.targetVUs ?? "—"}</td>
                      <td className="r">{ms(r.overall.p95Ms)}</td>
                      <td className={`r ${r.overall.failed ? "danger-text" : "faint"}`}>{pct(r.overall.failed, r.overall.total)}</td>
                      <td className="r">{r.elapsedSeconds ? num(r.overall.total / r.elapsedSeconds, 1) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function ReportsTab() {
  const { setNotice } = useWorkspace();
  const { finishedCount } = useLive();
  const confirm = useConfirm();
  const [reports, setReports] = useState<ReportSummary[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState<Report | null>(null);
  const [comparing, setComparing] = useState<[Report, Report] | null>(null);

  const refresh = useCallback(async () => {
    try {
      setReports(await api<ReportSummary[]>("/reports"));
    } catch (error) {
      setNotice({ type: "error", text: (error as Error).message });
    }
  }, [setNotice]);
  useEffect(() => {
    void refresh();
  }, [refresh, finishedCount]);

  const fetchReport = (id: string) => api<Report>(`/reports/${encodeURIComponent(id)}`);
  async function view(id: string) {
    try {
      setOpen(await fetchReport(id));
    } catch (error) {
      setNotice({ type: "error", text: (error as Error).message });
    }
  }
  async function compare() {
    try {
      const [a, b] = await Promise.all(picked.map(fetchReport));
      setComparing([a, b]);
    } catch (error) {
      setNotice({ type: "error", text: (error as Error).message });
    }
  }
  async function remove(r: ReportSummary) {
    const ok = await confirm({
      title: "Delete this report?",
      description: `${r.label || r.name} · ${dateTime(r.startedAt)}`,
      confirmLabel: "Delete report",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/reports/${encodeURIComponent(r.id)}`, { method: "DELETE", body: "{}" });
      setPicked((p) => p.filter((id) => id !== r.id));
      if (open?.id === r.id) setOpen(null);
      await refresh();
    } catch (error) {
      setNotice({ type: "error", text: (error as Error).message });
    }
  }
  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));
  }

  if (comparing) return <Compare a={comparing[0]} b={comparing[1]} onBack={() => setComparing(null)} />;
  if (open) return <ReportDetail report={open} onBack={() => setOpen(null)} backLabel="Reports" />;

  if (!reports) return null;
  if (!reports.length)
    return (
      <div className="card">
        <Empty icon={<BarChart3 />} title="No saved reports">
          Every finished run is saved here with its charts and breakdowns.
        </Empty>
      </div>
    );
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Saved reports</h2>
          <p>Pick two to compare.</p>
        </div>
        <button className="btn primary" disabled={picked.length !== 2} onClick={() => void compare()}>
          <ArrowLeftRight /> Compare {picked.length ? `${picked.length}/2` : ""}
        </button>
      </div>
      <div className="table-wrap">
        <table className="table reports-table">
          <thead>
            <tr>
              <th aria-label="Select" />
              <th>Verdict</th>
              <th>Run</th>
              <th>Started</th>
              <th className="r">Duration</th>
              <th className="r">VUs</th>
              <th className="r">Calls</th>
              <th className="r">Req/s</th>
              <th className="r">p95</th>
              <th className="r">Errors</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.id} className={`clickable ${picked.includes(r.id) ? "selected" : ""}`} onClick={() => void view(r.id)}>
                <td onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    className="pick"
                    aria-label="Select for comparison"
                    checked={picked.includes(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                </td>
                <td>{r.verdict ? <VerdictBadge verdict={r.verdict} /> : <span className="faint">—</span>}</td>
                <td>
                  <strong>{r.label || r.name}</strong>
                  {r.environment ? <span className="env-tag report-env">{r.environment.name}</span> : null}
                  {r.label ? <small className="muted block">{r.name}</small> : null}
                </td>
                <td className="muted">{dateTime(r.startedAt)}</td>
                <td className="r">{r.elapsedSeconds != null ? duration(r.elapsedSeconds) : "—"}</td>
                <td className="r">{r.targetVUs ?? "—"}</td>
                <td className="r">{num(r.overall.total)}</td>
                <td className="r">{r.elapsedSeconds ? num(r.overall.total / r.elapsedSeconds, 1) : "—"}</td>
                <td className="r">{ms(r.overall.p95Ms)}</td>
                <td className={`r ${r.overall.failed ? "danger-text" : "faint"}`}>{pct(r.overall.failed, r.overall.total)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button className="btn ghost icon sm" aria-label="Delete report" onClick={() => void remove(r)}>
                    <Trash2 />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function ResultsPage() {
  const { live } = useLive();
  const [view, setView] = useState<"live" | "reports" | "trends">(live.state === "idle" ? "reports" : "live");
  const liveLabel = useMemo(
    () => (["running", "preflight", "stopping"].includes(live.state) ? "Live" : "Last run"),
    [live.state],
  );
  return (
    <div className="page">
      <div className="page-head">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={view === "live"} onClick={() => setView("live")}>
            <span className={`dot ${live.state}`} /> {liveLabel}
          </button>
          <button role="tab" aria-selected={view === "reports"} onClick={() => setView("reports")}>
            <BarChart3 size={14} /> Reports
          </button>
          <button role="tab" aria-selected={view === "trends"} onClick={() => setView("trends")}>
            <TrendingUp size={14} /> Trends
          </button>
        </div>
      </div>
      {view === "live" ? <LiveTab /> : view === "reports" ? <ReportsTab /> : <TrendsTab />}
    </div>
  );
}
