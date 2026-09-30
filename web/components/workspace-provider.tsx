"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, Dispatch, SetStateAction } from "react";
import { api } from "../lib/api";
import { blankRequest } from "../lib/plan";
import type { Environment, Notice, Plan, PlanSummary } from "../lib/types";
import { useConfirm } from "./ui";

type WorkspaceContextValue = {
  plans: PlanSummary[];
  plan: Plan | null;
  // Drafts of every environment; `env` is the one the plan runs against.
  environments: Environment[];
  env: Environment | null;
  // Environments with unsaved edits (ids).
  dirtyEnvironments: string[];
  loading: boolean;
  dirty: boolean;
  saving: boolean;
  notice: Notice;
  setNotice: Dispatch<SetStateAction<Notice>>;
  load: (id?: string) => Promise<void>;
  updatePlan: (updater: (plan: Plan) => Plan) => void;
  // Edits the active environment, or the one with `id`.
  updateEnv: (updater: (env: Environment) => Environment, id?: string) => void;
  selectEnvironment: (id: string) => void;
  addEnvironment: (env: Environment) => void;
  duplicateEnvironment: (id: string) => Promise<void>;
  removeEnvironment: (id: string) => Promise<void>;
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
// What the service stores for an environment: no usage list, no blank rows.
function cleanedEnv(env: Environment) {
  const { plans: _usage, ...rest } = env;
  return rest;
}
const envJson = (env: Environment) => JSON.stringify(cleanedEnv(env));

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const confirm = useConfirm();
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [savedJson, setSavedJson] = useState("");
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [savedEnvs, setSavedEnvs] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const dirtyEnvironments = useMemo(
    () => environments.filter((e) => envJson(e) !== savedEnvs[e.id]).map((e) => e.id),
    [environments, savedEnvs],
  );
  const env = useMemo(
    () => environments.find((e) => e.id === plan?.environmentId) || environments[0] || null,
    [environments, plan?.environmentId],
  );
  const dirty = useMemo(
    () => (!!plan && JSON.stringify(plan) !== savedJson) || dirtyEnvironments.length > 0,
    [plan, savedJson, dirtyEnvironments],
  );
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const discardOk = useCallback(
    async () =>
      !dirtyRef.current ||
      confirm({
        title: "Discard unsaved changes?",
        description: "This plan or its environments have edits that are not saved yet.",
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

  const adoptEnvironments = useCallback((list: Environment[]) => {
    setEnvironments(list);
    setSavedEnvs(Object.fromEntries(list.map((e) => [e.id, envJson(e)])));
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
      const [next, envs] = await Promise.all([
        api<Plan>(`/plans/${encodeURIComponent(selected)}`),
        api<Environment[]>("/environments"),
      ]);
      setPlans(list);
      adoptEnvironments(envs);
      adopt(next);
    },
    [adopt, adoptEnvironments],
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

  const updateEnv = useCallback(
    (updater: (env: Environment) => Environment, id?: string) =>
      setEnvironments((list) => {
        const target = id || plan?.environmentId || list[0]?.id;
        return list.map((e) => (e.id === target ? updater(e) : e));
      }),
    [plan?.environmentId],
  );

  const selectEnvironment = useCallback(
    (id: string) => updatePlan((current) => ({ ...current, environmentId: id })),
    [updatePlan],
  );

  // A new environment is a draft until Save.
  const addEnvironment = useCallback((next: Environment) => {
    setEnvironments((list) => [...list, next]);
  }, []);

  const save = useCallback(async () => {
    if (!plan) return;
    setSaving(true);
    try {
      // Environments first: the plan may point at a new one.
      const savedList: Environment[] = [];
      for (const e of environments.filter((x) => dirtyEnvironments.includes(x.id)))
        savedList.push(
          await api<Environment>(`/environments/${encodeURIComponent(e.id)}`, {
            method: "PUT",
            body: JSON.stringify(cleanedEnv(e)),
          }),
        );
      const saved = await api<Plan>(`/plans/${encodeURIComponent(plan.id)}`, {
        method: "PUT",
        body: JSON.stringify(cleaned(plan)),
      });
      adopt(saved);
      setPlans(await api<PlanSummary[]>("/plans"));
      // Every dirty environment was saved above; reload them all so "used by"
      // reflects the plan's environment.
      adoptEnvironments(await api<Environment[]>("/environments"));
      setNotice({ type: "success", text: savedList.length ? "Plan and environment saved" : "Plan saved" });
      return saved;
    } catch (error) {
      const problem = error as Error & { field?: string };
      setNotice({ type: "error", text: problem.message, field: problem.field });
      throw error;
    } finally {
      setSaving(false);
    }
  }, [plan, environments, dirtyEnvironments, adopt, adoptEnvironments]);

  const duplicateEnvironment = useCallback(
    async (id: string) => {
      if (dirtyEnvironments.includes(id)) {
        setNotice({ type: "error", text: "Save or discard this environment’s changes before duplicating it." });
        return;
      }
      try {
        const copy = await api<Environment>(`/environments/${encodeURIComponent(id)}/duplicate`, {
          method: "POST",
          body: "{}",
        });
        setEnvironments((list) => [...list, copy]);
        setSavedEnvs((current) => ({ ...current, [copy.id]: envJson(copy) }));
        setNotice({ type: "success", text: `Created “${copy.name}”` });
      } catch (error) {
        setNotice({ type: "error", text: (error as Error).message });
      }
    },
    [dirtyEnvironments],
  );

  const removeEnvironment = useCallback(
    async (id: string) => {
      const target = environments.find((e) => e.id === id);
      if (!target) return;
      if (plan?.environmentId === id) {
        setNotice({ type: "error", text: "This plan runs against it. Switch the plan to another environment first." });
        return;
      }
      const ok = await confirm({
        title: `Delete “${target.name}”?`,
        description: "Its tenants and their saved passwords and tokens are removed. Saved reports stay.",
        confirmLabel: "Delete environment",
        danger: true,
      });
      if (!ok) return;
      try {
        if (savedEnvs[id])
          await api<{ removed: boolean }>(`/environments/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
        setEnvironments((list) => list.filter((e) => e.id !== id));
        setSavedEnvs(({ [id]: _gone, ...rest }) => rest);
        setNotice({ type: "success", text: "Environment deleted" });
      } catch (error) {
        setNotice({ type: "error", text: (error as Error).message });
      }
    },
    [environments, plan?.environmentId, savedEnvs, confirm],
  );

  const createBlank = useCallback(async () => {
    if (!plan || !(await discardOk())) return;
    setPlan({
      ...structuredClone(plan),
      id: `plan-${Date.now()}`,
      name: "Untitled plan",
      label: "",
      thresholds: { p95Ms: null, errorRatePct: null },
      requests: [blankRequest(1)],
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
        environments,
        env,
        dirtyEnvironments,
        loading,
        dirty,
        saving,
        notice,
        setNotice,
        load,
        updatePlan,
        updateEnv,
        selectEnvironment,
        addEnvironment,
        duplicateEnvironment,
        removeEnvironment,
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
