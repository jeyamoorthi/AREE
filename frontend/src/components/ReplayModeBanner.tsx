"use client";

/* ==========================================================================
   You are not looking at now.

   WHY A BANNER WHEN A PILL ALREADY EXISTS
     The command bar swaps its live clock for a REPLAY pill, and the sidebar turns its
     status dot violet. Both are good, and both are chrome: small, in the corners, and
     exactly where a reader stops looking once they are concentrating on a number. The
     failure this guards against is not "the operator never noticed" — it is "the
     operator noticed twenty minutes ago and has since forgotten", which is why the
     signal has to sit in the reading path rather than beside it.

     So this is deliberately NOT a second pill. It says the thing the pill has no room
     for: that the figures below are a reconstruction, and that live actions are off.

   IT OWNS NO STATE
     Mode and moment both come from useOutlookMode, which is published from the
     backend payload's own `mode` and `as_of` at a single site in OutlookDataProvider.
     There is no second replay flag here, no URL parsing, and no clock: the timestamp
     shown is the instant the server resolved, not anything this file computed.
   ========================================================================== */

import { History } from "lucide-react";

import { useOutlookMode } from "@/components/providers/OutlookModeProvider";
import { istDateTime } from "@/lib/clock";

/* The replay violet, as already used by the command-bar pill, the sidebar indicator
   and both outlook provenance rows. Mirrored rather than re-chosen — a fifth shade
   of "this is history" would be a new colour system, which is the one thing the
   replay treatment must not become. */
const REPLAY = {
  ink: "var(--aree-violet)",
  border: "color-mix(in srgb, var(--aree-violet) 35%, transparent)",
  wash: "color-mix(in srgb, var(--aree-violet) 10%, transparent)",
};

export default function ReplayModeBanner() {
  const { mode, asOf } = useOutlookMode();

  // Live, or a page with no as_of of its own: nothing to say, nothing rendered.
  if (mode !== "replay") return null;

  const moment = istDateTime(asOf);

  return (
    <div
      /* A labelled region, not role="status": replay is a persistent condition for as
         long as the page is open, and an assertive announcement on every render would
         be noise. A screen reader meets it in document order, above the content it
         qualifies. */
      role="region"
      aria-label="Replay mode"
      className="border-b px-4 py-2 sm:px-6"
      style={{ background: REPLAY.wash, borderColor: REPLAY.border }}
    >
      <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11.5px]">
        {/* Icon and words both carry it; the violet is the third channel, not the
            only one. */}
        <span
          className="flex shrink-0 items-center gap-1.5 font-bold uppercase tracking-[0.12em]"
          style={{ color: REPLAY.ink }}
        >
          <History className="h-3.5 w-3.5" aria-hidden />
          Replay mode
        </span>

        <span className="text-aree-body">Historical reconstruction</span>

        {/* The moment the BACKEND resolved, formatted by the application's existing
            IST helper. Never Date.now(). Omitted entirely if there is no as_of, rather
            than filled with a plausible-looking one. */}
        {moment ? (
          <>
            <span style={{ color: REPLAY.border }} aria-hidden>
              ·
            </span>
            <span
              className="aree-num min-w-0 font-semibold break-words"
              style={{ color: REPLAY.ink }}
            >
              {moment}
            </span>
          </>
        ) : null}

        <span className="text-aree-muted">
          Live actions are disabled — this view cannot authorise a case.
        </span>
      </p>
    </div>
  );
}
