"use strict";
// Builds single-file executables in dist/ that need nothing installed:
//   1. exports the web app as static files (web/out)
//   2. bundles service/app.js and its local requires into one script
//   3. makes a Node single executable application (SEA) blob with the web files as assets
//   4. injects it into a Node binary for each target
//
//   node scripts/package.js [linux-x64] [win-x64]     (default: both)
//
// The blob must be made by the same Node version as the binaries, so the targets use this
// process's version (downloaded from nodejs.org and cached in dist/.cache).

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const work = path.join(dist, ".build");
const cache = path.join(dist, ".cache");
const version = process.version;
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ["linux-x64", "win-x64"];
const known = ["linux-x64", "win-x64"];
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

for (const t of targets) if (!known.includes(t)) throw new Error(`Unknown target ${t}; use ${known.join(", ")}`);
if (Number(version.slice(1).split(".")[0]) < 22) throw new Error(`Node 22+ is needed to package (this is ${version}).`);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function exportWeb() {
  console.log("Exporting the web app…");
  const out = path.join(root, "web", "out");
  fs.rmSync(out, { recursive: true, force: true });
  // next build rewrites next-env.d.ts for production; put back the dev version the repo keeps.
  const env = path.join(root, "web", "next-env.d.ts");
  const kept = fs.readFileSync(env);
  run(process.execPath, [path.join(root, "web", "node_modules", "next", "dist", "bin", "next"), "build"], {
    cwd: path.join(root, "web"),
    env: { ...process.env, TENANT_PULSE_EXPORT: "1", NEXT_TELEMETRY_DISABLED: "1" },
  });
  fs.writeFileSync(env, kept);
  return out;
}

// Node's SEA main script can only require built-in modules, so the service's own files are
// wrapped into one script with a small module table.
function bundle(entry) {
  const modules = new Map();
  const visit = (file) => {
    const id = `./${path.basename(file, ".js")}`;
    if (modules.has(id)) return;
    const source = fs.readFileSync(file, "utf8");
    modules.set(id, source);
    for (const [, dep] of source.matchAll(/require\("(\.\/[\w-]+)"\)/g)) visit(path.join(path.dirname(file), `${dep}.js`));
  };
  visit(entry);
  const table = [...modules]
    .map(([id, source]) => `${JSON.stringify(id)}: function (module, exports, require, __filename, __dirname) {\n${source}\n}`)
    .join(",\n");
  return `"use strict";
const __modules = {\n${table}\n};
const __cache = {};
function __require(id) {
  if (!Object.prototype.hasOwnProperty.call(__modules, id)) return require(id);
  if (__cache[id]) return __cache[id].exports;
  const module = (__cache[id] = { exports: {} });
  __modules[id].call(module.exports, module, module.exports, __require, id, ".");
  return module.exports;
}
__require(${JSON.stringify(`./${path.basename(entry, ".js")}`)});
`;
}

function files(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? files(full, base) : [full];
  });
}

function download(url, target) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return download(res.headers.location, target).then(resolve, reject);
        if (res.statusCode !== 200) return reject(new Error(`${url}: HTTP ${res.statusCode}`));
        const temp = `${target}.part`;
        const file = fs.createWriteStream(temp);
        res.pipe(file);
        file.on("finish", () => file.close(() => (fs.renameSync(temp, target), resolve())));
        file.on("error", reject);
      })
      .on("error", reject);
  });
}

async function nodeBinary(target) {
  if (target === `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`) return process.execPath;
  const base = `https://nodejs.org/dist/${version}`;
  const remote = target === "win-x64" ? "win-x64/node.exe" : `node-${version}-${target}.tar.gz`;
  const local = path.join(cache, `${version}-${path.basename(remote)}`);
  if (!fs.existsSync(local)) {
    console.log(`Downloading ${base}/${remote}…`);
    fs.mkdirSync(cache, { recursive: true });
    const sums = path.join(cache, `${version}-SHASUMS256.txt`);
    if (!fs.existsSync(sums)) await download(`${base}/SHASUMS256.txt`, sums);
    await download(`${base}/${remote}`, local);
    const want = fs
      .readFileSync(sums, "utf8")
      .split("\n")
      .find((line) => line.trim().endsWith(`  ${remote}`));
    const got = crypto.createHash("sha256").update(fs.readFileSync(local)).digest("hex");
    if (!want || !want.startsWith(got)) {
      fs.rmSync(local);
      throw new Error(`Checksum mismatch for ${remote}`);
    }
  }
  if (target === "win-x64") return local;
  const extracted = path.join(cache, `node-${version}-${target}`, "bin", "node");
  if (!fs.existsSync(extracted)) run("tar", ["-xzf", local, "-C", cache]);
  return extracted;
}

async function main() {
  const out = exportWeb();

  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const main = path.join(work, "tenant-pulse.js");
  fs.writeFileSync(main, bundle(path.join(root, "service", "app.js")));

  const assets = Object.fromEntries(files(out).map((f) => [`/${path.relative(out, f).split(path.sep).join("/")}`, f]));
  const blob = path.join(work, "sea-prep.blob");
  const config = path.join(work, "sea-config.json");
  fs.writeFileSync(
    config,
    JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets }, null, 2),
  );
  console.log(`Making the SEA blob (${Object.keys(assets).length} web files)…`);
  run(process.execPath, ["--experimental-sea-config", config]);

  for (const target of targets) {
    const exe = path.join(dist, target === "win-x64" ? "tenant-pulse-win-x64.exe" : `tenant-pulse-${target}`);
    fs.copyFileSync(await nodeBinary(target), exe);
    fs.chmodSync(exe, 0o755);
    console.log(`Injecting into ${path.relative(root, exe)}…`);
    run(npx, ["--yes", "postject@1.0.0-alpha.6", exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", fuse]);
  }
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\nDone (Node ${version}):`);
  for (const f of fs.readdirSync(dist).filter((f) => f.startsWith("tenant-pulse-")))
    console.log(`  dist/${f}  ${(fs.statSync(path.join(dist, f)).size / 1e6).toFixed(0)} MB`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
