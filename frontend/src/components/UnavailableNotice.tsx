"use client";

/* ==========================================================================
   AREE — the one failure block for screens that depend on the live engine.

   WHY THIS IS NOT JUST A RED BOX WITH THE ERROR TEXT IN IT

     For the first seconds of a backend's life the engine is running and has no
     data yet. Measured on a cold boot: /api/health answers 200 at t+1 s and the
     station table does not exist until t+13 s. Every data route answers with
     nothing in between, and both outlook screens rendered exactly the same red
     "unavailable" panel they show when something is genuinely broken.

     A viewer — on a demo, in front of judges — cannot tell a system that is
     starting from a system that has failed, and the panel told them it was the
     second one. That is the most misleading thing a warming-up system can do,
     and it is a presentation bug with a one-line backend cause.

     /api/ready answers the question directly: "warming_up" while the first
     sampling cycle is in flight, "ready" once the station table exists,
     "unavailable" when the engine did not start at all. This component asks it
     and picks the honest message.

   WHAT IT DELIBERATELY DOES NOT DO

     It does not suppress the error. When the engine IS ready and the screen
     still could not load, the original detail is shown unchanged — that is a
     real failure (a gap in the observation store, say) and dressing it up as
     "warming up" would be the same lie told in the other direction.

     It also does not retry the caller's request. The screens already poll; this
     panel only describes what is happening while they do.
   ========================================================================== */

import { useEffect, useState } from "react";

import { api } from "@/lib/api";
import type { CaptureStatus, ReadinessResponse } from "@/types";

/* Three seconds, and only while this panel is mounted — which is only ever
   while something has already failed. A warm-up lasts about thirteen, so this
   catches the recovery within one tick of it happening without adding a poll
   to the normal, working case. */
const READY_POLL_MS = 3000;

const C = {
  body: "#44403a",
  muted: "#7d776c",
  redInk: "#b91c1c",
  redBg: "#fdf2f0",
  redLine: "#f0d5cd",
  amberInk: "#8a6d1f",
  amberBg: "#fdf8ec",
  amberLine: "#f0e6c8",
};

export default function UnavailableNotice({
  title,
  detail,
}: {
  /** What failed, in the caller's own words: "Outlook unavailable". */
  title: string;
  /** The error the caller received. Always shown, in one place or another. */
  detail: string;
}) {
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);
  const [capture, setCapture] = useState<CaptureStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;

    const run = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      // Both, together. They answer different questions and the second one is
      // the one that is usually true here — see `restoring` below.
      const [ready, cap] = await Promise.allSettled([
        api.readiness(signal),
        api.capture(signal),
      ]);
      if (cancelled) return;
      if (ready.status === "fulfilled") setReadiness(ready.value);
      if (cap.status === "fulfilled") setCapture(cap.value);
      /* A rejection is not worth a second error message: the caller already
         handed us one to show, and an unreachable backend is what it is about. */
    };

    void run();
    const timer = window.setInterval(run, READY_POLL_MS);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, []);

  const warming = readiness?.state === "warming_up";
  const engineDown = readiness?.state === "unavailable";

  /* THE CASE THIS COMPONENT WAS MISSING.
   *
   * After a redeploy the engine reaches `ready` in about ten seconds — it has a
   * station table, so /api/ready is green and honestly so. But the OBSERVATION
   * STORE can still be missing the hours the forecast needs, and rebuilding
   * them takes a couple of minutes on a store that lost a whole day.
   *
   * Measured on the deployed instance: /api/ready said ready with 73 stations
   * while /api/system/capture said holes=30, continuous=false. The outlook
   * correctly answered 424 for that window, and this panel rendered it in red
   * as an error — which is what a viewer saw, and it was not one. The backend
   * was repairing itself and did, two and a half minutes later.
   *
   * So a store that is not continuous is a warm-up, not a failure. */
  const restoring = capture?.continuous === false && capture?.running === true;

  if (warming || restoring) {
    const holes = capture?.holes ?? 0;
    return (
      <div
        className="rounded-lg border p-4"
        style={{ background: C.amberBg, borderColor: C.amberLine }}
      >
        <p className="text-[12.5px] font-bold" style={{ color: C.amberInk }}>
          {restoring && !warming
            ? "Restoring observation history"
            : "Backend is warming up"}
        </p>
        <p className="mt-1 text-[12px]" style={{ color: C.body }}>
          {restoring && !warming ? (
            <>
              The forecast needs a continuous record of recent observations, and{" "}
              {holes > 0 ? `${holes} hour${holes === 1 ? "" : "s"} are` : "some hours are"}{" "}
              being restored from archive. This usually takes a minute or two
              after a restart, and the page will load as soon as it completes.
            </>
          ) : (
            <>
              {readiness?.detail ??
                "The engine is running and its first sampling cycle has not completed."}{" "}
              This page will load as soon as the first cycle lands.
            </>
          )}
        </p>
        {/* The underlying error stays visible, quietly. Hiding it entirely
            would leave nothing to report if the warm-up never finishes. */}
        <p className="mt-2 text-[11px]" style={{ color: C.muted }}>
          {detail}
        </p>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border p-4"
      style={{ background: C.redBg, borderColor: C.redLine }}
    >
      <p className="text-[12.5px] font-bold" style={{ color: C.redInk }}>
        {engineDown ? "Live engine is not running" : title}
      </p>
      <p className="mt-1 text-[12px]" style={{ color: C.body }}>
        {engineDown ? (readiness?.detail ?? detail) : detail}
      </p>
      {engineDown && (
        <p className="mt-2 text-[11px]" style={{ color: C.muted }}>
          {detail}
        </p>
      )}
    </div>
  );
}
