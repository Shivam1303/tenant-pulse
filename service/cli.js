#!/usr/bin/env node
"use strict";

const store = require("./store");
const { Run, preflight } = require("./engine");
const { unsafeMethods } = require("./schema");

function printRows(rows) {
  for (const row of rows)
    console.log(`${row.ok ? "PASS" : "FAIL"} ${row.tenant} / ${row.request}: ${row.detail}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || !args.includes("--plan")) {
    console.log("Usage: node cli.js --plan PLAN_ID [--preflight-only] [--allow-writes]");
    return;
  }
  const id = args[args.indexOf("--plan") + 1];
  const data = store.getPlan(id, true);
  if (!data) throw new Error("Plan not found. Save it in the local web app first.");
  if (
    data.plan.requests.some((r) => r.enabled && unsafeMethods.has(r.method)) &&
    !args.includes("--allow-writes")
  )
    throw new Error("Write requests require --allow-writes.");
  if (args.includes("--preflight-only")) {
    const check = await preflight(data.plan, data.secrets);
    printRows(check.rows);
    if (!check.ok) process.exitCode = 1;
    return;
  }
  const run = new Run(data.plan, data.secrets, data.mysqlSecrets, (report) => store.saveReport(report));
  process.once("SIGINT", () => run.stop());
  console.log(
    `Preflight, then ${data.plan.tenants.length * data.plan.settings.vusPerTenant} virtual users. Ctrl+C stops gracefully.`,
  );
  const report = await run.start();
  if (!report) {
    printRows(run.preflight.rows.filter((r) => !r.ok));
    console.error(run.error);
    process.exitCode = 1;
    return;
  }
  console.log(
    `Saved ${report.id}: ${report.overall.total} calls, ${report.overall.failed} failed, p95 ${report.overall.p95Ms} ms.`,
  );
  if (report.verdict) {
    for (const c of report.verdict.checks)
      console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name}: ${c.actual}${c.unit} (limit ${c.limit}${c.unit})`);
    if (!report.verdict.pass) process.exitCode = 1;
  } else if (report.overall.failed) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
