"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import type { Live } from "../lib/types";

type LiveContextValue = {
  live: Live;
  active: boolean;
  refresh: () => Promise<Live>;
  stop: () => Promise<void>;
  // Increments whenever a run finishes, so report lists can refetch.
  finishedCount: number;
};
const Context = createContext<LiveContextValue | null>(null);
const isActive = (state: string) => ["preflight", "running", "stopping"].includes(state);

// Polls /api/live once a second while a run is active and asks only for
// series points it has not seen yet.
export function LiveProvider({ children }: { children: ReactNode }) {
  const [live, setLive] = useState<Live>({ state: "idle" });
  const [finishedCount, setFinishedCount] = useState(0);
  const current = useRef<Live>({ state: "idle" });

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);

  const fetchLive = useCallback(async () => {
    const prev = current.current;
    const last = prev.series?.length ? prev.series[prev.series.length - 1].second : null;
    const next = await api<Live>(`/live${prev.id && last != null ? `?since=${last}` : ""}`);
    // Compare against the latest state: two overlapping fetches must not
    // append the same points twice.
    const now = current.current;
    const seen = now.series?.length ? now.series[now.series.length - 1].second : -1;
    const seenDb = now.mysqlSeries?.length ? now.mysqlSeries[now.mysqlSeries.length - 1].second : -1;
    const merged: Live =
      next.id && next.id === now.id
        ? {
            ...next,
            series: [...(now.series || []), ...(next.series || []).filter((p) => p.second > seen)],
            mysqlSeries: [...(now.mysqlSeries || []), ...(next.mysqlSeries || []).filter((p) => p.second > seenDb)],
          }
        : next;
    if (isActive(now.state) && ["finished", "failed"].includes(next.state)) setFinishedCount((n) => n + 1);
    current.current = merged;
    setLive(merged);
    return merged;
  }, []);

  // Fetch now and reschedule; fast while a run is active, slow otherwise.
  const refresh = useCallback(async () => {
    clearTimeout(timer.current);
    let state = current.current.state;
    try {
      state = (await fetchLive()).state;
    } finally {
      if (alive.current) timer.current = setTimeout(() => void refresh().catch(() => {}), isActive(state) ? 1000 : 4000);
    }
    return current.current;
  }, [fetchLive]);

  useEffect(() => {
    alive.current = true;
    void refresh().catch(() => {});
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, [refresh]);

  const stop = useCallback(async () => {
    await api("/stop", { method: "POST", body: "{}" });
    await refresh();
  }, [refresh]);

  return (
    <Context.Provider value={{ live, active: isActive(live.state), refresh, stop, finishedCount }}>
      {children}
    </Context.Provider>
  );
}
export function useLive() {
  const context = useContext(Context);
  if (!context) throw new Error("Live provider is missing");
  return context;
}
