"use client";

import { Plus, X } from "lucide-react";
import type { GeneratedField } from "../lib/types";
import { builtins } from "../lib/plan";

type Kind = GeneratedField["type"];
const kinds: { id: Kind; label: string }[] = [
  { id: "uuid", label: "UUID" },
  { id: "counter", label: "Counter (id)" },
  { id: "number", label: "Random number" },
  { id: "pick", label: "Pick from list" },
  { id: "timestamp", label: "Timestamp" },
  { id: "text", label: "Random text" },
];

function fresh(type: Kind, name: string): GeneratedField {
  switch (type) {
    case "counter":
      return { name, type, start: null };
    case "number":
      return { name, type, min: 1, max: 100 };
    case "pick":
      return { name, type, values: ["a", "b"] };
    case "timestamp":
      return { name, type, format: "iso" };
    case "text":
      return { name, type, length: 8 };
    default:
      return { name, type };
  }
}

const num = (value: string) => (value === "" ? undefined : Number(value));

// Fields a request makes up on every send. Each one is used as {{name}}.
export function GeneratedEditor({
  fields,
  onChange,
}: {
  fields: GeneratedField[];
  onChange: (fields: GeneratedField[]) => void;
}) {
  const set = (i: number, next: GeneratedField) => onChange(fields.map((g, n) => (n === i ? next : g)));
  const patch = (i: number, p: Partial<GeneratedField>) => set(i, { ...fields[i], ...p });
  const problem = (g: GeneratedField, i: number) =>
    !g.name
      ? null
      : !/^[A-Za-z][A-Za-z0-9_]*$/.test(g.name)
        ? "Letters, numbers and underscores only"
        : builtins.has(g.name)
          ? "Provided automatically"
          : fields.findIndex((o) => o.name === g.name) !== i
            ? "Already used"
            : null;
  function add() {
    let n = fields.length + 1;
    while (fields.some((g) => g.name === `value${n}`)) n++;
    onChange([...fields, fresh("uuid", `value${n}`)]);
  }

  return (
    <div className="pairs generated">
      <p className="muted editor-note">
        Values made up fresh on every send, so each order is new. Use a name as <code>{"{{name}}"}</code> in the URL,
        params, headers or body. A counter starts at the current time unless you give a start, and a new run continues
        from where the last one ended.
      </p>
      {fields.map((g, i) => {
        const bad = problem(g, i);
        return (
          <div className="generated-row" key={i}>
            <input
              className={`input mono ${bad ? "invalid" : ""}`}
              aria-label="Name"
              value={g.name}
              placeholder="orderId"
              title={bad || undefined}
              onChange={(e) => patch(i, { name: e.target.value.trim() })}
            />
            <select
              className="select"
              aria-label={`Type of ${g.name || "field"}`}
              value={g.type}
              onChange={(e) => set(i, fresh(e.target.value as Kind, g.name))}
            >
              {kinds.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.label}
                </option>
              ))}
            </select>
            <div className="generated-options">
              {g.type === "uuid" ? <span className="muted">A new random UUID</span> : null}
              {g.type === "counter" ? (
                <input
                  className="input mono"
                  type="number"
                  aria-label="Start"
                  value={g.start ?? ""}
                  placeholder="Start (blank: current time)"
                  onChange={(e) => patch(i, { start: num(e.target.value) ?? null })}
                />
              ) : null}
              {g.type === "number" ? (
                <>
                  <input className="input mono" type="number" aria-label="Smallest" value={g.min ?? ""} placeholder="min" onChange={(e) => patch(i, { min: num(e.target.value) })} />
                  <input className="input mono" type="number" aria-label="Largest" value={g.max ?? ""} placeholder="max" onChange={(e) => patch(i, { max: num(e.target.value) })} />
                </>
              ) : null}
              {g.type === "pick" ? (
                <input
                  className="input mono"
                  aria-label="Values"
                  value={(g.values || []).join(", ")}
                  placeholder="web, app, pos"
                  onChange={(e) => patch(i, { values: e.target.value.split(",").map((v) => v.trimStart()) })}
                />
              ) : null}
              {g.type === "timestamp" ? (
                <select className="select" aria-label="Format" value={g.format || "iso"} onChange={(e) => patch(i, { format: e.target.value as "iso" | "epoch" })}>
                  <option value="iso">ISO date (2026-10-01T10:00:00Z)</option>
                  <option value="epoch">Epoch milliseconds</option>
                </select>
              ) : null}
              {g.type === "text" ? (
                <input className="input mono" type="number" aria-label="Length" value={g.length ?? ""} placeholder="length" onChange={(e) => patch(i, { length: num(e.target.value) })} />
              ) : null}
            </div>
            <button className="btn ghost icon sm" aria-label={`Remove ${g.name || "field"}`} onClick={() => onChange(fields.filter((_, n) => n !== i))}>
              <X />
            </button>
          </div>
        );
      })}
      <div>
        <button className="btn ghost sm" onClick={add}>
          <Plus /> Add generated field
        </button>
      </div>
    </div>
  );
}
