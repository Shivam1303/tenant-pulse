"use strict";
// Entry point of the packaged app (scripts/package.js): one process serves the exported web app and
// /api on API_PORT, then opens the browser. Also runs unpackaged as `node service/app.js` after
// `npm run package` has exported web/out.

const { spawn } = require("child_process");
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

const server = require("./server");
if (sea)
  server.staticFile = (name) => {
    try {
      return Buffer.from(sea.getAsset(name));
    } catch (_) {
      return null;
    }
  };

const port = Number(process.env.API_PORT || 4174);
const url = `http://127.0.0.1:${port}/workspace/requests`;

function openBrowser() {
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

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log(`Port ${port} is in use; Tenant Pulse may already be running. Opening ${url}`);
    console.log("To use another port, set API_PORT (for example API_PORT=4180).");
    openBrowser();
    setTimeout(() => process.exit(0), 500);
  } else fail(`Could not start Tenant Pulse: ${error.message}`);
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Tenant Pulse is running at ${url}`);
  console.log(`Data folder: ${process.env.TENANT_PULSE_DATA}`);
  console.log("Keep this window open while you use it. Press Ctrl+C to stop.");
  openBrowser();
});
process.on("SIGINT", () => process.exit(0));
