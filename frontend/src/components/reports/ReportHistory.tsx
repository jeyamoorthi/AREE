"use client";

/**
 * Reports generated on this browser.
 *
 * WHY THE HEADER SAYS "ON THIS BROWSER" AND WILL KEEP SAYING IT
 *   The rows live in localStorage, because there is nowhere else to put them yet —
 *   see the note at the top of lib/reportHistory and the README's own admission that
 *   durable storage is not built. A list of past regulatory documents that LOOKS
 *   like an audit trail and is in fact a browser cache is worse than no list, so the
 *   panel states what it is. Delete that line the day a real endpoint exists, and
 *   not before.
 *
 * WHAT "DOWNLOAD PDF" ACTUALLY DOES, AND WHY THE ROW SAYS SO
 *   It asks the engine for a report NOW. The engine generates from current state and
 *   holds no historical documents, so the file that comes back describes today, not
 *   the moment in the row. Presenting it as "download that report again" would hand
 *   an officer a document they believe is dated one way and is dated another. The
 *   snapshot in the row is the record of what was true then; View shows it.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { History, Trash2, X } from "lucide-react";

import ReportDownload from "@/components/ReportDownload";
import { IntelligencePanel, KeyValue } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { useReportHistory } from "@/hooks/useReportHistory";
import { istDateTime } from "@/lib/clock";
import { clearReportHistory, type ReportRecord } from "@/lib/reportHistory";
import { stationLabel } from "@/lib/station";
import { aqiColor, eriColor, grapColor, orDash } from "@/lib/theme";

/**
 * The stored snapshot, in full.
 *
 * Modal rather than an expanding row for the same reason CaseAuthorisation's
 * confirmation is one: it is a record being examined, and the rest of the page is
 * not what is being read while it is open. Focus is trapped and Escape closes, so
 * it behaves like the authorisation dialog the operator already knows.
 */
function RecordDialog({
  record,
  onClose,
}: {
  record: ReportRecord;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  /* Focus enters on the only control, and returns to whatever opened it — so a
     keyboard user is never dropped back at the top of the page. */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], select:not([disabled]), input:not([disabled])",
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 px-4 py-6 backdrop-blur-sm"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-[var(--aree-radius-lg)] border border-aree-border bg-aree-surface-1 shadow-[var(--aree-shadow-lg)]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-aree-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-[14px] font-bold tracking-tight text-aree-text">
              {stationLabel(record.station)}
            </h2>
            <p className="aree-num mt-0.5 text-[11.5px] text-aree-muted">
              {istDateTime(record.generatedAt) ?? record.generatedAt}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-[var(--aree-radius-sm)] p-1.5 text-aree-muted transition-colors hover:bg-aree-surface-3 hover:text-aree-text"
            aria-label="Close the report record"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="grid gap-0.5">
            <KeyValue label="Station key" value={record.station} />
            <KeyValue label="Report type" value={record.reportType} mono={false} />
            <KeyValue
              label="AQI at generation"
              value={record.aqi ?? "—"}
              color={aqiColor(record.aqi)}
            />
            <KeyValue
              label="Risk category"
              value={orDash(record.riskCategory)}
              color={record.eriScore !== null ? eriColor(record.eriScore) : undefined}
              mono={false}
            />
            <KeyValue label="ERI score" value={record.eriScore ?? "—"} />
            <KeyValue
              label="GRAP stage"
              value={orDash(record.grapStage)}
              color={grapColor(record.grapStage)}
              mono={false}
            />
            <KeyValue label="Record id" value={record.id} />
          </div>

          <p className="mt-4 text-[11.5px] leading-relaxed text-aree-muted">
            These are the conditions recorded when the report was generated. They are a
            snapshot and are never refreshed — the station&rsquo;s live state has moved on
            since, and the station page is where to read it.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function ReportHistory() {
  const history = useReportHistory();
  const [viewing, setViewing] = useState<ReportRecord | null>(null);

  if (history.length === 0) {
    return (
      <EmptyState icon={<History className="h-5 w-5" />}>
        No reports generated yet on this browser. Select a station above and generate
        one, and it will be listed here.
      </EmptyState>
    );
  }

  return (
    <>
      <IntelligencePanel
        title="Generated reports"
        subtitle="Stored in this browser only — not an audit trail, and not shared between devices."
        padding="p-0"
        headerAction={
          <button
            type="button"
            onClick={() => clearReportHistory()}
            className="flex items-center gap-1.5 rounded-[var(--aree-radius-sm)] border border-aree-border px-2.5 py-1.5 text-[11.5px] font-semibold text-aree-muted transition-colors hover:border-aree-border-strong hover:text-aree-body"
            aria-label={`Clear all ${history.length} report records from this browser`}
          >
            <Trash2 className="h-3 w-3" aria-hidden />
            Clear history
          </button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] border-collapse text-left text-sm">
            <caption className="sr-only">
              Reports generated on this browser, most recent first: date and time in
              IST, station, AQI, risk category and GRAP stage at the moment of
              generation, with actions to view the record or generate a fresh report.
            </caption>
            <thead>
              <tr className="border-b border-aree-border bg-aree-surface-2">
                {["Date / time (IST)", "Station", "AQI", "Risk", "GRAP stage", "Actions"].map(
                  (heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className="px-4 py-3 text-[10px] font-bold tracking-wider text-aree-muted uppercase"
                    >
                      {heading}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-aree-border">
              {history.map((record) => (
                <tr key={record.id} className="transition-colors hover:bg-aree-surface-2">
                  <td className="aree-num px-4 py-3 text-[11.5px] whitespace-nowrap text-aree-body">
                    {istDateTime(record.generatedAt) ?? record.generatedAt}
                  </td>
                  <td className="px-4 py-3 text-[12.5px] font-semibold text-aree-text">
                    {stationLabel(record.station)}
                  </td>
                  <td
                    className="aree-num px-4 py-3 text-[13px] font-bold"
                    style={{ color: aqiColor(record.aqi) }}
                  >
                    {record.aqi ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-[12px] font-semibold">
                    {/* Coloured from the SCORE, never from the words: eriColor
                        thresholds the number the engine banded, and reading a colour
                        out of "PRE-ESCALATION" would be a second classifier. */}
                    <span
                      style={
                        record.eriScore !== null
                          ? { color: eriColor(record.eriScore) }
                          : undefined
                      }
                    >
                      {orDash(record.riskCategory)}
                    </span>
                    {record.eriScore !== null ? (
                      <span className="aree-num ml-1.5 text-[11px] font-normal text-aree-dim">
                        {record.eriScore}
                      </span>
                    ) : null}
                  </td>
                  <td
                    className="px-4 py-3 text-[12px] font-semibold"
                    style={{ color: grapColor(record.grapStage) }}
                  >
                    {orDash(record.grapStage)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setViewing(record)}
                        className="rounded-[var(--aree-radius-sm)] border border-aree-border px-2.5 py-1.5 text-[11.5px] font-semibold text-aree-body transition-colors hover:border-aree-border-strong hover:text-aree-accent"
                        aria-label={`View the report record for ${stationLabel(record.station)} generated at ${
                          istDateTime(record.generatedAt) ?? record.generatedAt
                        }`}
                      >
                        View
                      </button>
                      {/* Ghost, and labelled for what it does: this asks the engine
                          for a report from CURRENT state, not for the file that was
                          downloaded then. */}
                      <ReportDownload
                        station={record.station}
                        variant="ghost"
                        label="Download PDF"
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </IntelligencePanel>

      {viewing ? (
        <RecordDialog record={viewing} onClose={() => setViewing(null)} />
      ) : null}
    </>
  );
}
