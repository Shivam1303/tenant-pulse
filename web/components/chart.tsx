"use client";

import { useEffect, useRef } from "react";
import type uPlotType from "uplot";

export type ChartSeries = {
  label: string;
  color: string; // CSS variable name, e.g. "--chart-1"
  values: (number | null)[];
  dash?: boolean;
};

const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";

function fmtAxis(v: number) {
  if (Math.abs(v) >= 1000) return `${Math.round(v / 100) / 10}k`;
  return String(Math.round(v * 10) / 10);
}
function fmtSeconds(v: number) {
  const m = Math.floor(v / 60);
  return m ? `${m}:${String(Math.round(v % 60)).padStart(2, "0")}` : `${Math.round(v)}s`;
}

// Time-series chart. Charts that share `sync` move their crosshair together.
export function Chart({
  x,
  series,
  unit = "",
  height = 180,
  sync = "run",
  yMin,
  xFormat = fmtSeconds,
  xValue,
  xLabel = "Time",
  points = false,
  showX = false,
}: {
  showX?: boolean;
  xFormat?: (v: number) => string;
  // Hover legend text for an x value; defaults to the axis format.
  xValue?: (v: number) => string;
  xLabel?: string;
  points?: boolean;
  x: number[];
  series: ChartSeries[];
  unit?: string;
  height?: number;
  sync?: string;
  yMin?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlotType | null>(null);
  const shape = series.map((s) => `${s.label}${s.color}${s.dash}`).join("|");
  const data = useRef<uPlotType.AlignedData>([x, ...series.map((s) => s.values)]);
  data.current = [x, ...series.map((s) => s.values)];

  // Build the plot when the set of series changes.
  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void import("uplot").then(({ default: uPlot }) => {
      if (disposed || !box.current) return;
      const grid = cssVar("--chart-grid");
      const axis = cssVar("--chart-axis");
      const font = `11px ${getComputedStyle(document.body).fontFamily}`;
      const axisOpts = { stroke: axis, font, grid: { stroke: grid, width: 1 }, ticks: { show: false } };
      const opts: uPlotType.Options = {
        width: box.current.clientWidth,
        height,
        padding: [10, 8, 0, 0],
        cursor: {
          sync: { key: sync },
          points: { size: 6 },
          drag: { x: false, y: false },
        },
        legend: { show: true, live: true },
        scales: {
          x: { time: false },
          y: { range: (_u, min, max) => [yMin ?? Math.min(0, min), max <= 0 ? 1 : max * 1.1] },
        },
        axes: [
          { ...axisOpts, size: 26, values: (_u, vals) => vals.map((v) => (Number.isInteger(v) ? xFormat(v) : "")), space: 60 },
          { ...axisOpts, size: 48, values: (_u, vals) => vals.map(fmtAxis) },
        ],
        series: [
          { label: xLabel, value: (_u, v) => (v == null ? "—" : (xValue || xFormat)(v)) },
          ...series.map((s) => {
            const color = cssVar(s.color);
            return {
              label: s.label,
              stroke: color,
              width: 1.6,
              dash: s.dash ? [4, 4] : undefined,
              fill: series.length === 1 ? `${color}1f` : undefined,
              points: { show: points && !s.dash, size: 6 },
              spanGaps: true,
              value: (_u: uPlotType, v: number | null) => (v == null ? "—" : `${fmtAxis(v)}${unit}`),
            };
          }),
        ],
      };
      plot.current = new uPlot(opts, data.current, box.current);
      observer = new ResizeObserver(() => {
        if (box.current && plot.current) plot.current.setSize({ width: box.current.clientWidth, height });
      });
      observer.observe(box.current);
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // xFormat is read when the plot is built; x changes arrive via setData.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, height, sync, unit, yMin, points, xLabel]);

  // New points: update in place, no rebuild.
  useEffect(() => {
    plot.current?.setData(data.current);
  });

  return <div className={`chart ${showX ? "show-x" : ""}`} ref={box} />;
}
