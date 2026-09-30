export const num = (n: number | undefined | null, digits = 0) =>
  Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: digits });

export const ms = (n: number | undefined | null) => {
  const v = Number(n || 0);
  return v >= 10000 ? `${num(v / 1000, 1)} s` : `${num(v, v < 10 ? 1 : 0)} ms`;
};

export const pct = (part: number, total: number) =>
  total ? `${num((part / total) * 100, part && part / total < 0.001 ? 2 : 1)}%` : "0%";

export const duration = (seconds: number | undefined | null) => {
  const s = Math.max(0, Math.round(Number(seconds || 0)));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export const bytes = (n: number | undefined) => {
  const v = Number(n || 0);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${num(v / 1024, 1)} KB`;
  return `${num(v / 1024 / 1024, 1)} MB`;
};
