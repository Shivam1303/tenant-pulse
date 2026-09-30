#!/usr/bin/env bash
# Isolated Tenant Pulse for verifying a change, without touching the owner's running dev server
# (ports 3000/4174) or their saved data (service/data).
#
#   sandbox.sh start [--no-web]   export the web app (skipped with --no-web), start a fake target
#                                 API and the Tenant Pulse service with throwaway data, seed a plan
#   sandbox.sh shot <path> <png>  headless-Chrome screenshot of a page, e.g. /workspace/run
#   sandbox.sh stop               stop what start launched and delete the throwaway data
#
# Ports: SANDBOX_PORT (default 4990) for Tenant Pulse, SANDBOX_TARGET_PORT (4991) for the target.
# State lives in $SANDBOX_DIR (default /tmp/tenant-pulse-sandbox).
set -euo pipefail

root="$(cd "$(dirname "$0")/../../../.." && pwd)"
dir="${SANDBOX_DIR:-/tmp/tenant-pulse-sandbox}"
port="${SANDBOX_PORT:-4990}"
target="${SANDBOX_TARGET_PORT:-4991}"
node="$(ls -d "$HOME"/.nvm/versions/node/v24.*/bin 2>/dev/null | sort -V | tail -1)/node"
[ -x "$node" ] || node="$(command -v node)"
url="http://127.0.0.1:$port"

stop() {
  for f in "$dir"/*.pid; do
    [ -e "$f" ] && kill "$(cat "$f")" 2>/dev/null || true
  done
  rm -rf "$dir"
}

busy() { (echo >"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

case "${1:-}" in
  start)
    "$node" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' ||
      { echo "Node 20+ needed; found $("$node" -v) at $node" >&2; exit 1; }
    stop
    for p in "$port" "$target"; do
      busy "$p" && { echo "Port $p is in use; set SANDBOX_PORT / SANDBOX_TARGET_PORT." >&2; exit 1; }
    done
    mkdir -p "$dir/data"
    if [ "${2:-}" != "--no-web" ]; then
      echo "Exporting the web app to web/out…"
      keep="$(cat "$root/web/next-env.d.ts")"
      (cd "$root/web" && TENANT_PULSE_EXPORT=1 NEXT_TELEMETRY_DISABLED=1 \
        "$node" node_modules/next/dist/bin/next build >"$dir/build.log" 2>&1) ||
        { tail -30 "$dir/build.log" >&2; exit 1; }
      # next build rewrites this file for production; keep the dev version the repo tracks.
      printf '%s\n' "$keep" >"$root/web/next-env.d.ts"
    fi

    # Fake target API: every path answers {"success":true} after ~20 ms. POST /login returns a token.
    # /fail answers {"success":false}; /slow waits 800 ms; /status/<code> answers with that code.
    TARGET_PORT="$target" "$node" -e '
      require("http").createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        const path = req.url.split("?")[0];
        req.on("end", () => setTimeout(() => {
          const code = Number((path.match(/^\/status\/(\d{3})$/) || [])[1] || 200);
          res.writeHead(code, { "content-type": "application/json" });
          if (path === "/login") return res.end(JSON.stringify({ token: "tok-" + (JSON.parse(body || "{}").client || "x") }));
          res.end(JSON.stringify({ success: path !== "/fail", path, auth: req.headers.authorization || null }));
        }, path === "/slow" ? 800 : 20));
      }).listen(+process.env.TARGET_PORT, "127.0.0.1");' >"$dir/target.log" 2>&1 &
    echo $! >"$dir/target.pid"

    TENANT_PULSE_DATA="$dir/data" API_PORT="$port" TENANT_PULSE_NO_OPEN=1 \
      "$node" "$root/service/app.js" >"$dir/service.log" 2>&1 &
    echo $! >"$dir/service.pid"
    for _ in $(seq 50); do busy "$port" && busy "$target" && break; sleep 0.1; done
    busy "$port" || { cat "$dir/service.log" >&2; exit 1; }

    # Seed: the "local" environment points at the fake target and holds two
    # token tenants; the default plan has a short run with no pacing.
    curl -sf "$url/api/environments" | "$node" -e '
      const env = JSON.parse(require("fs").readFileSync(0, "utf8")).find((e) => e.id === "local");
      delete env.plans;
      env.baseUrl = "http://127.0.0.1:" + process.argv[1];
      env.tenants = ["t-1", "t-2"].map((client) => ({ client, username: "", authMode: "token", token: "tok-" + client, variables: { departmentId: client + "-d" }, enabled: true }));
      process.stdout.write(JSON.stringify(env));' "$target" >"$dir/env.json"
    curl -sf -X PUT -H "origin: $url" -H "content-type: application/json" \
      --data @"$dir/env.json" "$url/api/environments/local" >/dev/null
    curl -sf "$url/api/plans/default" | "$node" -e '
      const plan = JSON.parse(require("fs").readFileSync(0, "utf8"));
      plan.settings = { ...plan.settings, vusPerTenant: 2, rampUpSeconds: 1, durationSeconds: 4, pacingMs: 0 };
      plan.requests = [
        { name: "Products", method: "GET", path: "/products", enabled: true, authMode: "tenantBearer", query: [], headers: [], form: [], bodyType: "none", body: "" },
        { name: "Orders", method: "GET", path: "/orders", enabled: true, authMode: "tenantBearer", query: [{ key: "dept", value: "{{departmentId}}", enabled: true }], headers: [], form: [], bodyType: "none", body: "" },
      ];
      process.stdout.write(JSON.stringify(plan));' >"$dir/plan.json"
    curl -sf -X PUT -H "origin: $url" -H "content-type: application/json" \
      --data @"$dir/plan.json" "$url/api/plans/default" >/dev/null
    echo "Sandbox ready."
    echo "  Tenant Pulse  $url/workspace/requests   (log: $dir/service.log)"
    echo "  Target API    http://127.0.0.1:$target   (/fail, /slow, /status/<code>, POST /login)"
    echo "  Data          $dir/data"
    echo "  Non-GET calls need:  -H 'origin: $url' -H 'content-type: application/json'"
    ;;
  shot)
    [ -n "${2:-}" ] && [ -n "${3:-}" ] || { echo "Usage: sandbox.sh shot /workspace/run out.png" >&2; exit 1; }
    chrome="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser)"
    timeout 60 "$chrome" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
      --user-data-dir="$dir/chrome" --virtual-time-budget="${SHOT_WAIT_MS:-5000}" \
      --window-size="${SHOT_SIZE:-1400,900}" --screenshot="$3" "$url$2" >/dev/null 2>&1
    echo "Saved $3"
    ;;
  stop)
    stop
    echo "Sandbox stopped."
    ;;
  *)
    sed -n 2,13p "$0"
    exit 1
    ;;
esac
