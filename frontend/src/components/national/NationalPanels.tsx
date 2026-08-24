"use client";

/**
 * National overview panels.
 *
 * Everything here is derived from /api/stations, /api/system/status and
 * /api/dashboard. Where a value cannot be derived it renders "Not available"
 * rather than a plausible-looking number.
 */

import Link from "next/link";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  Cell,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { KeyValue, Panel, Pill, Stat } from "@/components/ui/Card";
import { useEngineConfig } from "@/hooks/useEngineConfig";
import { freshness } from "@/lib/freshness";
import { stationLabel } from "@/lib/station";
import { COLORS, aqiColor, bandColor, grapColor, grapRank } from "@/lib/theme";
import type { StationListResponse, StationSummary, SystemStatus } from "@/types";

export interface NetworkFacts {
  withData: StationSummary[];
  minAqi: number | null;
  maxAqi: number | null;
  worstStation: StationSummary | null;
  worstStage: string | null;
  triggered: number;
  watch: number;
  normal: number;
}

/** One pass over the station list — every headline number comes from here. */
export function useNetworkFacts(data: StationListResponse | null): NetworkFacts {
  return useMemo(() => {
    const stations = data?.stations ?? [];
    const withData = stations.filter(
      (s) => s.has_data && s.aqi !== null && s.aqi !== undefined,
    );
    const values = withData.map((s) => s.aqi as number);
    const worstStation =
      withData.length > 0
        ? withData.reduce((worst, s) =>
            (s.aqi ?? -1) > (worst.aqi ?? -1) ? s : worst,
          )
        : null;
    const worstStage =
      withData.length > 0
        ? withData.reduce<string | null>(
            (worst, s) =>
              grapRank(s.grap_stage) > grapRank(worst) ? (s.grap_stage ?? null) : worst,
            null,
          )
        : null;

    return {
      withData,
      minAqi: values.length ? Math.min(...values) : null,
      maxAqi: values.length ? Math.max(...values) : null,
      worstStation,
      worstStage,
      triggered: stations.filter((s) => s.engine_mode === "TRIGGERED").length,
      watch: stations.filter((s) => s.engine_mode === "WATCH").length,
      normal: stations.filter((s) => s.engine_mode === "NORMAL").length,
    };
  }, [data]);
}

/** Summary column beside the national map. */
export function NationalSummaryPanel({
  facts,
  status,
  stations,
}: {
  facts: NetworkFacts;
  status: SystemStatus | null;
  stations: StationListResponse | null;
}) {
  const stale = status?.stale_stations ?? stations?.stale ?? 0;
  const aging = status?.aging_stations ?? stations?.aging ?? 0;
  const unavailable = status?.unavailable_stations ?? stations?.unavailable ?? 0;
  const current = status?.current_stations ?? stations?.current ?? 0;

  const top = [...facts.withData].sort((a, b) => (b.aqi ?? 0) - (a.aqi ?? 0)).slice(0, 4);

  return (
    <Panel title="National status" accent={COLORS.accent} className="h-full" padding="p-5">
      <div className="grid grid-cols-2 gap-5">
        <Stat
          label="AQI range"
          value={
            facts.minAqi === null || facts.maxAqi === null
              ? "Not available"
              : `${facts.minAqi} — ${facts.maxAqi}`
          }
          color={facts.maxAqi === null ? COLORS.dim : aqiColor(facts.maxAqi)}
          size={facts.minAqi === null ? "sm" : "md"}
          sub={`${facts.withData.length} stations reporting`}
        />
        <Stat
          label="Highest AQI"
          value={facts.maxAqi ?? "—"}
          color={aqiColor(facts.maxAqi)}
          size="lg"
          sub={
            facts.worstStation ? (
              <Link
                href={`/stations/${encodeURIComponent(facts.worstStation.station)}`}
                className="hover:text-aree-accent underline-offset-2 hover:underline"
              >
                {stationLabel(facts.worstStation.station)}
              </Link>
            ) : (
              "No station reporting"
            )
          }
        />
      </div>

      <div className="border-aree-border my-4 border-t" />

      <div className="grid grid-cols-2 gap-5">
        <Stat
          label="Highest GRAP stage"
          value={facts.worstStage ?? "Not available"}
          color={grapColor(facts.worstStage)}
          mono={false}
          size="md"
          sub="Worst active stage on the network"
        />
        <Stat
          label="Active escalations"
          value={stations ? facts.triggered : "—"}
          color={facts.triggered > 0 ? COLORS.red : COLORS.green}
          size="lg"
          sub={
            status
              ? `${status.escalations_recorded.toLocaleString()} recorded to date`
              : undefined
          }
        />
      </div>

      <div className="border-aree-border my-4 border-t" />

      <div className="aree-eyebrow mb-2.5">Data health</div>
      <div className="flex flex-wrap gap-2">
        <Pill color={freshness("current").color}>● {current} current</Pill>
        {aging > 0 ? <Pill color={freshness("aging").color}>◐ {aging} aging</Pill> : null}
        {stale > 0 ? (
          <Pill color={freshness("stale").color} filled>
            ⚠ {stale} stale
          </Pill>
        ) : null}
        {unavailable > 0 ? (
          <Pill color={freshness("unavailable").color}>× {unavailable} unavailable</Pill>
        ) : null}
      </div>
      <p className="text-aree-dim mt-3 text-[11px] leading-relaxed">
        Freshness describes the upstream feed, not the regulatory verdict. A station can
        be within limits and still be reporting a reading hours old.
      </p>

      <div className="border-aree-border my-4 border-t" />

      <div className="aree-eyebrow mb-1">Most affected nodes</div>
      {top.length === 0 ? (
        <div className="text-aree-muted text-[12px]">No station is reporting an AQI yet.</div>
      ) : (
        top.map((station) => {
          const look = freshness(station.freshness_status);
          return (
            <KeyValue
              key={station.station}
              label={
                <Link
                  href={`/stations/${encodeURIComponent(station.station)}`}
                  className="text-aree-body hover:text-aree-accent block truncate transition-colors"
                  title={station.station}
                >
                  <span style={{ color: look.color }} aria-hidden>
                    {look.marker}
                  </span>{" "}
                  {stationLabel(station.station)}
                </Link>
              }
              value={station.aqi}
              color={aqiColor(station.aqi)}
            />
          );
        })
      )}
    </Panel>
  );
}

/**
 * Regulatory state and data freshness, deliberately shown as two separate
 * groups — the same station can be "within limits" and "stale" at once.
 */
export function NetworkSummaryCards({
  facts,
  status,
  stations,
}: {
  facts: NetworkFacts;
  status: SystemStatus | null;
  stations: StationListResponse | null;
}) {
  // A missing payload is unknown, not zero.
  const known = Boolean(stations);
  const dash = (value: number) => (known ? value : "—");
  const active = stations?.active ?? 0;
  const total = stations?.total ?? 0;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Regulatory state" accent={COLORS.blue} padding="p-5">
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat
            label="Active stations"
            value={known ? `${active} / ${total}` : "—"}
            color={COLORS.accent}
            sub="publishing an AQI"
          />
          <Stat
            label="Regulatory normal"
            value={dash(facts.normal)}
            color={COLORS.green}
            sub="within limits"
          />
          <Stat
            label="Watch"
            value={dash(facts.watch)}
            color={facts.watch > 0 ? COLORS.orange : COLORS.dim}
            sub="approaching threshold"
          />
          <Stat
            label="Triggered"
            value={dash(facts.triggered)}
            color={facts.triggered > 0 ? COLORS.red : COLORS.dim}
            sub="escalation active"
          />
        </div>
        <p className="text-aree-dim mt-4 text-[11px]">
          Regulatory state is the engine verdict on AQI and persistence. It says nothing
          about how old the reading is.
        </p>
      </Panel>

      <Panel title="Data freshness" accent={COLORS.orange} padding="p-5">
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat
            label="Current"
            value={status || stations ? (status?.current_stations ?? stations?.current ?? 0) : "—"}
            color={freshness("current").color}
            sub="0–90 min"
          />
          <Stat
            label="Aging"
            value={status || stations ? (status?.aging_stations ?? stations?.aging ?? 0) : "—"}
            color={freshness("aging").color}
            sub="90–120 min"
          />
          <Stat
            label="Stale"
            value={status || stations ? (status?.stale_stations ?? stations?.stale ?? 0) : "—"}
            color={freshness("stale").color}
            sub="over 120 min"
          />
          <Stat
            label="Unavailable"
            value={
              status || stations
                ? (status?.unavailable_stations ?? stations?.unavailable ?? 0)
                : "—"
            }
            color={freshness("unavailable").color}
            sub="no usable AQI"
          />
        </div>
        <p className="text-aree-dim mt-4 text-[11px]">
          Upstream condition of the WAQI feed, classified by the backend. Decisions taken
          on stale readings use the last published value.
        </p>
      </Panel>
    </div>
  );
}

/** Distribution of reporting stations across the CPCB bands. */
export function AQIDistribution({ facts }: { facts: NetworkFacts }) {
  const config = useEngineConfig();

  const rows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const station of facts.withData) {
      const band = station.cpcb_band ?? "Unclassified";
      counts.set(band, (counts.get(band) ?? 0) + 1);
    }

    // Canonical band order comes from the engine config when available.
    const order = config.data?.cpcb_bands?.map((b) => b.label) ?? [];
    const known = order.filter((label) => counts.has(label));
    const extra = [...counts.keys()].filter((label) => !order.includes(label));

    return [...known, ...extra].map((label) => ({
      band: label,
      stations: counts.get(label) ?? 0,
      color: bandColor(label),
    }));
  }, [facts.withData, config.data]);

  if (rows.length === 0) {
    return (
      <Panel title="AQI distribution" padding="p-5">
        <div className="text-aree-muted py-8 text-center text-[13px]">
          No station is reporting an AQI yet.
        </div>
      </Panel>
    );
  }

  return (
    <Panel title="AQI distribution" accent={COLORS.yellow} padding="p-4">
      <div className="h-52 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 18, right: 8, bottom: 4, left: -20 }}>
            <CartesianGrid stroke={COLORS.border} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="band"
              stroke={COLORS.dim}
              tick={{ fill: COLORS.muted, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: COLORS.border }}
              interval={0}
            />
            <YAxis
              allowDecimals={false}
              stroke={COLORS.dim}
              tick={{ fill: COLORS.muted, fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: COLORS.border }}
            />
            <Tooltip
              cursor={{ fill: "rgba(148,163,184,0.08)" }}
              contentStyle={{
                background: COLORS.card,
                border: `1px solid ${COLORS.border}`,
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: COLORS.muted }}
              itemStyle={{ color: COLORS.body }}
            />
            <Bar dataKey="stations" name="Stations" radius={[4, 4, 0, 0]}>
              <LabelList
                dataKey="stations"
                position="top"
                fill={COLORS.muted}
                fontSize={11}
              />
              {rows.map((row) => (
                <Cell key={row.band} fill={row.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="text-aree-dim mt-1 px-1 text-[11px]">
        {facts.withData.length} reporting stations grouped by the CPCB band the engine
        assigned to their last published AQI.
      </div>
    </Panel>
  );
}

/** Compact worst-stations list beside the distribution. */
export function WorstStations({ facts }: { facts: NetworkFacts }) {
  const top = useMemo(
    () =>
      [...facts.withData]
        .sort((a, b) => (b.aqi ?? 0) - (a.aqi ?? 0))
        .slice(0, 6),
    [facts.withData],
  );

  return (
    <Panel title="Worst reporting stations" accent={COLORS.red} padding="p-4">
      {top.length === 0 ? (
        <div className="text-aree-muted py-6 text-center text-[13px]">
          No station is reporting an AQI yet.
        </div>
      ) : (
        <div>
          {top.map((station) => {
            const look = freshness(station.freshness_status);
            return (
              <KeyValue
                key={station.station}
                label={
                  <Link
                    href={`/stations/${encodeURIComponent(station.station)}`}
                    className="hover:text-aree-accent text-aree-body transition-colors"
                  >
                    <span style={{ color: look.color }} aria-hidden>
                      {look.marker}
                    </span>{" "}
                    {stationLabel(station.station)}
                    <span className="text-aree-dim"> · {station.grap_stage ?? "—"}</span>
                  </Link>
                }
                value={station.aqi}
                color={aqiColor(station.aqi)}
              />
            );
          })}
        </div>
      )}
    </Panel>
  );
}
