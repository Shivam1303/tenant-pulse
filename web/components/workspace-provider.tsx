"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, Dispatch, SetStateAction } from "react";
import { api } from "../lib/api";
import { blankRequest } from "../lib/plan";
import type { Notice, Plan, PlanSummary } from "../lib/types";
import { useConfirm } from "./ui";

type WorkspaceContextValue = {
  plans: PlanSummary[];
  plan: Plan | null;
  loading: boolean;
  dirty: boolean;
  saving: boolean;
  notice: Notice;
  setNotice: Dispatch<SetStateAction<Notice>>;
  load: (id?: string) => Promise<void>;
  updatePlan: (updater: (plan: Plan) => Plan) => void;
  save: () => Promise<Plan | undefined>;
  createBlank: () => Promise<void>;
  duplicate: () => Promise<void>;
  remove: () => Promise<void>;
};
const Context = createContext<WorkspaceContextValue | null>(null);
const STORAGE_KEY = "tenant-pulse-plan";

// Drop empty key/value rows before sending a plan to the service.
function cleaned(plan: Plan): Plan {
  const strip = <T extends { query: { key: string }[]; headers: { key: string }[]; form: { key: string }[] }>(r: T) => ({
    ...r,
    query: (r.query || []).filter((p) => p.key?.trim()),
    headers: (r.headers || []).filter((p) => p.key?.trim()),
    form: (r.form || []).filter((p) => p.key?.trim()),
  });
  return { ...plan, requests: plan.requests.map(strip), login: strip(plan.login) };
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const confirm = useConfirm();
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [savedJson, setSavedJson] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const dirty = useMemo(() => !!plan && JSON.stringify(plan) !== savedJson, [plan, savedJson]);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const discardOk = useCallback(
    async () =>
      !dirtyRef.current ||
      confirm({
        title: "Discard unsaved changes?",
        description: "This plan has edits that are not saved yet.",
        confirmLabel: "Discard changes",
        danger: true,
      }),
    [confirm],
  );

  const adopt = useCallback((next: Plan) => {
    setPlan(next);
    setSavedJson(JSON.stringify(next));
    try {
      localStorage.setItem(STORAGE_KEY, next.id);
    } catch {}
  }, []);

  const fetchPlan = useCallback(
    async (id?: string) => {
      const list = await api<PlanSummary[]>("/plans");
      let preferred = id;
      if (!preferred)
        try {
          preferred = localStorage.getItem(STORAGE_KEY) || undefined;
        } catch {}
      const selected = list.some((p) => p.id === preferred) ? preferred! : list[0]?.id || "default";
      const next = await api<Plan>(`/plans/${encodeURIComponent(selected)}`);
      setPlans(list);
      adopt(next);
    },
    [adopt],
  );

  const load = useCallback(
    async (id?: string) => {
      if (!(await discardOk())) return;
      setLoading(true);
      try {
        await fetchPlan(id);
      } catch (error) {
        setNotice({ type: "error", text: (error as Error).message });
      } finally {
        setLoading(false);
      }
    },
    [discardOk, fetchPlan],
  );

  useEffect(() => {
    setLoading(true);
    fetchPlan()
      .catch((error) => setNotice({ type: "error", text: (error as Error).message }))
      .finally(() => setLoading(false));
  }, [fetchPlan]);

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, []);

  const updatePlan = useCallback(
    (updater: (plan: Plan) => Plan) => setPlan((current) => (current ? updater(current) : current)),
    [],
  );

  const save = useCallback(async () => {
    if (!plan) return;
    setSaving(true);
    try {
      const saved = await api<Plan>(`/plans/${encodeURIComponent(plan.id)}`, {
        method: "PUT",
        body: JSON.stringify(cleaned(plan)),
      });
      adopt(saved);
      setPlans(await api<PlanSummary[]>("/plans"));
      setNotice({ type: "success", text: "Plan saved" });
      return saved;
    } catch (error) {
      const problem = error as Error & { field?: string };
      setNotice({ type: "error", text: problem.message, field: problem.field });
      throw error;
    } finally {
      setSaving(false);
    }
  }, [plan, adopt]);

  const createBlank = useCallback(async () => {
    if (!plan || !(await discardOk())) return;
    setPlan({
      ...structuredClone(plan),
      id: `plan-${Date.now()}`,
      name: "Untitled plan",
      label: "",
      thresholds: { p95Ms: null, errorRatePct: null },
      requests: [blankRequest(1)],
      tenants: [],
      mysql: [],
    });
    // Nothing saved yet, so the whole plan counts as unsaved.
    setSavedJson("");
    setNotice({ type: "info", text: "New plan created. Save it to keep it." });
  }, [plan, discardOk]);

  const duplicate = useCallback(async () => {
    if (!plan) return;
    if (dirtyRef.current) {
      setNotice({ type: "error", text: "Save or discard your changes before duplicating." });
      return;
    }
    try {
      const copy = await api<Plan>(`/plans/${encodeURIComponent(plan.id)}/duplicate`, {
        method: "POST",
        body: "{}",
      });
      setPlans(await api<PlanSummary[]>("/plans"));
      adopt(copy);
      setNotice({ type: "success", text: `Created “${copy.name}”` });
    } catch (error) {
      setNotice({ type: "error", text: (error as Error).message });
    }
  }, [plan, adopt]);

  const remove = useCallback(async () => {
    if (!plan || plan.id === "default") return;
    const ok = await confirm({
      title: `Delete “${plan.name}”?`,
      description: "The plan and its saved passwords and tokens are removed. Saved reports stay.",
      confirmLabel: "Delete plan",
      danger: true,
    });
    if (!ok) return;
    try {
      if (savedJson)
        await api<{ removed: boolean }>(`/plans/${encodeURIComponent(plan.id)}`, { method: "DELETE", body: "{}" });
      setSavedJson(JSON.stringify(plan));
      setLoading(true);
      await fetchPlan("default");
      setNotice({ type: "success", text: "Plan deleted" });
    } catch (error) {
      setNotice({ type: "error", text: (error as Error).message });
    } finally {
      setLoading(false);
    }
  }, [plan, savedJson, confirm, fetchPlan]);

  return (
    <Context.Provider
      value={{
        plans,
        plan,
        loading,
        dirty,
        saving,
        notice,
        setNotice,
        load,
        updatePlan,
        save,
        createBlank,
        duplicate,
        remove,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useWorkspace() {
  const context = useContext(Context);
  if (!context) throw new Error("Workspace provider is missing");
  return context;
}
