"use client";

/**
 * Application shell header.
 *
 * Left: identity. Right: the three facts an operator checks first — is the
 * stream live, how many nodes are reporting, and what time it is locally.
 * Below: the three primary destinations. Subsystems live inside them, not
 * as extra top-level tabs.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";

import { useSystemStatus } from "@/components/providers/LiveDataProvider";
import { istClock } from "@/lib/clock";

const NAV = [
  { href: "/", label: "National Overview" },
  { href: "/dashboard", label: "Command Center" },
  { href: "/reports", label: "Reports" },
];

export default function Header({ onOpenSearch }: { onOpenSearch?: () => void }) {
  const pathname = usePathname();
  const state = useSystemStatus();
  const status = state.data;

  const offline = Boolean(state.error) && !status;
  const engineDown = Boolean(status && !status.engine_loaded);
  const live = Boolean(status?.engine_loaded);

  const indicator = offline
    ? { color: "var(--aree-red)", label: "OFFLINE" }
    : engineDown
      ? { color: "var(--aree-yellow)", label: "ENGINE DOWN" }
      : { color: "var(--aree-green)", label: "LIVE" };

  const clock = istClock(status?.server_time);

  return (
    <header className="pt-4">
      <div className="border-aree-border relative overflow-hidden rounded-2xl border bg-[linear-gradient(120deg,#0a1220_0%,#0f1a2c_45%,#0a1220_100%)] shadow-[0_2px_20px_rgba(0,0,0,0.45)]">
        {/* Thin environmental accent line along the top edge. */}
        <div
          className="absolute inset-x-0 top-0 h-px"
          style={{
            background:
              "linear-gradient(90deg, transparent, rgba(56,189,248,0.55), rgba(45,212,191,0.35), transparent)",
          }}
          aria-hidden
        />

        <div className="flex flex-col gap-4 px-5 py-4 sm:px-7 md:flex-row md:items-center md:justify-between">
          <Link href="/" className="group flex items-center gap-4">
            <span
              className="border-aree-accent/40 text-aree-accent flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border bg-[rgba(56,189,248,0.07)] text-[15px] font-black tracking-[0.05em] transition-colors group-hover:border-[rgba(56,189,248,0.75)]"
              aria-hidden
            >
              AR
            </span>
            <span className="min-w-0">
              <span className="flex items-baseline gap-2.5">
                <span className="text-aree-text text-2xl leading-none font-black tracking-[0.16em]">
                  AREE
                </span>
                <span className="text-aree-muted hidden text-[10px] leading-tight font-semibold tracking-[0.13em] uppercase lg:block">
                  Autonomous Regulatory
                  <br />
                  Escalation Engine
                </span>
              </span>
              <span className="text-aree-dim mt-1.5 block text-[11px] tracking-[0.08em]">
                Environmental Intelligence Platform
              </span>
            </span>
          </Link>

          <div className="flex flex-wrap items-center gap-3">
            {onOpenSearch ? (
              <button
                type="button"
                onClick={onOpenSearch}
                className="border-aree-border text-aree-dim hover:border-aree-border-strong hover:text-aree-body bg-aree-bg-soft/60 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors"
                aria-label="Search stations, policies and events"
              >
                <Search className="h-3.5 w-3.5" aria-hidden />
                <span className="hidden sm:inline">Search station, policy, event…</span>
                <kbd className="border-aree-border text-aree-faint ml-1 hidden rounded border px-1.5 py-0.5 font-mono text-[10px] md:inline">
                  Ctrl K
                </kbd>
              </button>
            ) : null}

            <div
              className="border-aree-border bg-aree-bg-soft/60 flex items-center gap-4 rounded-lg border px-3.5 py-2"
              role="status"
              aria-live="polite"
            >
              <span className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${live ? "aree-live-dot" : "aree-blink"}`}
                  style={{ background: indicator.color }}
                  aria-hidden
                />
                <span
                  className="text-[11px] font-bold tracking-[0.14em]"
                  style={{ color: indicator.color }}
                >
                  {indicator.label}
                </span>
              </span>

              <span className="bg-aree-border h-4 w-px" aria-hidden />

              <span
                className="aree-num text-aree-body text-[11px] font-semibold tracking-[0.06em]"
                title="Stations reporting a usable AQI / stations configured"
              >
                {status
                  ? `${status.active_stations} / ${status.known_stations} ONLINE`
                  : "— / — ONLINE"}
              </span>

              <span className="bg-aree-border hidden h-4 w-px sm:block" aria-hidden />

              <span className="aree-num text-aree-muted hidden text-[11px] font-semibold sm:block">
                {clock ?? "—"}
              </span>
            </div>
          </div>
        </div>
      </div>

      <nav
        className="border-aree-border mt-3 flex gap-1 border-b"
        aria-label="Primary"
      >
        {NAV.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href) ||
                (item.href === "/dashboard" && pathname.startsWith("/stations"));
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={`-mb-px border-b-2 px-3.5 py-2.5 text-[11px] font-bold tracking-[0.12em] uppercase transition-colors sm:px-5 ${
                active
                  ? "border-aree-accent text-aree-accent"
                  : "text-aree-dim hover:text-aree-body border-transparent"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
