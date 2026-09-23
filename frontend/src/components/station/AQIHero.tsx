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
import { SeverityIndicator, LiveIndicator } from "@/components/ui/Card";

const GAUGE_MAX = 500;

/** CPCB band boundaries, matching `aqiColor` exactly. */
const BANDS: { from: number; to: number; color: string }[] = [
  { from: 0, to: 50, color: "var(--aree-accent)" },
  { from: 50, to: 100, color: "var(--aree-lime)" },
  { from: 100, to: 200, color: "var(--aree-yellow)" },
  { from: 200, to: 300, color: "var(--aree-orange)" },
  { from: 300, to: 400, color: "var(--aree-red)" },
  { from: 400, to: 500, color: "var(--aree-red)" },
];

const CX = 120;
const CY = 110;
const R = 90;

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

function AQIGauge({
  aqi,
  band,
}: {
  aqi: number | null | undefined;
  /** The backend's CPCB classification. Never derived here — see the file header. */
  band: string | null | undefined;
}) {
  const value = aqi ?? null;
  const color = aqiColor(value);
  const needle = value === null ? null : polar(value);

  /* WHAT A SCREEN READER IS TOLD ABOUT A DIAL.
     The needle is the only thing in this graphic that carries information, so the
     label has to describe WHERE IT POINTS and not merely that a gauge exists. Three
     facts, in the order a sighted reader takes them from the picture: the reading,
     the band it lands in, and how far along the 0–500 scale that is. The last one is
     what replaces seeing the needle's angle — "180 of 500" is a number, "36 per cent
     of the way along" is a position.

     The band is the backend's, exactly as it is on the chip beside the gauge. A
     second classification computed here would eventually disagree with the one an
     officer is reading two inches to the left. */
  const sweptPercent =
    value === null ? null : Math.round((Math.min(value, GAUGE_MAX) / GAUGE_MAX) * 100);

  const gaugeLabel =
    value === null
      ? "Air quality index gauge. No value available, the needle is not shown."
      : [
          `Air quality index gauge. Needle at ${value} out of ${GAUGE_MAX}`,
          band ? `in the ${band} band` : null,
          `${sweptPercent} per cent along the scale`,
        ]
          .filter(Boolean)
          .join(", ") + ".";

  return (
    <svg
      viewBox="0 0 240 134"
      className="h-auto w-full max-w-[260px] drop-shadow-md"
      role="img"
      aria-label={gaugeLabel}
    >
      {/* Background track */}
      <path
        d={arcPath(0, 500)}
        stroke="var(--aree-surface-3)"
        strokeWidth={14}
        strokeLinecap="round"
        fill="none"
      />
      
      {BANDS.map((band) => (
        <path
          key={band.from}
          d={arcPath(band.from, band.to)}
          stroke={band.color}
          strokeOpacity={value !== null && value > band.from ? 1 : 0.15}
          strokeWidth={14}
          strokeLinecap="butt"
          fill="none"
          className="transition-all duration-700 ease-out"
        />
      ))}

      {needle ? (
        <>
          {/* Subtle glow behind needle */}
          <line
            x1={CX} y1={CY} x2={needle.x} y2={needle.y}
            stroke={color} strokeWidth={8} strokeLinecap="round" strokeOpacity={0.2}
            className="blur-sm"
          />
          <line
            x1={CX}
            y1={CY}
            x2={needle.x}
            y2={needle.y}
            stroke={color}
            strokeWidth={3}
            strokeLinecap="round"
          />
          <circle cx={needle.x} cy={needle.y} r={6} fill="var(--aree-card)" stroke={color} strokeWidth={2.5} />
          <circle cx={CX} cy={CY} r={6} fill="var(--aree-card)" stroke={color} strokeWidth={2.5} />
        </>
      ) : null}

      <text x={polar(0).x - 10} y={CY + 18} textAnchor="middle" fill="var(--aree-faint)" fontSize="10" fontWeight="600">
        0
      </text>
      <text x={polar(GAUGE_MAX).x + 10} y={CY + 18} textAnchor="middle" fill="var(--aree-faint)" fontSize="10" fontWeight="600">
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
      className="bg-aree-card border-aree-border relative overflow-hidden rounded-2xl border shadow-lg"
      aria-label="Current air quality index"
    >
      {/* Decorative gradient wash */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.06] transition-colors duration-700"
        style={{
          background: `radial-gradient(circle at 10% 20%, ${color}, transparent 60%)`,
        }}
        aria-hidden
      />

      <div className="relative flex flex-col gap-8 p-8 sm:flex-row sm:items-center sm:justify-between lg:p-10">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-aree-dim text-sm font-bold tracking-widest uppercase">Current AQI</h2>
            {status === "current" && <LiveIndicator />}
          </div>
          
          <div className="flex items-baseline gap-4 mt-2">
            <SeverityIndicator value={data.aqi ?? 0} color={color} size="xl" />
            <div
              className="text-[18px] font-bold tracking-[0.15em] uppercase bg-aree-surface-2 px-3 py-1 rounded-lg border border-aree-border shadow-sm"
              style={{ color }}
            >
              {orDash(data.cpcb_band, "Not available")}
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3 bg-aree-surface-1/50 p-3 rounded-xl border border-aree-border/50 inline-flex">
            <div
              className="flex items-center gap-2 text-[13px] font-bold tracking-[0.06em] bg-aree-surface-2 px-2.5 py-1 rounded-md border border-aree-border/50"
              style={{ color: look.color }}
            >
              <span className="flex h-2 w-2 rounded-full" style={{ background: look.color }} aria-hidden />
              WAQI · {look.badge}
            </div>
            {ageText ? (
              <span className="aree-num text-aree-muted text-[13px] font-medium flex items-center gap-1.5">
                <span className="text-aree-dim">Last update:</span> {ageText}
              </span>
            ) : null}
          </div>

          <div className="text-aree-dim mt-4 text-[12px] flex items-center gap-3">
            <span className="bg-aree-surface-2 px-2 py-1 rounded border border-aree-border/50">
              Dominant: <strong className="text-aree-body ml-1">{data.dominant_pollutant ? pollutantLabel(data.dominant_pollutant) : "—"}</strong>
            </span>
            <span className="bg-aree-surface-2 px-2 py-1 rounded border border-aree-border/50">
              {data.pollutants_available ?? 0} pollutants
            </span>
            <span className="bg-aree-surface-2 px-2 py-1 rounded border border-aree-border/50">
              Feed ID: <span className="aree-num font-medium text-aree-body ml-1">{feedLabel(data.feed_id) ?? "—"}</span>
            </span>
          </div>
        </div>

        <div className="flex shrink-0 justify-center sm:justify-end sm:w-[280px]">
          <AQIGauge aqi={data.aqi} band={data.cpcb_band} />
        </div>
      </div>
    </section>
  );
}
