"use client";

/* ==========================================================================
   Evidence — "why is AREE recommending this action?"

   WHY IT IS COLLAPSED
     An officer under pressure needs the call first and the working second. Five
     rows of numbers above the Approve button would be read past, not read. Closed
     by default keeps the decision surface short; one click makes the whole basis
     visible without leaving the page or losing the case.

   WHERE THE NUMBERS COME FROM
     One selector, `selectEvidence`, maps a single OutlookResponse to the five
     rows. Both hosts — the Atmospheric Outlook page and the authorisation panel
     inside it — render the output of that one call on the one payload, so the
     evidence beside the Approve button is provably the same moment, the same
     case and the same numbers as the evidence higher up the page. Nothing here
     fetches, polls, caches or recomputes.

   WHAT IT DOES NOT DO
     No threshold is defined here and no state is classified here. Whether
     ventilation is low NOW is `sustained_low_now`, a stored backend feature.
     Whether dispersion is poor is `mechanism.dispersion.verdict`. The UI renders
     those words; it does not derive them. A second classifier would eventually
     disagree with the engine, and the one on screen would be the unvalidated one.
   ========================================================================== */

import { useId, useState } from "react";
import { ChevronRight, ClipboardList } from "lucide-react";

import { istClock } from "@/lib/clock";
import { COLORS, bandColor, grapColor } from "@/lib/theme";
import type { OutlookResponse } from "@/types";

/* The application writes these units typeset, everywhere it shows the same
   quantities (OutlookView, VentilationOutlook). The payload carries the ASCII
   forms "ug/m3" and "m2/s"; matching the existing screens is presentation, not
   a change of value. */
const PM25_UNIT = "µg/m³";
const VENTILATION_UNIT = "m²/s";

export interface EvidenceRow {
  label: string;
  /** Null renders as "Unavailable" — never a substituted number. */
  value: string | null;
  /** The qualifier under the value: band, comparison, rule, provenance. */
  detail?: string | null;
  /** A theme token. Absent means the default ink. */
  color?: string;
}

export interface CaseEvidence {
  rows: EvidenceRow[];
  /** The hour the observation describes, for the footer. */
  observedAt: string | null;
  /** Which series the observation is, echoed so the reader can check it. */
  targetLabel: string | null;
}

function n(value: number | null | undefined, digits = 1): string | null {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : value.toFixed(digits);
}

/**
 * The five pieces of evidence the recommendation rests on, read off one payload.
 *
 * Called once by the page and handed to both panels, so a duplicate request is
 * not merely avoided — it is impossible for the two to disagree.
 */
export function selectEvidence(data: OutlookResponse): CaseEvidence {
  const { observation, atmosphere, risk, decision, plume } = data;
  const vent = atmosphere.ventilation;

  /* ── 1 · observed PM2.5 ── */
  const pm25: EvidenceRow = {
    label: "PM2.5 (observed)",
    value: `${observation.value.toFixed(0)} ${PM25_UNIT}`,
    detail: [
      observation.band,
      observation.n_stations !== null
        ? `${observation.n_stations} ${observation.n_stations === 1 ? "monitor" : "stations"}`
        : null,
      istClock(observation.observed_at),
    ]
      .filter(Boolean)
      .join(" · "),
    color: bandColor(observation.band),
  };

  /* ── 2 · ventilation against the calibrated operating point ──
     `sustained_low_now` is the backend's own answer to "is it below right now",
     stored as a derived feature. `dispersion.verdict` describes the forecast LOW,
     not this hour, so it is labelled as the outlook rather than the reading. */
  const ventNow = n(vent.now);
  const ventThreshold = n(vent.threshold_m2_s);
  const low = vent.sustained_low_now;
  const ventilation: EvidenceRow = {
    label: "Ventilation vs threshold",
    value:
      ventNow !== null && ventThreshold !== null
        ? `${ventNow} / ${ventThreshold} ${VENTILATION_UNIT}`
        : null,
    detail: [
      low === true
        ? "Sustained below the operating point"
        : low === false
          ? "Above the operating point"
          : null,
      vent.hours_below_threshold !== null && vent.hours_below_threshold !== undefined
        ? `${vent.hours_below_threshold} h below across the outlook`
        : null,
      data.mechanism.available && data.mechanism.dispersion.verdict !== "unknown"
        ? `forecast low: ${data.mechanism.dispersion.verdict} dispersion`
        : null,
    ]
      .filter(Boolean)
      .join(" · "),
    color: low === true ? COLORS.red : low === false ? COLORS.green : undefined,
  };

  /* ── 3 · persistence ──
     The case's persistence test is the warning rule: the upper tail must HOLD
     above the severe threshold for a minimum number of consecutive hourly
     forecast points. `sustained_hours` is literally the length of that run
     (predictive_engine: `len(window)`), so it is a window count. */
  const persistence: EvidenceRow = {
    label: "Persistence",
    value:
      risk.sustained_hours !== null && risk.sustained_hours !== undefined
        ? `${risk.sustained_hours} / ${risk.min_sustained_hours} windows`
        : "None",
    detail:
      risk.sustained_hours !== null && risk.sustained_hours !== undefined
        ? `Consecutive hourly windows with q90 ≥ ${risk.threshold_ugm3.toFixed(0)} ${PM25_UNIT} · source ${risk.trigger_source}`
        : (risk.reason ??
          `Upper tail does not hold above ${risk.threshold_ugm3.toFixed(0)} ${PM25_UNIT} for ${risk.min_sustained_hours} h`),
    color:
      risk.sustained_hours !== null &&
      risk.sustained_hours !== undefined &&
      risk.sustained_hours >= risk.min_sustained_hours
        ? COLORS.red
        : undefined,
  };

  /* ── 4 · GRAP stage, as the engine read it off observed AQI ── */
  const grap: EvidenceRow = {
    label: "GRAP stage",
    value: decision.grap_stage_observed || null,
    detail: decision.grap_stage_description || null,
    color: grapColor(decision.grap_stage_observed),
  };

  /* ── 5 · fire transport ──
     The outlook contract carries the INDEX and the detections behind it, not a
     categorical verdict — `plume.note` is a fixed methodology caption, and the
     "Regional transport likely / Local emission dominant" vocabulary belongs to
     the per-station engine, which this NCR-wide case does not read. Rather than
     classify the index here, the figures are shown as the backend reports them. */
  const influence = n(plume.influence);
  const fire: EvidenceRow = {
    label: "Fire transport",
    value: plume.available && influence !== null ? `Influence ${influence}` : null,
    detail: plume.available
      ? `${plume.detections_24h} detection${plume.detections_24h === 1 ? "" : "s"} · FRP ${plume.total_frp_24h} in the preceding 24 h · ${plume.source}`
      : "No fire record for this hour",
  };

  return {
    rows: [pm25, ventilation, persistence, grap, fire],
    observedAt: observation.observed_at,
    targetLabel: observation.target_label,
  };
}

/**
 * The panel. Local UI state is the open flag and nothing else.
 *
 * A real <button> with aria-expanded/aria-controls rather than <details>: the
 * disclosure state has to be announced, and the button can carry the two-line
 * header the panel needs without fighting summary's default layout.
 */
export default function EvidencePanel({
  evidence,
  className = "",
}: {
  evidence: CaseEvidence;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  const headingId = useId();

  return (
    <div
      className={`overflow-hidden rounded-md border ${className}`}
      style={{ borderColor: COLORS.border, background: COLORS.surface1 }}
    >
      <button
        type="button"
        id={headingId}
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition"
        style={{ background: open ? COLORS.surface2 : COLORS.surface1 }}
      >
        <ClipboardList className="h-3.5 w-3.5 shrink-0" style={{ color: COLORS.muted }} aria-hidden />
        <span className="min-w-0 flex-1">
          <span
            className="block text-[10px] font-bold uppercase tracking-[0.09em]"
            style={{ color: COLORS.text }}
          >
            Evidence
          </span>
          <span className="block text-[11px] leading-snug" style={{ color: COLORS.muted }}>
            Why AREE recommends this action
          </span>
        </span>
        <ChevronRight
          className={`h-4 w-4 shrink-0 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
          style={{ color: COLORS.dim }}
          aria-hidden
        />
      </button>

      {open ? (
        <div
          id={regionId}
          role="region"
          aria-labelledby={headingId}
          className="border-t px-3.5 py-2.5"
          style={{ borderColor: COLORS.border }}
        >
          <dl className="grid gap-0">
            {evidence.rows.map((row) => (
              <div
                key={row.label}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b py-2 last:border-0"
                style={{ borderColor: COLORS.border }}
              >
                <dt className="text-[11px]" style={{ color: COLORS.muted }}>
                  {row.label}
                </dt>
                <dd className="min-w-0 text-right">
                  <span
                    className="text-[12px] font-bold tabular-nums"
                    style={{ color: row.value === null ? COLORS.dim : (row.color ?? COLORS.text) }}
                  >
                    {row.value ?? "Unavailable"}
                  </span>
                  {row.detail ? (
                    <span
                      className="block text-[10px] leading-snug"
                      style={{ color: COLORS.dim }}
                    >
                      {row.detail}
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>

          {evidence.observedAt ? (
            <p className="mt-2 text-[10px] leading-snug" style={{ color: COLORS.dim }}>
              Observation {istClock(evidence.observedAt) ?? "—"}
              {evidence.targetLabel ? ` · ${evidence.targetLabel}` : ""}. Every value is
              computed by the AREE backend for this moment.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
