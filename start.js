"use strict";
const { spawn } = require("child_process");
const path = require("path");
const mode = process.argv[2] === "start" ? "start" : "dev";
const webPort = process.env.WEB_PORT || "3000";
const service = spawn(process.execPath, ["server.js"], {
  cwd: path.join(__dirname, "service"),
  stdio: "inherit",
});
const web = spawn(process.execPath, [path.join(__dirname, "web", "node_modules", "next", "dist", "bin", "next"), mode, "-H", "127.0.0.1", "-p", webPort], {
  cwd: path.join(__dirname, "web"),
  stdio: "inherit",
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  service.kill("SIGTERM");
  web.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
service.on("exit", (code) => {
  if (!stopping) {
    console.error("API service stopped.");
    stop();
    process.exitCode = code || 1;
  }
});
web.on("exit", (code) => {
  if (!stopping) {
    console.error("Web app stopped.");
    stop();
    process.exitCode = code || 1;
  }
});
