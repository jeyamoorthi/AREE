"use client";

/**
 * AQI hero card — the dominant number of the command center.
 *
 * The value, band, dominant pollutant and freshness classification all come
 * from the station payload. The gauge is presentation of that same value
 * against the CPCB band boundaries; it never smooths or projects anything.
 */

import { formatAgeBehind, formatDuration } from "@/lib/duration";
import { freshness } from "@/lib/freshness";
import { feedLabel, pollutantLabel } from "@/lib/station";
import { aqiColor, orDash } from "@/lib/theme";
import type { StationDetail } from "@/types";

const GAUGE_MAX = 500;

/** CPCB band boundaries, matching `aqiColor` exactly. */
const BANDS: { from: number; to: number; color: string }[] = [
  { from: 0, to: 50, color: "#22c55e" },
  { from: 50, to: 100, color: "#84cc16" },
  { from: 100, to: 200, color: "#eab308" },
  { from: 200, to: 300, color: "#f97316" },
  { from: 300, to: 400, color: "#ef4444" },
  { from: 400, to: 500, color: "#dc2626" },
];

const CX = 110;
const CY = 100;
const R = 84;

function polar(value: number, radius = R) {
  const clamped = Math.max(0, Math.min(GAUGE_MAX, value));
  const angle = Math.PI * (1 - clamped / GAUGE_MAX);
  return { x: CX + radius * Math.cos(angle), y: CY - radius * Math.sin(angle) };
}

function arcPath(from: number, to: number) {
  const start = polar(from);
  const end = polar(to);
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${R} ${R} 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function AQIGauge({ aqi }: { aqi: number | null | undefined }) {
  const value = aqi ?? null;
  const color = aqiColor(value);
  const needle = value === null ? null : polar(value);

  return (
    <svg
      viewBox="0 0 220 124"
      className="h-auto w-full max-w-[240px]"
      role="img"
      aria-label={
        value === null
          ? "Air quality index gauge, no value available"
          : `Air quality index gauge showing ${value} out of ${GAUGE_MAX}`
      }
    >
      {BANDS.map((band) => (
        <path
          key={band.from}
          d={arcPath(band.from, band.to)}
          stroke={band.color}
          strokeOpacity={value !== null && value > band.from ? 0.95 : 0.22}
          strokeWidth={11}
          strokeLinecap="butt"
          fill="none"
        />
      ))}

      {needle ? (
        <>
          <line
            x1={CX}
            y1={CY}
            x2={needle.x}
            y2={needle.y}
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          <circle cx={needle.x} cy={needle.y} r={5.5} fill={color} />
          <circle cx={CX} cy={CY} r={5} fill="var(--aree-card)" stroke={color} strokeWidth={2} />
        </>
      ) : null}

      <text
        x={polar(0).x}
        y={CY + 16}
        textAnchor="middle"
        fill="var(--aree-faint)"
        fontSize="9"
      >
        0
      </text>
      <text
        x={polar(GAUGE_MAX).x}
        y={CY + 16}
        textAnchor="middle"
        fill="var(--aree-faint)"
        fontSize="9"
      >
        {GAUGE_MAX}
      </text>
    </svg>
  );
}

export default function AQIHero({ data }: { data: StationDetail }) {
  const color = aqiColor(data.aqi);
  const status = data.freshness_status;
  const look = freshness(status);
  const age = formatDuration(data.stale_seconds);
  const ageText =
    status === "stale"
      ? formatAgeBehind(data.stale_seconds)
      : age
        ? `${age} ago`
        : null;

  return (
    <section
      className="bg-aree-card border-aree-border relative overflow-hidden rounded-xl border shadow-[0_1px_2px_rgba(0,0,0,0.4),0_10px_30px_-20px_rgba(0,0,0,1)]"
      aria-label="Current air quality index"
    >
      {/* A single restrained wash of the band colour behind the hero number. */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.09]"
        style={{
          background: `radial-gradient(520px 240px at 12% 0%, ${color}, transparent 70%)`,
        }}
        aria-hidden
      />

      <div className="relative flex flex-col gap-6 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
        <div className="min-w-0">
          <div className="aree-eyebrow">Current AQI</div>
          <div
            className="aree-hero-num mt-2 text-[clamp(3.5rem,2rem+7vw,5.5rem)]"
            style={{ color }}
          >
            {data.aqi ?? "—"}
          </div>
          <div
            className="mt-2 text-[15px] font-bold tracking-[0.1em] uppercase"
            style={{ color }}
          >
            {orDash(data.cpcb_band, "Not available")}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span
              className="flex items-center gap-1.5 text-[12px] font-bold tracking-[0.06em]"
              style={{ color: look.color }}
            >
              <span aria-hidden>{look.marker}</span>
              WAQI · {look.badge}
            </span>
            {ageText ? (
              <span className="aree-num text-aree-muted text-[12px]">{ageText}</span>
            ) : null}
          </div>

          <div className="text-aree-dim mt-2 text-[11px]">
            Dominant {data.dominant_pollutant ? pollutantLabel(data.dominant_pollutant) : "—"}{" "}
            · {data.pollutants_available ?? 0} pollutants · feed{" "}
            <span className="aree-num">{feedLabel(data.feed_id) ?? "—"}</span>
          </div>
        </div>

        <div className="flex shrink-0 justify-center sm:justify-end">
          <AQIGauge aqi={data.aqi} />
        </div>
      </div>
    </section>
  );
}
