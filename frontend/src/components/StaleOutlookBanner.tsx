"use client";

/* ==========================================================================
   Says, above both Outlook tabs, that what is on screen is not the live answer.

   The workspace shows the last live outlook this browser saw while the backend
   wakes or restores its observation history (see lib/outlookCache). That is only
   honest if it is impossible to miss: when it was issued and how long ago this
   browser received it are the first things in the block, and the reason live is
   not on screen stays visible underneath.

   Issued (`generated_at`), not `as_of`: the live anchor trails the clock by the
   publication delay, so "06:30" beside a forecast issued at 09:30 reads as three
   hours staler than it is.

   Ticks once a minute so "12 min ago" does not freeze while the reader waits.
   ========================================================================== */

import { useEffect, useState } from "react";

import type { StaleOutlook } from "@/components/providers/OutlookDataProvider";

function istHour(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min ago`;
}

export default function StaleOutlookBanner({
  stale,
  issuedAt,
}: {
  stale: StaleOutlook;
  /** When the backend produced the cached outlook (`generated_at`). */
  issuedAt: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className="rounded-lg border px-4 py-3"
      style={{
        background: "color-mix(in srgb, var(--aree-amber) 9%, transparent)",
        borderColor: "color-mix(in srgb, var(--aree-amber) 40%, transparent)",
      }}
      role="status"
      aria-live="polite"
    >
      <p className="text-[12.5px] font-bold" style={{ color: "var(--aree-text)" }}>
        Showing the last live forecast — issued {istHour(issuedAt)} IST, received{" "}
        {ago(now - stale.savedAt)}
      </p>
      <p className="mt-1 max-w-[80ch] text-[12px] leading-snug" style={{ color: "var(--aree-body)" }}>
        {stale.failed
          ? "The live backend is restarting and restoring its observation history. "
          : "The live backend is waking up. "}
        This page replaces the forecast below as soon as it answers, and case
        authorisation is held until then.
      </p>
      {stale.failed && (
        <p className="mt-2 font-mono text-[10.5px] leading-snug" style={{ color: "var(--aree-dim)" }}>
          {stale.reason}
        </p>
      )}
    </div>
  );
}
