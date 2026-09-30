"use strict";

// Latency histogram with ~2% wide log-scale buckets. A fixed array keeps
// percentile lookups cheap (no sorting) so snapshots never slow the run.
const GROWTH = 1.02;
const LOG_GROWTH = Math.log(GROWTH);
const MAX_MS = 120000;
const BUCKETS = Math.ceil(Math.log(MAX_MS) / LOG_GROWTH) + 1;

const bucketOf = (ms) =>
  ms <= 1 ? 0 : Math.min(BUCKETS - 1, Math.ceil(Math.log(ms) / LOG_GROWTH));
const bucketValue = (index) =>
  index === 0 ? 1 : Math.round(GROWTH ** index * 10) / 10;

function isSuccess(result, checkSuccessField = true) {
  return (
    !result.error &&
    result.status >= 200 &&
    result.status < 300 &&
    !(checkSuccessField && result.successFalse)
  );
}

function group() {
  return {
    total: 0,
    successful: 0,
    failed: 0,
    sumMs: 0,
    maxMs: 0,
    histogram: new Uint32Array(BUCKETS),
    statuses: {},
    errors: {
      timeout: 0,
      connection: 0,
      network: 0,
      unauthorized: 0,
      rateLimited: 0,
      server: 0,
      apiFailure: 0,
    },
  };
}

function add(g, result, ok) {
  g.total++;
  if (ok) g.successful++;
  else g.failed++;
  g.sumMs += result.ms;
  g.maxMs = Math.max(g.maxMs, result.ms);
  g.histogram[bucketOf(result.ms)]++;
  const status = result.error || String(result.status);
  g.statuses[status] = (g.statuses[status] || 0) + 1;
  if (result.error) g.errors[result.error] = (g.errors[result.error] || 0) + 1;
  if (result.status === 401 || result.status === 403) g.errors.unauthorized++;
  if (result.status === 429) g.errors.rateLimited++;
  if (result.status >= 500) g.errors.server++;
  // A 2xx judged as failed means the body said success: false.
  if (!ok && !result.error && result.status >= 200 && result.status < 300)
    g.errors.apiFailure++;
}

function percentile(g, q) {
  if (!g.total) return 0;
  const target = Math.max(1, Math.ceil(g.total * q));
  let count = 0;
  for (let i = 0; i < BUCKETS; i++) {
    count += g.histogram[i];
    if (count >= target) return Math.min(bucketValue(i), round(g.maxMs));
  }
  return round(g.maxMs);
}

const round = (n) => Math.round(n * 10) / 10;

function summary(g) {
  return {
    total: g.total,
    successful: g.successful,
    failed: g.failed,
    avgMs: g.total ? round(g.sumMs / g.total) : 0,
    p50Ms: percentile(g, 0.5),
    p95Ms: percentile(g, 0.95),
    p99Ms: percentile(g, 0.99),
    maxMs: round(g.maxMs),
    statuses: g.statuses,
    errors: g.errors,
  };
}

// Compare a summary with the plan's thresholds. Returns null when none set.
function verdict(thresholds, overall) {
  const checks = [];
  if (thresholds && thresholds.p95Ms != null)
    checks.push({
      name: "p95 latency",
      limit: thresholds.p95Ms,
      actual: overall.p95Ms,
      unit: "ms",
      pass: overall.p95Ms <= thresholds.p95Ms,
    });
  if (thresholds && thresholds.errorRatePct != null) {
    const rate = overall.total
      ? round((overall.failed / overall.total) * 100)
      : 0;
    checks.push({
      name: "Error rate",
      limit: thresholds.errorRatePct,
      actual: rate,
      unit: "%",
      pass: rate <= thresholds.errorRatePct,
    });
  }
  return checks.length
    ? { pass: checks.every((c) => c.pass), checks }
    : null;
}

module.exports = { group, add, percentile, summary, verdict, isSuccess };
