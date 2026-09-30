"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { CheckCircle2, Info, Plus, X, XCircle } from "lucide-react";
import type { Notice, Pair } from "../lib/types";

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <label className="switch" title={label}>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span />
    </label>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`field ${className || ""}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <small className="hint error">{error}</small>
      ) : hint ? (
        <small className="hint">{hint}</small>
      ) : null}
    </div>
  );
}

export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon}
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Dialog({
  title,
  description,
  children,
  footer,
  onClose,
  wide,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        {children ? <div className="dialog-body">{children}</div> : null}
        <div className="dialog-foot">{footer}</div>
      </div>
    </div>
  );
}

// ---- Confirm: `await confirm({...})` resolves true/false ------------------

type ConfirmOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
};
const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(
  async () => false,
);
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) => new Promise<boolean>((resolve) => setPending({ ...options, resolve })),
    [],
  );
  const close = useCallback(
    (value: boolean) => {
      pending?.resolve(value);
      setPending(null);
    },
    [pending],
  );
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? (
        <Dialog
          title={pending.title}
          description={pending.description}
          onClose={() => close(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => close(false)}>
                Cancel
              </button>
              <button
                className={`btn ${pending.danger ? "danger-solid" : "primary"}`}
                autoFocus
                onClick={() => close(true)}
              >
                {pending.confirmLabel || "Confirm"}
              </button>
            </>
          }
        />
      ) : null}
    </ConfirmContext.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmContext);

// ---- Menu -----------------------------------------------------------------

export function Menu({ trigger, children }: { trigger: (toggle: () => void) => ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger(() => setOpen((v) => !v))}
      {open ? (
        <div className="menu" role="menu" onClick={() => setOpen(false)}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

// ---- Toast ----------------------------------------------------------------

export function Toast({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  useEffect(() => {
    if (!notice || notice.type === "error") return;
    const timer = setTimeout(onClose, 3500);
    return () => clearTimeout(timer);
  }, [notice, onClose]);
  if (!notice) return null;
  const Icon = notice.type === "success" ? CheckCircle2 : notice.type === "error" ? XCircle : Info;
  return (
    <div className={`toast ${notice.type}`} role="status">
      <Icon />
      <span>{notice.text}</span>
      <button className="btn ghost icon sm" aria-label="Dismiss" onClick={onClose}>
        <X />
      </button>
    </div>
  );
}

// ---- Key/value editor ------------------------------------------------------

export function PairEditor({
  pairs,
  onChange,
  keyPlaceholder = "key",
  addLabel = "Add",
}: {
  pairs: Pair[];
  onChange: (pairs: Pair[]) => void;
  keyPlaceholder?: string;
  addLabel?: string;
}) {
  const set = (i: number, patch: Partial<Pair>) =>
    onChange(pairs.map((p, n) => (n === i ? { ...p, ...patch } : p)));
  return (
    <div className="pairs">
      {pairs.length ? (
        <div className="pair-row head">
          <span />
          <span>Key</span>
          <span>Value</span>
          <span />
        </div>
      ) : null}
      {pairs.map((p, i) => (
        <div className={`pair-row ${p.enabled ? "" : "off"}`} key={i}>
          <Switch checked={p.enabled} onChange={(enabled) => set(i, { enabled })} label={`Enable ${p.key || "row"}`} />
          <input
            className="input mono"
            aria-label="Key"
            value={p.key}
            placeholder={keyPlaceholder}
            onChange={(e) => set(i, { key: e.target.value })}
          />
          <input
            className="input mono"
            aria-label="Value"
            value={p.value}
            placeholder="value or {{variable}}"
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <button
            className="btn ghost icon sm"
            aria-label={`Remove ${p.key || "row"}`}
            onClick={() => onChange(pairs.filter((_, n) => n !== i))}
          >
            <X />
          </button>
        </div>
      ))}
      <div>
        <button
          className="btn ghost sm"
          onClick={() => onChange([...pairs, { key: "", value: "", enabled: true }])}
        >
          <Plus /> {addLabel}
        </button>
      </div>
    </div>
  );
}
