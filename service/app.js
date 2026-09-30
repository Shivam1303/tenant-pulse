"use strict";
// Entry point of the packaged app (scripts/package.js): one process serves the exported web app and
// /api on API_PORT, then opens the browser. Also runs unpackaged as `node service/app.js` after
// `npm run package` has exported web/out.

const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");

let sea = null;
try {
  sea = require("node:sea");
  if (!sea.isSea()) sea = null;
} catch (_) {}

// Data lives next to the executable, so the app can be moved or deleted as one folder.
if (!process.env.TENANT_PULSE_DATA)
  process.env.TENANT_PULSE_DATA = sea
    ? path.join(path.dirname(process.execPath), "tenant-pulse-data")
    : path.join(__dirname, "data");
if (!sea && !process.env.TENANT_PULSE_WEB) process.env.TENANT_PULSE_WEB = path.join(__dirname, "..", "web", "out");

const pageUrl = (port) => `http://127.0.0.1:${port}/workspace/requests`;

function openBrowser(url) {
  if (process.env.TENANT_PULSE_NO_OPEN) return;
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch (_) {}
}

// A double-clicked console window closes on exit; keep it open so the message can be read.
function fail(message) {
  console.error(message);
  if (process.stdin.isTTY) {
    console.error("Press Enter to close.");
    process.stdin.once("data", () => process.exit(1));
  } else process.exit(1);
}

const isFree = (port) =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

// True when the port already runs a packaged Tenant Pulse (it serves the web page, not only /api).
const isTenantPulse = (port) =>
  new Promise((resolve) => {
    const req = http.get(pageUrl(port), { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 && String(res.headers["content-type"]).startsWith("text/html"));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });

// Returns { port } to listen on, or { running } when this app is already up.
async function choosePort() {
  const fixed = process.env.API_PORT;
  const first = Number(fixed || 4174);
  const last = fixed ? first : first + 20;
  for (let port = first; port <= last; port++) {
    if (await isFree(port)) return { port };
    if (await isTenantPulse(port)) return { running: port };
  }
  return { error: fixed ? `Port ${first} is used by another program.` : `Ports ${first}–${last} are all in use.` };
}

async function main() {
  const choice = await choosePort();
  if (choice.error) return fail(`${choice.error} Set API_PORT to a free port (for example API_PORT=4300).`);
  if (choice.running) {
    console.log(`Tenant Pulse is already running. Opening ${pageUrl(choice.running)}`);
    openBrowser(pageUrl(choice.running));
    return setTimeout(() => process.exit(0), 500);
  }
  // server.js reads API_PORT when loaded (its Host/Origin guard), so set it first.
  process.env.API_PORT = String(choice.port);
  const server = require("./server");
  if (sea)
    server.staticFile = (name) => {
      try {
        return Buffer.from(sea.getAsset(name));
      } catch (_) {
        return null;
      }
    };
  server.on("error", (error) => fail(`Could not start Tenant Pulse: ${error.message}`));
  server.listen(choice.port, "127.0.0.1", () => {
    console.log(`Tenant Pulse is running at ${pageUrl(choice.port)}`);
    console.log(`Data folder: ${process.env.TENANT_PULSE_DATA}`);
    console.log("Keep this window open while you use it. Press Ctrl+C to stop.");
    openBrowser(pageUrl(choice.port));
  });
}

process.on("SIGINT", () => process.exit(0));
main().catch((error) => fail(`Could not start Tenant Pulse: ${error.message}`));
