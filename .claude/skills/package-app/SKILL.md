---
name: package-app
description: Build, verify and hand over the single-file Tenant Pulse executables (npm run package → dist/tenant-pulse-linux-x64, dist/tenant-pulse-win-x64.exe) that let someone run the app without the source, Node or npm. Use it whenever the user wants to share, ship, distribute, release or "give someone" the app, rebuild the executables after a change, add a target platform (macOS, arm64), shrink the build, or when a change to service/ or web/ could break the packaged app, such as a new require, a new page, or a Next feature that needs a server.
---

# Packaging Tenant Pulse

`npm run package` (`scripts/package.js`) produces executables that need nothing installed:

1. **Static web export.** It runs `next build` with `TENANT_PULSE_EXPORT=1`, so `web/next.config.mjs` switches to `output: "export"` and writes `web/out/` (about 1.5 MB). The dev `/api` rewrite is not used in that mode. The script restores `web/next-env.d.ts` afterwards.
2. **Bundle.** It wraps `service/app.js` and every module reached through `require("./name")` into one script with a small module table. A Node SEA main script can only `require` built-ins, which is why service modules may only require Node built-ins or `"./name"`.
3. **SEA blob.** `node --experimental-sea-config` embeds the bundle plus every file in `web/out` as assets (keys like `/workspace/requests.html`).
4. **Inject.** `npx postject` injects the blob into a Node binary per target: the current `node` for the host platform, and for other targets the **same Node version** from nodejs.org (checksum-verified against `SHASUMS256.txt`, cached in `dist/.cache/`). The blob only works with the exact Node version that made it.

At runtime, `service/app.js`:

- picks a port: `API_PORT`, default 4174. If that port is taken by something that isn't a packaged Tenant Pulse, it tries the next 20 ports. If another copy is already running, it opens that one instead.
- sets `API_PORT` **before** requiring `server.js` (the Host/Origin guard reads it at load).
- serves the web files from SEA assets via `server.staticFile` (`/` and `/workspace` redirect to `/workspace/requests`).
- stores data in `tenant-pulse-data/` next to the executable.
- opens the browser (skipped with `TENANT_PULSE_NO_OPEN=1`).

`node service/app.js` runs the same entry unpackaged, serving `web/out`.

## Build

```sh
export PATH="$(ls -d ~/.nvm/versions/node/v24.*/bin | sort -V | tail -1):$PATH"
[ -d web/node_modules ] || npm --prefix web install
npm test && (cd web && npx tsc --noEmit -p .)     # don't package a broken tree
npm run package                                   # or: node scripts/package.js win-x64
```

The first build for another platform downloads about 90 MB, and it needs network access for `npx postject`. postject's warnings (`Can't find string offset for section name '.note…'`, `The signature seems corrupted!` for Windows) are expected. Output: roughly 120 MB for Linux and 90 MB for Windows.

## Verify before handing over

Test the way the recipient will run it: a copy in an empty folder, a minimal environment, a spare port, and with the owner's dev server left alone.

```sh
T=$(mktemp -d) && cp dist/tenant-pulse-linux-x64 "$T/" && cd "$T"
env -i HOME="$T" PATH=/usr/bin:/bin TENANT_PULSE_NO_OPEN=1 API_PORT=4992 ./tenant-pulse-linux-x64 > log.txt 2>&1 &
sleep 1.5; cat log.txt                                   # URL + data folder
U=http://127.0.0.1:4992
curl -s -o /dev/null -w '/ %{http_code}\n' $U/                        # 302
curl -s -o /dev/null -w 'page %{http_code} %{content_type}\n' $U/workspace/requests
curl -s $U/workspace/requests | grep -o '/_next/static/[^"]*' | sort -u | while read a; do
  curl -s -o /dev/null -w "%{http_code} " "$U$a"; done; echo    # all 200
curl -s -X PUT -H "origin: $U" -H 'content-type: application/json' \
  -d "$(curl -s $U/api/plans/default)" $U/api/plans/default -o /dev/null -w 'save %{http_code}\n'
ls tenant-pulse-data                                     # plans.json, secrets.json
```

Then:

- **Look at it.** Screenshot a few pages in headless Chrome and read the PNGs. Everything should render, with no CSP errors in the console:
  `google-chrome --headless=new --no-sandbox --disable-gpu --user-data-dir="$T/chrome" --virtual-time-budget=5000 --window-size=1400,900 --screenshot="$T/p.png" $U/workspace/run`
- **Port handling.** With something else on the port (for example a dev-style service: `TENANT_PULSE_DATA=$(mktemp -d) API_PORT=4992 node service/server.js`), the executable must move to the next port. A second launch must say "already running". With a fixed `API_PORT` on a busy port, it must say so and exit.
- **Stop what you started.** Kill the processes by PID after checking each one's `cwd` or `environ` is yours. `pkill -f tenant-pulse` can hit the owner's copy. Remove the temp folder.
- **Windows** cannot be run here (no Wine). Say that it was built but not executed, and ask the owner to try it on Windows before sending.

## Changes that break packaging

| Change | Why it breaks | Do instead |
|---|---|---|
| service `require("some-package")`, or `require("../x")`, or a computed path | the bundler only follows `require("./name")` inside `service/` | keep the service dependency-free; put shared code in `service/` |
| reading files relative to `__dirname` in the service | inside the bundle `__dirname` is `"."` | take paths from env (`TENANT_PULSE_DATA`), or embed them as SEA assets |
| Next route handlers, server actions, `cookies()`/`headers()`, dynamic routes without `generateStaticParams`, runtime rewrites/redirects | not supported by static export | client components calling `/api` (see `web/node_modules/next/dist/docs/01-app/02-guides/static-exports.md`) |
| a new page under `web/app` | exported as `<route>.html`; `webFile` in `server.js` tries `<path>`, `<path>.html` and `<path>/index.html` | nothing extra; verify the page loads packaged |
| new static file type | `types` in `server.js` maps extensions to content types | add the extension there |
| inline scripts or styles from a new library | the HTML CSP allows `'self' 'unsafe-inline'` only, with no external hosts | bundle assets locally, with no CDN |

## Adding a platform

Add the target to `known` in `scripts/package.js` and to the output naming, and check that `nodeBinary()` knows the download name (`node-<ver>-<target>.tar.gz` for linux/darwin, `win-<arch>/node.exe` for Windows). macOS also needs `codesign --remove-signature` on the copied binary before injecting, postject's `--macho-segment-name NODE_SEA` flag, and `codesign --sign -` after injecting. Signing is only possible on a Mac. Without signing, recipients must right-click → Open the first time.

## Hand-off notes for the recipient

- **Windows:** double-click `tenant-pulse-win-x64.exe`. SmartScreen may warn because the file is unsigned ("More info" → "Run anyway"). Keep the window open while using the app; closing it stops the app.
- **Linux:** `chmod +x tenant-pulse-linux-x64 && ./tenant-pulse-linux-x64`.
- The browser opens at the printed address. Data is saved in `tenant-pulse-data/` next to the file. Keep that folder when replacing the executable with a newer build, and keep it private, because it holds tokens and passwords.
- MySQL observation needs the `mysql` client installed.

`dist/` and `web/out/` are git-ignored, so executables are never committed. Share them directly or attach them to a GitHub release if the owner asks. Do not commit or push unless asked.
