"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ChartSeries = {
  name: string;
  /** CSS color, e.g. "var(--chart-1)". */
  color: string;
  values: number[];
};

const MARGIN = { top: 12, right: 20, bottom: 26, left: 44 };
const HEIGHT = 260;

function niceMax(value: number): number {
  if (value <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const mult of [1, 2, 2.5, 5, 10]) {
    if (value <= mult * pow) return mult * pow;
  }
  return 10 * pow;
}

function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setWidth(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

function formatValue(value: number): string {
  return value.toLocaleString("en-US");
}

function Gridlines({
  ticks,
  yFor,
  width,
}: {
  ticks: number[];
  yFor: (value: number) => number;
  width: number;
}) {
  return (
    <>
      {ticks.map((tick) => (
        <g key={tick}>
          <line
            x1={MARGIN.left}
            x2={width - MARGIN.right}
            y1={yFor(tick)}
            y2={yFor(tick)}
            stroke="var(--border)"
            strokeWidth={1}
          />
          <text
            x={MARGIN.left - 8}
            y={yFor(tick)}
            dy="0.32em"
            textAnchor="end"
            className="fill-muted-foreground text-[11px] tabular-nums"
          >
            {formatValue(tick)}
          </text>
        </g>
      ))}
    </>
  );
}

function XTicks({
  labels,
  xFor,
  width,
}: {
  labels: string[];
  xFor: (index: number) => number;
  width: number;
}) {
  const step = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(width / 90))));
  return (
    <>
      {labels.map((label, i) =>
        i % step === 0 ? (
          <text
            key={i}
            x={xFor(i)}
            y={HEIGHT - MARGIN.bottom + 16}
            textAnchor="middle"
            className="fill-muted-foreground text-[11px]"
          >
            {label}
          </text>
        ) : null,
      )}
    </>
  );
}

function Tooltip({
  x,
  containerWidth,
  title,
  rows,
}: {
  x: number;
  containerWidth: number;
  title: string;
  rows: { name: string; color: string; value: number }[];
}) {
  const flip = x > containerWidth - 170;
  return (
    <div
      className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
      style={flip ? { right: containerWidth - x + 10 } : { left: x + 10 }}
    >
      <p className="mb-1 font-medium text-muted-foreground">{title}</p>
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <div key={row.name} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-0.5 w-3 shrink-0 rounded-full"
              style={{ background: row.color }}
            />
            <span className="text-muted-foreground">{row.name}</span>
            <span className="ml-auto font-semibold tabular-nums text-foreground">
              {formatValue(row.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function DataTable({
  caption,
  labels,
  series,
}: {
  caption: string;
  labels: string[];
  series: ChartSeries[];
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Date</th>
          {series.map((s) => (
            <th key={s.name} scope="col">
              {s.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {labels.map((label, i) => (
          <tr key={i}>
            <th scope="row">{label}</th>
            {series.map((s) => (
              <td key={s.name}>{s.values[i]}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ChartLegend({ series }: { series: ChartSeries[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {series.map((s) => (
        <span key={s.name} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span
            aria-hidden
            className="h-0.5 w-3 rounded-full"
            style={{ background: s.color }}
          />
          {s.name}
        </span>
      ))}
    </div>
  );
}

export function LineChart({
  labels,
  series,
  title,
}: {
  labels: string[];
  series: ChartSeries[];
  title: string;
}) {
  const { ref, width } = useMeasuredWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const n = labels.length;
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const max = niceMax(Math.max(...series.flatMap((s) => s.values), 0));
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const xFor = useCallback(
    (i: number) => MARGIN.left + (n <= 1 ? innerWidth / 2 : (i * innerWidth) / (n - 1)),
    [innerWidth, n],
  );
  const yFor = (value: number) =>
    MARGIN.top + innerHeight - (value / max) * innerHeight;

  const indexFromPointer = (clientX: number, rect: DOMRect) => {
    const x = clientX - rect.left - MARGIN.left;
    const step = n <= 1 ? innerWidth : innerWidth / (n - 1);
    return Math.min(n - 1, Math.max(0, Math.round(x / step)));
  };

  return (
    <div ref={ref} className="relative w-full">
      {width > 0 && n > 0 && (
        <svg
          role="img"
          aria-label={title}
          width={width}
          height={HEIGHT}
          tabIndex={0}
          className="block outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onPointerMove={(event) =>
            setActive(
              indexFromPointer(
                event.clientX,
                event.currentTarget.getBoundingClientRect(),
              ),
            )
          }
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive(n - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              const delta = event.key === "ArrowLeft" ? -1 : 1;
              setActive((current) =>
                Math.min(n - 1, Math.max(0, (current ?? n - 1) + delta)),
              );
            }
            if (event.key === "Escape") setActive(null);
          }}
        >
          <Gridlines ticks={ticks} yFor={yFor} width={width} />
          <XTicks labels={labels} xFor={xFor} width={width} />

          {active !== null && (
            <line
              x1={xFor(active)}
              x2={xFor(active)}
              y1={MARGIN.top}
              y2={HEIGHT - MARGIN.bottom}
              stroke="var(--muted-foreground)"
              strokeOpacity={0.4}
              strokeWidth={1}
            />
          )}

          {series.map((s) => (
            <polyline
              key={s.name}
              points={s.values.map((v, i) => `${xFor(i)},${yFor(v)}`).join(" ")}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {active !== null &&
            series.map((s) => (
              <circle
                key={s.name}
                cx={xFor(active)}
                cy={yFor(s.values[active])}
                r={4}
                fill={s.color}
                stroke="var(--card)"
                strokeWidth={2}
              />
            ))}
        </svg>
      )}

      {active !== null && (
        <Tooltip
          x={xFor(active)}
          containerWidth={width}
          title={labels[active]}
          rows={series.map((s) => ({
            name: s.name,
            color: s.color,
            value: s.values[active],
          }))}
        />
      )}

      <DataTable caption={title} labels={labels} series={series} />
    </div>
  );
}

export function BarChart({
  labels,
  series,
  title,
}: {
  labels: string[];
  series: ChartSeries;
  title: string;
}) {
  const { ref, width } = useMeasuredWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const n = labels.length;
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const max = niceMax(Math.max(...series.values, 0));
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const band = n > 0 ? innerWidth / n : 0;
  const barWidth = Math.max(2, Math.min(24, band * 0.7));
  const baseline = MARGIN.top + innerHeight;
  const xFor = (i: number) => MARGIN.left + i * band + band / 2;
  const yFor = (value: number) => baseline - (value / max) * innerHeight;

  const barPath = (i: number, value: number) => {
    const x = xFor(i) - barWidth / 2;
    const top = yFor(value);
    const r = Math.min(4, barWidth / 2, Math.max(0, baseline - top));
    if (baseline - top < 1) return null;
    return [
      `M ${x} ${baseline}`,
      `L ${x} ${top + r}`,
      `Q ${x} ${top} ${x + r} ${top}`,
      `L ${x + barWidth - r} ${top}`,
      `Q ${x + barWidth} ${top} ${x + barWidth} ${top + r}`,
      `L ${x + barWidth} ${baseline}`,
      "Z",
    ].join(" ");
  };

  return (
    <div ref={ref} className="relative w-full">
      {width > 0 && n > 0 && (
        <svg
          role="img"
          aria-label={title}
          width={width}
          height={HEIGHT}
          tabIndex={0}
          className="block outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive(n - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              const delta = event.key === "ArrowLeft" ? -1 : 1;
              setActive((current) =>
                Math.min(n - 1, Math.max(0, (current ?? n - 1) + delta)),
              );
            }
            if (event.key === "Escape") setActive(null);
          }}
        >
          <Gridlines ticks={ticks} yFor={yFor} width={width} />
          <XTicks labels={labels} xFor={xFor} width={width} />

          {series.values.map((value, i) => {
            const path = barPath(i, value);
            return (
              <g key={i}>
                {path && (
                  <path
                    d={path}
                    fill={series.color}
                    opacity={active === null || active === i ? 1 : 0.55}
                  />
                )}
                <rect
                  x={MARGIN.left + i * band}
                  y={MARGIN.top}
                  width={band}
                  height={innerHeight}
                  fill="transparent"
                  onPointerMove={() => setActive(i)}
                />
              </g>
            );
          })}
        </svg>
      )}

      {active !== null && (
        <Tooltip
          x={xFor(active)}
          containerWidth={width}
          title={labels[active]}
          rows={[
            {
              name: series.name,
              color: series.color,
              value: series.values[active],
            },
          ]}
        />
      )}

      <DataTable caption={title} labels={labels} series={[series]} />
    </div>
  );
}
