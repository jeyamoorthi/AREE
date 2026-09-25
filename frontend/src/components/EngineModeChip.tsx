"use client";

/* ==========================================================================
   Which engine is actually running.

   WHY IT IS WORTH A CHIP
     AREE runs two different engines. The Pathway streaming pipeline is the one the
     architecture is written about; the direct engine is the one that actually runs
     when Pathway will not start, and in that mode event-time windowing and policy
     retrieval are simply absent. An operator reading a GRAP stage has no way to tell
     which of those produced it — the fact was published, but only as one clause in a
     five-part footer at the bottom of the page, in ten-pixel uppercase.

   WHICH "ENGINE MODE" THIS IS
     `SystemStatus.mode` — "streaming" or "direct" — a property of the SYSTEM. Not
     `EngineMode` from types/index.ts, which is "TRIGGERED | WATCH | NORMAL" and is a
     property of one STATION's regulatory state. The two are unrelated despite the
     name, and the station one is already carried by the critical-alert banner.

   IT IS NOT THE REPLAY INDICATOR
     Replay asks "is this page describing now"; this asks "what is the server doing".
     A replayed page is still served by a live engine, so the chip keeps reporting it
     and never relabels itself from the replay state. The two stay separate, sourced
     from separate contracts.

   ONE MAPPING, BORROWED
     offline -> streaming -> direct is exactly how DataHealthOverviewCard and the
     application footer already resolve this. Copying the rule rather than inventing a
     second one is the point: two mappings would eventually disagree about what the
     same server is doing.
   ========================================================================== */

import { Cpu } from "lucide-react";

import { useSystemStatus } from "@/components/providers/LiveDataProvider";

export default function EngineModeChip() {
  const { data: status } = useSystemStatus();

  /* NOTHING until the first poll answers.
     This used to render a grey "Unknown" chip, on the reasoning that an honest
     "Unknown" beats a plausible-looking wrong mode. That was half right: the wrong
     mode is worse, but "Unknown" is still the application publishing its own
     uncertainty to an authority as though it were a finding about the engine. The
     chip is chrome; a header with one less chip in it for a few hundred milliseconds
     costs nothing, and asserts nothing. */
  if (!status) return null;

  const engine = !status.engine_loaded
      ? {
          label: "Offline",
          colour: "var(--aree-red)",
          detail: status.engine_error ?? "The engine is not loaded",
        }
      : status.mode === "streaming"
        ? {
            label: "Streaming",
            colour: "var(--aree-green)",
            detail: "Pathway streaming engine",
          }
        : {
            label: "Direct",
            colour: "var(--aree-yellow)",
            detail:
              "Direct engine — event-time windowing and policy retrieval are unavailable",
          };

  /* Only when the running system actually says so. `degraded` is the backend's own
     flag for "subsystems are unavailable in this mode", and rag_status is what the
     footer already reads to describe policy retrieval. */
  const policyOff = Boolean(status.engine_loaded && status.rag_status !== "active");

  return (
    <div
      className="flex shrink-0 items-center gap-2 rounded-lg border border-aree-border bg-aree-surface-1 px-2.5 py-1.5 text-xs shadow-2xs"
      /* Informational, not interactive: no role="button", nothing focusable, and no
         aria-live — the value changes on a five-second poll and announcing it each
         time would make the header unusable with a screen reader. The label below is
         what assistive technology reads, and it already contains the mode as text. */
      aria-label={`Engine mode: ${engine.label}${policyOff ? ", policy retrieval off" : ""}`}
      title={engine.detail}
    >
      <Cpu className="h-3.5 w-3.5 shrink-0 text-aree-dim" aria-hidden />
      {/* The eyebrow is what gets dropped when space is tight; the MODE never is, so
          the chip is legible without colour at every width. */}
      <span className="hidden text-[10px] font-bold uppercase tracking-wider text-aree-dim sm:inline">
        Engine
      </span>
      <span
        className="text-[11px] font-bold uppercase tracking-wider"
        style={{ color: engine.colour }}
      >
        {engine.label}
      </span>

      {policyOff ? (
        <>
          <span className="hidden h-3.5 w-px bg-aree-border lg:block" aria-hidden />
          {/* Secondary and muted — a caveat about the mode, not a second status. */}
          <span className="hidden text-[10px] font-medium text-aree-dim lg:inline">
            Policy retrieval off
          </span>
        </>
      ) : null}
    </div>
  );
}
