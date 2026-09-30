import type { Tenant } from "./types";

// Small RFC 4180 parser: quoted fields, escaped quotes, CRLF.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim()));
}

const reserved = ["client", "username", "password", "token"];

export type ImportRow = { tenant: Tenant; problems: string[] };

// Columns: client, username, password, token; every other column is a variable.
export function tenantsFromCsv(text: string): { rows: ImportRow[]; error?: string } {
  const [header, ...lines] = parseCsv(text);
  if (!header) return { rows: [], error: "The file is empty." };
  const cols = header.map((h) => h.trim());
  if (!cols.includes("client")) return { rows: [], error: 'Add a "client" column.' };
  const seen = new Set<string>();
  const rows = lines.map((line) => {
    const get = (name: string) => (line[cols.indexOf(name)] ?? "").trim();
    const variables: Record<string, string> = {};
    cols.forEach((c, i) => {
      if (!reserved.includes(c) && c) variables[c] = (line[i] ?? "").trim();
    });
    const tenant: Tenant = {
      client: get("client"),
      username: get("username"),
      authMode: get("token") ? "token" : "login",
      password: get("password") || undefined,
      token: get("token") || undefined,
      variables,
      enabled: true,
    };
    const problems: string[] = [];
    if (!tenant.client) problems.push("No client");
    else if (seen.has(tenant.client)) problems.push("Duplicate client");
    seen.add(tenant.client);
    for (const c of Object.keys(variables))
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(c)) problems.push(`Bad column name "${c}"`);
    return { tenant, problems };
  });
  return { rows };
}
