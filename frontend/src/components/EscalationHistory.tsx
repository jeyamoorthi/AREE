"use client";

/**
 * The decision log.
 *
 * WHAT IT MERGES, AND WHY THE TWO HALVES ARE DIFFERENT RECORDS
 *   The engine and the authority write to different tables, and the difference is
 *   the product. /api/escalations holds what the STATE MACHINE did — a GRAP stage
 *   transition, with no human in it. /api/cases holds what a PERSON decided about a
 *   recommendation: approved or rejected, by whom, and on what grounds.
 *
 *   Read separately, neither answers "was this escalation acted on". Interleaved by
 *   time they do, which is the whole point of an audit trail.
 *
 * WHY DECISIONS ARE OPT-IN
 *   A case is raised for the NCR airshed — it carries a `jurisdiction`, not a station.
 *   Dropping those rows into one station's timeline would put an airshed-wide decision
 *   under a single monitor, so the decision half is enabled only where the timeline is
 *   not filtered to a station. The existing station call site therefore issues exactly
 *   the requests it did before.
 *
 * WHY THE REASON IS FETCHED ON DEMAND
 *   The reason IS persisted — in the case's action history. It is deliberately absent
 *   from the listing, which case_store calls "a queue, not a record". Fetching every
 *   case's record up front to fill a column would be an N+1 on a view that mostly is
 *   not read; claiming "Reason not recorded" because the listing omitted it would be
 *   worse, because it is false. So the entry offers to fetch its own record, once, and
 *   "Reason not recorded" is printed only when the record itself has none.
 *
 *   Events are only ever those the backend actually recorded — when there are none,
 *   the component says so plainly instead of inventing a plausible history.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  History,
  TrendingUp,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import { usePolling } from "@/hooks/usePolling";
import { api, errorMessage } from "@/lib/api";
import { istDateTime } from "@/lib/clock";
import { stationLabel } from "@/lib/station";
import { COLORS, aqiColor, grapColor, orDash } from "@/lib/theme";
import type { CaseRecord, CasesResponse, EscalationsResponse } from "@/types";
import { Panel, Pill, TimelineEvent } from "./ui/Card";
import { EmptyState, SectionState } from "./ui/States";

/** A case decision, or an engine transition. One stream, two record types. */
type LogEntry =
  | { kind: "escalation"; at: string | null; order: number; event: EscalationsResponse["events"][number] }
  | { kind: "case"; at: string | null; order: number; row: CasesResponse["cases"][number] };

/** Colour and wording for a case status. Tokens only — no new palette. */
function caseLook(status: string | null) {
  if (status === "APPROVED") {
    return { colour: COLORS.green, word: "Approved by authority", Icon: CheckCircle2 };
  }
  if (status === "REJECTED") {
    return { colour: COLORS.red, word: "Rejected by authority", Icon: XCircle };
  }
  return { colour: COLORS.amber, word: "Awaiting authority approval", Icon: ShieldCheck };
}

export default function EscalationHistory({
  station,
  limit = 8,
  title = "Escalation timeline",
  showDecisions = false,
}: {
  station?: string;
  limit?: number;
  title?: string;
  /**
   * Interleave authority decisions from /api/cases.
   *
   * Off by default, and meaningless with `station` set: cases are raised for the
   * airshed, so they cannot be attributed to one monitor. Leaving it off keeps the
   * station timeline's request count exactly as it was.
   */
  showDecisions?: boolean;
}) {
  const state = usePolling<EscalationsResponse>(
    (signal) => api.escalations(station, signal),
    { intervalMs: 15000, deps: [station] },
  );

  /* THE CASE LISTING IS FETCHED ONCE, NOT POLLED.
     Deliberately not usePolling. A recurring request is how the escalation half works
     because the state machine writes to it continuously and unattended; the case queue
     does not behave that way. A case changes only when a person decides one, and the
     person who decides is on the Outlook page, not looking at this log. A second
     interval would therefore have been a standing cost paid for an event that cannot
     happen while the view is open.

     The trade is honest and small: the log is current as of the moment it was opened,
     and returning to Command Center — a remount — fetches it again. */
  const wantDecisions = showDecisions && !station;
  const [decisions, setDecisions] = useState<CasesResponse | null>(null);
  const [decisionsError, setDecisionsError] = useState<string | null>(null);

  useEffect(() => {
    if (!wantDecisions) return;
    const controller = new AbortController();
    let cancelled = false;
    void api
      .cases(undefined, controller.signal)
      .then((result) => {
        if (!cancelled) setDecisions(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setDecisionsError(errorMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [wantDecisions]);

  /* Reasons, fetched one case at a time and only when asked for. */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [records, setRecords] = useState<Record<string, CaseRecord>>({});
  const [loadingCase, setLoadingCase] = useState<string | null>(null);
  const [caseError, setCaseError] = useState<Record<string, string>>({});

  const toggleCase = useCallback(
    (caseId: string) => {
      setExpanded((current) => (current === caseId ? null : caseId));
      // Already held, or already in flight: never refetch a record for a re-open.
      if (records[caseId] || loadingCase === caseId) return;
      setLoadingCase(caseId);
      void api
        .case(caseId)
        .then((record) => {
          setRecords((prev) => ({ ...prev, [caseId]: record }));
          setCaseError((prev) => {
            const next = { ...prev };
            delete next[caseId];
            return next;
          });
        })
        .catch((err: unknown) => {
          setCaseError((prev) => ({ ...prev, [caseId]: errorMessage(err) }));
        })
        .finally(() => setLoadingCase((current) => (current === caseId ? null : current)));
    },
    [records, loadingCase],
  );

  /* ONE ORDERED STREAM.
     A case is placed at the moment it was DECIDED where a decision exists, and at the
     moment it was OPENED where it is still awaiting one — that is the instant each row
     actually describes. Both timestamps come from the record; nothing is derived from
     the browser clock.

     Ties keep backend order: `order` is the index within each source list, and the
     comparator falls back to it, so two records written in the same second stay in the
     sequence the server returned them (cases arrive `ORDER BY created_at DESC`). */
  const merged = useMemo<LogEntry[]>(() => {
    const escalationEntries: LogEntry[] = (state.data?.events ?? []).map(
      (event, index) => ({ kind: "escalation", at: event.timestamp, order: index, event }),
    );
    // Read inside the memo: `?? []` at the top level would mint a new array on every
    // render and the memo would never hold.
    const caseEntries: LogEntry[] = (decisions?.cases ?? []).map((row, index) => ({
      kind: "case",
      at: row.decided_at ?? row.created_at,
      order: index,
      row,
    }));

    return [...escalationEntries, ...caseEntries].sort((a, b) => {
      const ta = a.at ? Date.parse(a.at) : Number.NaN;
      const tb = b.at ? Date.parse(b.at) : Number.NaN;
      // A record with no usable timestamp sinks rather than jumping to the top.
      if (Number.isNaN(ta) && Number.isNaN(tb)) return a.order - b.order;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      if (tb !== ta) return tb - ta; // newest first
      return a.order - b.order;
    });
  }, [state.data, decisions]);

  return (
    <SectionState state={state} skeletonRows={3} loadingLabel="Loading event history…">
      {(data) => {
        if (merged.length === 0) {
          return (
            <EmptyState icon={<History className="h-5 w-5" />}>
              No {showDecisions ? "decisions or escalation events" : "escalation events"}{" "}
              recorded{station ? " for this station" : ""}. The timeline fills in when the
              state machine records a GRAP transition
              {showDecisions ? " or an authority decides a case" : ""}.
            </EmptyState>
          );
        }

        const entries = merged.slice(0, limit);
        const totalRecorded = data.total + (decisions?.total ?? 0);

        return (
          <Panel
            title={title}
            icon={<History className="h-4 w-4" />}
            accent="var(--aree-red)"
            padding="p-4 sm:p-6"
            right={
              <span className="text-aree-dim text-[12px] font-medium bg-aree-surface-2 px-2.5 py-1 rounded-full border border-aree-border">
                {totalRecorded} recorded
              </span>
            }
          >
            {/* A failed case listing is reported, never allowed to look like an
                absence of decisions. The escalation half still renders. */}
            {decisionsError ? (
              <p
                className="mb-3 rounded-md border border-aree-border bg-aree-surface-2 px-3 py-2 text-[12px]"
                style={{ color: COLORS.amber }}
              >
                Authority decisions could not be loaded — {decisionsError}. Engine
                escalations below are unaffected.
              </p>
            ) : null}

            <div className="relative">
              {/* Continuous vertical line for the timeline */}
              <div className="absolute top-4 bottom-4 left-4 w-0.5 bg-aree-border rounded-full" aria-hidden />
              
              <div className="flex flex-col gap-1 relative">
                {entries.map((entry, index) => {
                  const isLast = index === entries.length - 1;

                  if (entry.kind === "case") {
                    return (
                      <CaseEntry
                        key={`case-${entry.row.case_id}`}
                        row={entry.row}
                        at={entry.at}
                        isLast={isLast}
                        expanded={expanded === entry.row.case_id}
                        record={records[entry.row.case_id]}
                        loading={loadingCase === entry.row.case_id}
                        error={caseError[entry.row.case_id]}
                        onToggle={() => toggleCase(entry.row.case_id)}
                      />
                    );
                  }

                  const event = entry.event;

                  return (
                    <TimelineEvent
                      key={`esc-${event.timestamp}-${event.city}-${index}`}
                      icon={<TrendingUp className="h-4 w-4" />}
                      iconColor={grapColor(event.to_stage)}
                      /* IST, through the existing helper — the raw value is kept as a
                         fallback for a timestamp the formatter cannot parse. */
                      timestamp={istDateTime(event.timestamp) ?? orDash(event.timestamp)}
                      isLast={isLast}
                    >
                      <div className="flex flex-col gap-1.5">
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          {station ? null : (
                            <Link
                              href={`/stations/${encodeURIComponent(event.city ?? "")}`}
                              className="text-aree-text hover:text-aree-accent text-[14px] font-bold transition-colors"
                            >
                              {stationLabel(event.city)}
                            </Link>
                          )}
                        </div>
                        
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-aree-muted text-[13px] font-medium bg-aree-surface-2 px-2 py-0.5 rounded">
                            {orDash(event.from_stage, "—")}
                          </span>
                          <ArrowRight className="text-aree-faint h-3.5 w-3.5" aria-hidden />
                          <Pill color={grapColor(event.to_stage)} filled>
                            {orDash(event.to_stage)}
                          </Pill>
                          
                          {event.aqi !== null && event.aqi !== undefined ? (
                            <div className="ml-2 flex items-center gap-1.5 border-l border-aree-border pl-3">
                              <span className="text-aree-muted text-[12px] uppercase tracking-wider font-semibold">
                                AQI
                              </span>
                              <span
                                className="aree-num font-bold text-[14px]"
                                style={{ color: aqiColor(event.aqi) }}
                              >
                                {event.aqi}
                              </span>
                              {event.band ? (
                                <span className="text-aree-dim text-[12px] bg-aree-surface-2 px-1.5 py-0.5 rounded border border-aree-border/50">
                                  {event.band}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                        
                        {event.trigger ? (
                          <div className="text-aree-dim mt-1 text-[13px] leading-relaxed flex items-start gap-1.5 bg-aree-surface-1 p-2 rounded-md border border-aree-border/50">
                            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            <span>{event.trigger}</span>
                          </div>
                        ) : null}
                      </div>
                    </TimelineEvent>
                  );
                })}
              </div>
            </div>

            {merged.length > limit ? (
              <div className="text-aree-dim border-aree-border mt-4 border-t pt-4 text-center text-[12px] font-medium">
                Showing {limit} most recent of {totalRecorded} records
              </div>
            ) : null}
          </Panel>
        );
      }}
    </SectionState>
  );
}

/**
 * One authority decision.
 *
 * Everything on the collapsed row comes from the case LISTING. The grounds live in
 * the case record and are pulled in only when this row is opened, so a log nobody
 * expands costs one request in total rather than one per case.
 */
function CaseEntry({
  row,
  at,
  isLast,
  expanded,
  record,
  loading,
  error,
  onToggle,
}: {
  row: CasesResponse["cases"][number];
  at: string | null;
  isLast: boolean;
  expanded: boolean;
  record?: CaseRecord;
  loading: boolean;
  error?: string;
  onToggle: () => void;
}) {
  const look = caseLook(row.status);
  const decided = row.status === "APPROVED" || row.status === "REJECTED";

  /* The action that carries the grounds. Read from the fetched record only — never
     reconstructed from the listing, which does not have it. */
  const action = record?.actions?.find(
    (a) => a.action === "APPROVED" || a.action === "REJECTED",
  );

  return (
    <TimelineEvent
      icon={<look.Icon className="h-4 w-4" />}
      iconColor={look.colour}
      timestamp={istDateTime(at) ?? orDash(at)}
      isLast={isLast}
    >
      <div className="flex flex-col gap-1.5">
        {/* The outcome is a word, not a hue. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14px] font-bold" style={{ color: look.colour }}>
            {look.word}
          </span>
          {row.priority ? (
            <Pill color={look.colour}>{row.priority}</Pill>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-aree-muted">
          {row.jurisdiction ? <span>{row.jurisdiction}</span> : null}
          {row.trigger ? (
            <span className="min-w-0 break-words">{row.trigger}</span>
          ) : null}
          {/* Actor is shown only when the record has one — never a placeholder name. */}
          {row.decided_by ? (
            <span className="text-aree-body font-semibold">by {row.decided_by}</span>
          ) : null}
          <span className="aree-num text-aree-faint">case {row.case_id}</span>
        </div>

        {decided ? (
          <div>
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className="flex items-center gap-1 text-[12px] font-semibold text-aree-muted transition-colors hover:text-aree-text"
            >
              <ChevronRight
                className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
                aria-hidden
              />
              {expanded ? "Hide grounds" : "Show grounds"}
              {loading ? (
                <Loader2 className="ml-1 h-3 w-3 animate-spin" aria-hidden />
              ) : null}
            </button>

            {expanded ? (
              <div className="mt-1.5 rounded-md border border-aree-border bg-aree-surface-2 p-2.5">
                {loading ? (
                  <p className="text-[12px] text-aree-muted">Loading the case record…</p>
                ) : error ? (
                  /* A failed fetch is reported as a failure. It must never be
                     collapsed into "Reason not recorded", which asserts something
                     about the record that has not been established. */
                  <p className="text-[12px] font-semibold" style={{ color: COLORS.red }}>
                    Could not load the case record — {error}
                  </p>
                ) : action ? (
                  <>
                    {/* Verbatim, and wrapped rather than truncated: an audit trail
                        that hides half a reason is not one. */}
                    <p className="text-[12.5px] leading-snug text-aree-body break-words">
                      {action.reason ? `“${action.reason}”` : "Reason not recorded"}
                    </p>
                    <p className="mt-1.5 text-[11px] text-aree-dim">
                      {istDateTime(action.timestamp) ?? action.timestamp}
                      {action.actor ? ` · ${action.actor}` : ""}
                      {action.actor_role ? ` (${action.actor_role})` : ""}
                      {action.actor_verified === false
                        ? " · identity self-declared, not authenticated"
                        : ""}
                    </p>
                  </>
                ) : (
                  <p className="text-[12px] text-aree-muted">
                    No decision action is present on this case record.
                  </p>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </TimelineEvent>
  );
}
