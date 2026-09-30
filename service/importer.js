"use strict";

// Turns a pasted cURL command, a Postman v2.x collection or a Postman
// environment file into requests (and variables) for a plan. Only builds a
// preview: the browser picks what to keep and saves it like any other edit.

const { validateRequest, builtins, isAbsolute, names } = require("./schema");

const managed = new Set(["host", "content-length", "connection"]);

// ---- cURL ------------------------------------------------------------------

// Splits a bash-style command line into words: quotes, escapes, $'…' and
// backslash line continuations, as "Copy as cURL" produces them.
function shellWords(input) {
  const words = [];
  let word = null;
  let i = 0;
  const s = input.replace(/\\\r?\n/g, " ");
  const push = (c) => (word = (word || "") + c);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      if (word != null) words.push(word);
      word = null;
      i++;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error("A single quote is not closed.");
      push(s.slice(i + 1, end));
      i = end + 1;
    } else if (c === "$" && s[i + 1] === "'") {
      i += 2;
      let out = "";
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "\\" && i + 1 < s.length) {
          const n = s[++i];
          out += { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"' }[n] ?? `\\${n}`;
        } else out += s[i];
        i++;
      }
      if (s[i] !== "'") throw new Error("A $'…' quote is not closed.");
      push(out);
      i++;
    } else if (c === '"') {
      i++;
      let out = "";
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && '"\\$`'.includes(s[i + 1])) i++;
        out += s[i++];
      }
      if (s[i] !== '"') throw new Error("A double quote is not closed.");
      push(out);
      i++;
    } else if (c === "\\" && i + 1 < s.length) {
      push(s[i + 1]);
      i += 2;
    } else {
      push(c);
      i++;
    }
  }
  if (word != null) words.push(word);
  return words;
}

const ignoredFlags = new Set([
  "-k", "--insecure", "-L", "--location", "-s", "--silent", "-S", "--show-error", "-v", "--verbose",
  "-i", "--include", "--compressed", "--http1.1", "--http2", "-g", "--globoff", "-f", "--fail", "-N", "--no-buffer",
]);
const ignoredWithValue = new Set([
  "-o", "--output", "-m", "--max-time", "--connect-timeout", "--retry", "-w", "--write-out", "--proxy", "-x",
]);

function fromCurl(text) {
  const words = shellWords(text.trim());
  if (!words.length || !/(^|\/)curl(\.exe)?$/i.test(words[0])) throw new Error("A cURL command starts with curl.");
  const warnings = [];
  const headers = [];
  const data = [];
  let method = "";
  let url = "";
  let get = false;
  let json = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const value = () => {
      if (i + 1 >= words.length) throw new Error(`${w} needs a value.`);
      return words[++i];
    };
    if (w === "-X" || w === "--request") method = value().toUpperCase();
    else if (/^-X[A-Z]+$/.test(w)) method = w.slice(2);
    else if (w === "-H" || w === "--header") {
      const h = value();
      const at = h.indexOf(":");
      if (at > 0) headers.push({ key: h.slice(0, at).trim(), value: h.slice(at + 1).trim(), enabled: true });
    } else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii"].includes(w)) {
      const d = value();
      if (d.startsWith("@") && w !== "--data-raw") warnings.push(`Skipped ${w} ${d}: request bodies from files are not supported.`);
      else data.push(d);
    } else if (w === "--data-urlencode") {
      const d = value();
      const at = d.indexOf("=");
      data.push(at > 0 ? `${d.slice(0, at)}=${encodeURIComponent(d.slice(at + 1))}` : encodeURIComponent(d.replace(/^=/, "")));
    } else if (w === "--json") {
      data.push(value());
      json = true;
    } else if (w === "-G" || w === "--get") get = true;
    else if (w === "--url") url = value();
    else if (w === "-A" || w === "--user-agent") headers.push({ key: "User-Agent", value: value(), enabled: true });
    else if (w === "-e" || w === "--referer") headers.push({ key: "Referer", value: value(), enabled: true });
    else if (w === "-b" || w === "--cookie") headers.push({ key: "Cookie", value: value(), enabled: true });
    else if (w === "-u" || w === "--user") {
      value();
      warnings.push("Skipped -u: basic auth is not supported. Requests use the tenant's bearer token.");
    } else if (w === "-F" || w === "--form") {
      value();
      warnings.push("Skipped -F: multipart form bodies are not supported.");
    } else if (ignoredFlags.has(w) || /^-[kLsSvifgN]+$/.test(w)) continue;
    else if (ignoredWithValue.has(w)) value();
    else if (w.startsWith("-")) warnings.push(`Ignored option ${w}.`);
    else if (!url) url = w;
    else warnings.push(`Ignored extra argument ${w}.`);
  }
  if (!url) throw new Error("The cURL command has no URL.");
  let body = data.join("&");
  if (get && body) {
    url += (url.includes("?") ? "&" : "?") + body;
    body = "";
  }
  if (json && !headers.some((h) => h.key.toLowerCase() === "content-type"))
    headers.push({ key: "Content-Type", value: "application/json", enabled: true });
  return {
    kind: "curl",
    items: [{ method: method || (body ? "POST" : "GET"), url, headers, body: body ? { raw: body } : null, warnings }],
    warnings: [],
  };
}

// ---- Postman ---------------------------------------------------------------

const enabledPairs = (list) =>
  (Array.isArray(list) ? list : [])
    .filter((p) => p && typeof p.key === "string" && p.key && p.type !== "file")
    .map((p) => ({ key: p.key, value: p.value == null ? "" : String(p.value), enabled: !p.disabled }));

function postmanUrl(u) {
  if (typeof u === "string") return { raw: u, query: null };
  if (!u || typeof u !== "object") return { raw: "", query: null };
  let raw = u.raw;
  if (!raw) {
    const host = Array.isArray(u.host) ? u.host.join(".") : u.host || "";
    const pathPart = Array.isArray(u.path) ? u.path.join("/") : u.path || "";
    raw = `${u.protocol ? `${u.protocol}://` : ""}${host}${u.port ? `:${u.port}` : ""}/${pathPart}`;
  }
  raw = raw.split("?")[0];
  // Path variables (/orders/:id) take their value from url.variable, or
  // become a {{variable}} the tenant or environment fills in.
  const vars = Object.fromEntries((u.variable || []).filter((v) => v && v.key).map((v) => [v.key, v.value]));
  raw = raw.replace(/\/:([A-Za-z][A-Za-z0-9_]*)/g, (_, k) => `/${vars[k] ? vars[k] : `{{${k}}}`}`);
  return { raw, query: Array.isArray(u.query) ? enabledPairs(u.query) : null };
}

function postmanBody(b, warnings) {
  if (!b || !b.mode || b.disabled) return null;
  if (b.mode === "raw") {
    const language = b.options && b.options.raw && b.options.raw.language;
    return { raw: b.raw || "", type: language === "json" ? "json" : language ? "text" : undefined };
  }
  if (b.mode === "urlencoded") return { form: enabledPairs(b.urlencoded) };
  if (b.mode === "formdata") {
    if ((b.formdata || []).some((p) => p && p.type === "file"))
      warnings.push("Skipped file fields: multipart uploads are not supported.");
    warnings.push("Form-data fields are sent URL-encoded.");
    return { form: enabledPairs(b.formdata) };
  }
  if (b.mode === "graphql") {
    const g = b.graphql || {};
    let variables = {};
    try {
      variables = g.variables ? JSON.parse(g.variables) : {};
    } catch (_) {
      warnings.push("GraphQL variables are not valid JSON and were left out.");
    }
    return { raw: JSON.stringify({ query: g.query || "", variables }, null, 2), type: "json" };
  }
  warnings.push(`Skipped a ${b.mode} body: not supported.`);
  return null;
}

// "bearer" → the tenant's token; "noauth" → none; inherit → parent's.
function authMode(auth, inherited, warnings) {
  const a = auth === undefined ? inherited : auth;
  if (!a || a.type === "noauth") return "none";
  if (a.type === "bearer") return "tenantBearer";
  warnings.push(`${a.type} auth is not supported; the request is sent without authorization.`);
  return "none";
}

const hasScripts = (node) =>
  (node.event || []).some((e) => e && e.script && [].concat(e.script.exec || []).join("").trim());

function fromPostmanCollection(doc) {
  const warnings = [];
  const items = [];
  let scripts = hasScripts(doc);
  const walk = (list, prefix, inheritedAuth) => {
    for (const node of list || []) {
      if (!node || typeof node !== "object") continue;
      scripts = scripts || hasScripts(node);
      const name = prefix ? `${prefix} / ${node.name || "Untitled"}` : node.name || "Untitled";
      if (Array.isArray(node.item)) {
        walk(node.item, name, node.auth === undefined ? inheritedAuth : node.auth);
        continue;
      }
      const r = typeof node.request === "string" ? { url: node.request, method: "GET" } : node.request || {};
      const itemWarnings = [];
      const url = postmanUrl(r.url);
      items.push({
        name,
        method: String(r.method || "GET").toUpperCase(),
        url: url.raw,
        query: url.query,
        headers: enabledPairs(r.header),
        body: postmanBody(r.body, itemWarnings),
        authMode: authMode(r.auth, inheritedAuth, itemWarnings),
        warnings: itemWarnings,
      });
    }
  };
  walk(doc.item, "", doc.auth);
  if (scripts) warnings.push("Pre-request and test scripts are not run.");
  const variables = enabledPairs(doc.variable).filter((p) => p.enabled);
  return {
    kind: "postman",
    name: (doc.info && doc.info.name) || "Postman collection",
    items,
    variables,
    warnings,
  };
}

function fromPostmanEnvironment(doc) {
  return {
    kind: "postman-environment",
    name: doc.name || "Postman environment",
    items: [],
    variables: (doc.values || [])
      .filter((v) => v && v.key && v.enabled !== false)
      .map((v) => ({ key: v.key, value: v.value == null ? "" : String(v.value), enabled: true })),
    warnings: [],
  };
}

// ---- mapping to plan requests -----------------------------------------------

function splitQuery(qs) {
  const decode = (v) => {
    try {
      return decodeURIComponent(v.replace(/\+/g, " "));
    } catch (_) {
      return v;
    }
  };
  return qs
    .split("&")
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf("=");
      return {
        key: decode(at < 0 ? part : part.slice(0, at)),
        value: at < 0 ? "" : decode(part.slice(at + 1)),
        enabled: true,
      };
    });
}

function looksJson(text) {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return false;
  try {
    JSON.parse(t);
    return true;
  } catch (_) {
    return names(t).length > 0; // {"id": {{orderId}}} only parses once filled in
  }
}

// One imported item → a request the plan can hold, or an error saying why not.
function toRequest(item, baseUrl, pathPrefix) {
  const warnings = [...(item.warnings || [])];
  let url = item.url.trim();
  if (!isAbsolute(url) && !url.startsWith("{{") && !url.startsWith("/")) url = `http://${url}`;
  const q = url.indexOf("?");
  let query = item.query || [];
  if (q >= 0) {
    if (!item.query) query = splitQuery(url.slice(q + 1));
    url = url.slice(0, q);
  }
  url = url.split("#")[0];
  if (pathPrefix) url = url.replace(/^\{\{baseUrl\}\}/, `{{baseUrl}}${pathPrefix}`);
  // Same origin as the environment: keep only the path, so switching
  // environments moves the request too.
  if (baseUrl && isAbsolute(url) && url.toLowerCase().startsWith(baseUrl.toLowerCase())) {
    const rest = url.slice(baseUrl.length);
    if (!rest || rest.startsWith("/")) url = rest || "/";
  } else if (/^\{\{baseUrl\}\}(\/|$)/.test(url)) url = url.slice("{{baseUrl}}".length) || "/";

  let auth = item.authMode;
  const headers = [];
  let contentType = "";
  for (const h of item.headers || []) {
    const key = h.key.toLowerCase();
    if (managed.has(key)) continue;
    if (key === "authorization") {
      if (/^bearer\s/i.test(h.value)) {
        auth = "tenantBearer";
        if (!/^bearer\s+\{\{token\}\}$/i.test(h.value.trim()))
          warnings.push("Replaced the Authorization header with each tenant's token.");
      } else warnings.push("Dropped a non-bearer Authorization header.");
      continue;
    }
    if (key === "content-type") {
      contentType = h.enabled ? h.value.toLowerCase() : "";
      // JSON and form bodies get their content type from the body type.
      if (/json|x-www-form-urlencoded/.test(contentType)) continue;
    }
    headers.push(h);
  }

  let bodyType = "none";
  let body = "";
  let form = [];
  const b = item.body;
  if (b && b.form) {
    bodyType = "form";
    form = b.form;
  } else if (b && b.raw != null && b.raw !== "") {
    if (b.type === "json" || /json/.test(contentType) || (!b.type && !contentType && looksJson(b.raw))) {
      bodyType = "json";
      body = b.raw;
      try {
        body = JSON.stringify(JSON.parse(b.raw), null, 2);
      } catch (_) {
        /* keeps {{variables}} in non-string positions as typed */
      }
    } else if (/x-www-form-urlencoded/.test(contentType)) {
      bodyType = "form";
      form = splitQuery(b.raw);
    } else {
      bodyType = "text";
      body = b.raw;
    }
  }

  const draft = {
    name: (item.name || defaultName(item.method, url)).slice(0, 120),
    method: item.method,
    path: url,
    authMode: auth || "none",
    query,
    headers,
    form,
    bodyType,
    body,
    enabled: true,
  };
  const dynamic = [...JSON.stringify(draft).matchAll(/\{\{\$(\w+)\}\}/g)].map((m) => m[1]);
  if (dynamic.length) warnings.push(`Postman dynamic variables ({{$${dynamic[0]}}}) are sent as typed.`);
  try {
    return { request: validateRequest(draft, "request"), warnings };
  } catch (error) {
    return { request: draft, warnings, error: error.message };
  }
}

function defaultName(method, url) {
  const path = url.replace(/^https?:\/\/[^/]+/i, "").replace(/^\{\{\w+\}\}/, "");
  const last = path.split("/").filter((p) => p && !p.startsWith("{{")).pop();
  return `${method} ${last || path || "/"}`;
}

// Collection or environment variables → environment variables. {{baseUrl}}
// becomes the environment's base URL; a path in it moves into the requests.
function toEnvironment(parsed, warnings) {
  if (!parsed.variables || !parsed.variables.length) return { environment: null, pathPrefix: "" };
  const variables = {};
  let baseUrl = null;
  let pathPrefix = "";
  for (const { key, value } of parsed.variables) {
    if (key === "baseUrl" && isAbsolute(value)) {
      try {
        const u = new URL(value);
        baseUrl = u.origin;
        pathPrefix = u.pathname.replace(/\/$/, "");
      } catch (_) {
        warnings.push(`{{baseUrl}} "${value}" is not a valid URL and was left out.`);
      }
    } else if (builtins.has(key))
      warnings.push(`Left out {{${key}}}: it comes from each tenant${key === "baseUrl" ? " and the environment" : ""}.`);
    else if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) warnings.push(`Left out {{${key}}}: use letters, numbers and _ only.`);
    else variables[key] = value;
  }
  return { environment: { name: parsed.name, baseUrl, variables }, pathPrefix };
}

// text: what the user pasted or the file they picked. baseUrl: the active
// environment's, so URLs on it become relative paths.
function importText(text, baseUrl) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Paste a cURL command or a Postman file.");
  if (text.length > 5 * 1024 * 1024) throw new Error("The import is larger than 5 MB.");
  let parsed;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let doc;
    try {
      doc = JSON.parse(trimmed);
    } catch (_) {
      throw new Error("This looks like JSON but does not parse. Export the collection again from Postman.");
    }
    if (Array.isArray(doc.item)) parsed = fromPostmanCollection(doc);
    else if (Array.isArray(doc.values)) parsed = fromPostmanEnvironment(doc);
    else if (doc.collection && Array.isArray(doc.collection.item)) parsed = fromPostmanCollection(doc.collection);
    else throw new Error("Unknown JSON: expected a Postman collection (v2.1) or environment export.");
  } else parsed = fromCurl(trimmed);

  const warnings = [...parsed.warnings];
  const { environment, pathPrefix } = toEnvironment(parsed, warnings);
  const taken = new Set();
  const requests = parsed.items.map((item) => {
    const result = toRequest(item, baseUrl, pathPrefix);
    let name = result.request.name;
    for (let n = 2; taken.has(name); n++) name = `${result.request.name} ${n}`;
    taken.add(name);
    result.request.name = name;
    return result;
  });
  return { kind: parsed.kind, name: parsed.name || null, requests, environment, warnings };
}

module.exports = { importText, shellWords };
