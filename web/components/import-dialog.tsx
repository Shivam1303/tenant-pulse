"use client";

import { useState } from "react";
import { AlertTriangle, FileUp, Loader2, ScanSearch } from "lucide-react";
import { useWorkspace } from "./workspace-provider";
import { Dialog } from "./ui";
import { api } from "../lib/api";
import { uniqueName } from "../lib/plan";
import type { ImportResult } from "../lib/types";

type EnvAction = "skip" | "merge" | "create";
const MAX_REQUESTS = 100;

// Paste a cURL command or pick a Postman collection / environment export.
// The service parses it into a preview; nothing changes until Import, and
// the imported requests are unsaved edits like any other.
export function ImportDialog({ onClose, onImported }: { onClose: () => void; onImported?: (index: number) => void }) {
  const { plan, env, environments, updatePlan, updateEnv, addEnvironment, setNotice } = useWorkspace();
  const [text, setText] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState<boolean[]>([]);
  const [envAction, setEnvAction] = useState<EnvAction>("skip");

  if (!plan || !env) return null;
  const room = MAX_REQUESTS - plan.requests.length;
  const picked = result ? result.requests.filter((r, i) => chosen[i] && !r.error) : [];
  const variableCount = result?.environment ? Object.keys(result.environment.variables).length : 0;

  async function preview(source = text) {
    if (!source.trim()) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<ImportResult>("/import", {
        method: "POST",
        body: JSON.stringify({ text: source, baseUrl: env!.baseUrl }),
      });
      setResult(next);
      setChosen(next.requests.map((r) => !r.error));
      setEnvAction(
        next.kind === "postman-environment" ? "create" : next.environment && variableCountOf(next) ? "merge" : "skip",
      );
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function readFile(file: File) {
    const content = await file.text();
    setText(content);
    await preview(content);
  }

  function apply() {
    if (!result || !plan || !env) return;
    const taken = plan.requests.map((r) => r.name);
    const added = picked.slice(0, Math.max(0, room)).map(({ request }) => {
      const name = uniqueName(request.name, taken);
      taken.push(name);
      return { ...request, name };
    });
    if (added.length) updatePlan((current) => ({ ...current, requests: [...current.requests, ...added] }));
    const incoming = result.environment;
    let envNote = "";
    if (incoming && envAction === "merge") {
      // Values already set in the environment win; only new names are added.
      updateEnv((current) => ({ ...current, variables: { ...incoming.variables, ...current.variables } }));
      envNote = ` Added variables to ${env.name}.`;
    } else if (incoming && envAction === "create") {
      const name = uniqueName(incoming.name, environments.map((e) => e.name));
      addEnvironment({
        id: `env-${Date.now()}`,
        name,
        baseUrl: incoming.baseUrl || env.baseUrl,
        variables: incoming.variables,
        tenants: [],
      });
      envNote = ` Created environment ${name}.`;
    }
    const skipped = picked.length - added.length;
    setNotice({
      type: "success",
      text: `${added.length ? `Imported ${added.length} request${added.length === 1 ? "" : "s"}.` : ""}${envNote}${
        skipped ? ` ${skipped} left out: a plan holds at most ${MAX_REQUESTS} requests.` : ""
      } Save to keep ${added.length + (envNote ? 1 : 0) > 1 ? "them" : "it"}.`.trim(),
    });
    if (added.length && onImported) onImported(plan.requests.length);
    onClose();
  }

  const canImport = picked.length > 0 || (!!result?.environment && envAction !== "skip");
  return (
    <Dialog
      wide
      title="Import requests"
      description={
        <>
          Paste a cURL command (Copy as cURL in the browser or Postman), or choose a Postman collection (v2.1) or
          environment export. URLs on <code>{env.baseUrl}</code> become paths, so they follow the environment.
        </>
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!canImport} onClick={apply}>
            {picked.length ? `Import ${Math.min(picked.length, Math.max(0, room))} request${picked.length === 1 ? "" : "s"}` : "Import"}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="import-source">
          <label className="btn">
            <FileUp /> Choose file
            <input
              type="file"
              accept=".json,application/json,.txt,.sh"
              hidden
              onChange={(e) => e.target.files?.[0] && void readFile(e.target.files[0])}
            />
          </label>
          <span className="muted small">or paste below</span>
        </div>
        <textarea
          className="textarea mono"
          rows={6}
          spellCheck={false}
          aria-label="cURL command or Postman JSON"
          placeholder={"curl 'http://localhost:8080/orders/fetch-order-list?page_size=50' \\\n  -H 'authorization: Bearer …'"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
        />
        {!result ? (
          <div>
            <button className="btn" onClick={() => void preview()} disabled={busy || !text.trim()}>
              {busy ? <Loader2 className="spin" /> : <ScanSearch />} Preview
            </button>
          </div>
        ) : null}
        {error ? <div className="callout danger">{error}</div> : null}
        {result ? (
          <>
            {result.warnings.length ? (
              <div className="callout warning">
                <AlertTriangle />
                <span>{result.warnings.join(" ")}</span>
              </div>
            ) : null}
            {result.requests.length ? (
              <div className="import-list">
                <div className="import-list-head muted small">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={result.requests.every((r, i) => chosen[i] || r.error)}
                      onChange={(e) => setChosen(result.requests.map((r) => !r.error && e.target.checked))}
                    />
                    {picked.length} of {result.requests.length} selected
                  </label>
                  {picked.length > room ? (
                    <span className="warning-text">Only {Math.max(0, room)} fit: a plan holds {MAX_REQUESTS} requests.</span>
                  ) : null}
                </div>
                {result.requests.map((r, i) => (
                  <label key={i} className={`import-item ${r.error ? "off" : ""}`}>
                    <input
                      type="checkbox"
                      disabled={!!r.error}
                      checked={!!chosen[i] && !r.error}
                      onChange={(e) => setChosen((c) => c.map((v, n) => (n === i ? e.target.checked : v)))}
                    />
                    <span className={`method ${r.request.method}`}>{r.request.method}</span>
                    <span className="import-text">
                      <strong>{r.request.name}</strong>
                      <small className="mono">{r.request.path}</small>
                      {r.error ? <span className="danger-text small">{r.error}</span> : null}
                      {r.warnings.map((w, n) => (
                        <span key={n} className="faint small">
                          {w}
                        </span>
                      ))}
                    </span>
                    <span className="import-badges">
                      {r.request.authMode === "tenantBearer" ? <span className="badge">Tenant token</span> : null}
                      {r.request.bodyType !== "none" ? <span className="badge">{r.request.bodyType.toUpperCase()}</span> : null}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}
            {result.environment ? (
              <div className="import-env">
                <strong>
                  Variables from {result.kind === "postman-environment" ? "environment" : "collection"} “
                  {result.environment.name}”
                </strong>
                <p className="muted small">
                  {variableCount ? Object.keys(result.environment.variables).map((k) => `{{${k}}}`).join(", ") : "No variables"}
                  {result.environment.baseUrl ? ` · base URL ${result.environment.baseUrl}` : ""}
                </p>
                <div className="segmented" role="radiogroup" aria-label="What to do with the variables">
                  {(
                    [
                      ["merge", `Add to ${env.name}`],
                      ["create", "New environment"],
                      ["skip", "Skip"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      role="radio"
                      aria-checked={envAction === id}
                      aria-selected={envAction === id}
                      disabled={id === "merge" && !variableCount}
                      onClick={() => setEnvAction(id)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="faint small">
                  {envAction === "merge"
                    ? `Only names ${env.name} doesn’t have yet are added; its base URL stays.`
                    : envAction === "create"
                      ? "A new environment without tenants. Add its tenants on the Tenants screen after switching to it."
                      : "The variables are not imported."}
                </p>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </Dialog>
  );
}

const variableCountOf = (r: ImportResult) => Object.keys(r.environment?.variables || {}).length;
