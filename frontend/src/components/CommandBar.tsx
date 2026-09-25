"use client";

/**
 * AREE CommandBar Component
 * Top navigation and system telemetric control bar for the AREE command center.
 */

import Link from "next/link";
import {
  Clock,
  History,
  Menu,
  Moon,
  Search,
  Sun,
} from "lucide-react";

import AreeLogo from "@/components/brand/AreeLogo";
import EngineModeChip from "@/components/EngineModeChip";
import { useSystemStatus } from "@/components/providers/LiveDataProvider";
import { useOutlookMode } from "@/components/providers/OutlookModeProvider";
import { useTheme } from "@/components/providers/ThemeProvider";
import { istClock, istDateTime } from "@/lib/clock";

/**
 * Light / dark switch.
 *
 * The icon shows the mode the button will GIVE you, not the one you are in — a sun
 * to go light, a moon to go dark — which is the convention every operating system
 * uses and the only one that survives being looked at without reading the tooltip.
 *
 * Nothing is drawn until the provider has adopted the stored preference: the server
 * renders the light markup because it cannot know the preference, so committing to
 * an icon before hydration means rendering the wrong one and then flipping it.
 */
function ThemeToggle() {
  const { theme, mounted, toggleTheme } = useTheme();
  const dark = theme === "dark";

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-aree-border bg-aree-surface-1 text-aree-muted shadow-2xs transition-colors hover:bg-aree-surface-2 hover:text-aree-text cursor-pointer"
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      title={dark ? "Switch to light theme" : "Switch to dark theme"}
      aria-pressed={mounted ? dark : undefined}
    >
      {!mounted ? null : dark ? (
        <Sun className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Moon className="h-4 w-4" aria-hidden="true" />
      )}
    </button>
  );
}

interface CommandBarProps {
  onOpenSearch?: () => void;
  onOpenMobile?: () => void;
}

export default function CommandBar({
  onOpenSearch,
  onOpenMobile,
}: CommandBarProps) {
  const statusState = useSystemStatus();
  const status = statusState.data;
  const { mode: pageMode, asOf } = useOutlookMode();

  const offline = Boolean(statusState.error) && !status;
  const engineDown = Boolean(status && !status.engine_loaded);
  const live = Boolean(status?.engine_loaded);

  /* Nothing is known yet: no status, and no error either. The dot and its word are
     omitted until one of the two arrives. The counts and the clock beside them
     already render their own "—", which states absence without asserting health. */
  const stateKnown = Boolean(status) || Boolean(statusState.error);

  const indicatorColor = offline
    ? "var(--aree-red)"
    : engineDown
      ? "var(--aree-yellow)"
      : "var(--aree-green)";

  const indicatorLabel = offline
    ? "OFFLINE"
    : engineDown
      ? "ENGINE DOWN"
      : "LIVE";

  const clock = istClock(status?.server_time);

  // The page may be reconstructing a past moment while the engine behind it is live.
  // That is a different question from "is the server up", and the header used to answer
  // only the second one — so a replay of November 2024 carried a green LIVE pill.
  const replayAt = pageMode === "replay" ? asOf : null;

  return (
    <header
      className="sticky top-0 z-30 flex h-20 items-center justify-between gap-2 border-b border-aree-border bg-aree-bg/85 px-4 sm:h-[70px] sm:gap-3 sm:px-6 backdrop-blur-md transition-colors"
      aria-label="Command bar"
    >
      {/* Left: Mobile Menu Trigger + compact brand (both below lg only) + Search.

          `flex-1` keeps this half claiming the free space so the controls opposite
          stay pinned to the right edge; `min-w-0` lets it shrink below its content
          width rather than shoving them off the screen on a narrow phone. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
        {onOpenMobile && (
          <button
            type="button"
            onClick={onOpenMobile}
            className="lg:hidden flex h-8 w-8 items-center justify-center rounded-lg border border-aree-border bg-aree-surface-1 text-aree-muted hover:text-aree-text hover:bg-aree-surface-2 transition-colors cursor-pointer"
            aria-label="Open sidebar menu"
          >
            <Menu className="h-4 w-4" aria-hidden="true" />
          </button>
        )}

        {/* Only below lg: at wider widths the sidebar is on-screen and already shows
            this, and rendering both would repeat the mark twice on one row. The
            tagline is dropped — "AREE" alone is the identity; the full phrase needs
            ~145px it does not have next to a menu button and three controls. */}
        <Link
          href="/"
          className="flex shrink-0 items-center lg:hidden"
          aria-label="AREE home"
        >
          <AreeLogo size={30} tagline={false} />
        </Link>

        {/* Search / Command Palette Trigger */}
        {onOpenSearch && (
          <button
            type="button"
            onClick={onOpenSearch}
            className="flex h-8 min-w-0 flex-1 items-center justify-start gap-2.5 rounded-lg border border-aree-border bg-aree-surface-1 px-3 py-1.5 text-xs text-aree-muted shadow-2xs transition-all hover:border-aree-border-strong hover:bg-aree-surface-2 hover:text-aree-text cursor-pointer sm:w-[190px] sm:flex-none md:w-[240px] lg:w-[280px]"
            aria-label="Search station, policy, or event"
          >
            <Search className="h-3.5 w-3.5 text-aree-dim" aria-hidden="true" />
            {/* Two labels, one box. Below md the full phrase does not fit, and hiding
                it outright left the control an empty rounded rectangle with a lone
                magnifier in it — a search box that looks broken rather than compact.
                The short word keeps the affordance legible on a phone. */}
            <span className="ml-auto truncate text-aree-body font-medium sm:ml-0 md:hidden">
              Search
            </span>
            <span className="hidden truncate text-aree-body font-medium md:inline">
              Search station, policy, event…
            </span>
            <kbd className="hidden sm:inline-flex ml-auto shrink-0 items-center rounded border border-aree-border bg-aree-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-aree-dim">
              Ctrl K
            </kbd>
          </button>
        )}
      </div>

      {/* Right: Theme, Engine & Live Telemetry Pill */}
      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <ThemeToggle />

        {/* WHICH ENGINE, beside — never inside — the live/replay pill. That pill
            answers "is the page describing now"; this answers "what is the server
            running". Folding one into the other would lose whichever question the
            operator was actually asking. Sits outside the replay branch below so it
            keeps reporting the live engine during a replay, which is the truth. */}
        <div className="hidden xl:flex">
          <EngineModeChip />
        </div>

        {/* Replay takes precedence over engine liveness: what the user is LOOKING AT
            outranks whether the server is up. */}
        {replayAt ? (
          <div
            className="flex h-8 items-center gap-2 rounded-lg border px-2 py-1.5 text-xs shadow-2xs sm:px-3"
            style={{
              borderColor: "color-mix(in srgb, var(--aree-violet) 35%, transparent)",
              background: "color-mix(in srgb, var(--aree-violet) 10%, transparent)",
            }}
            role="status"
            aria-live="polite"
          >
            <History
              className="h-3.5 w-3.5"
              style={{ color: "var(--aree-violet)" }}
              aria-hidden
            />
            <span
              className="text-[11px] font-bold tracking-wider"
              style={{ color: "var(--aree-violet)" }}
            >
              REPLAY
            </span>
            <span
              className="hidden h-3.5 w-px sm:block"
              style={{ background: "color-mix(in srgb, var(--aree-violet) 35%, transparent)" }}
              aria-hidden
            />
            <span
              className="aree-num hidden text-[11px] font-semibold sm:inline"
              style={{ color: "var(--aree-violet)" }}
            >
              {istDateTime(replayAt) ?? replayAt}
            </span>
          </div>
        ) : (
        /* Live Status & Clock Pill */
        <div
          className="flex h-8 items-center gap-2 rounded-lg border border-aree-border bg-aree-surface-1 px-2 py-1.5 text-xs shadow-2xs sm:gap-3 sm:px-3"
          role="status"
          aria-live="polite"
        >
          {/* Status Dot + Label */}
          {stateKnown ? (
            <>
              <span className="flex items-center gap-1.5">
                <span
                  className={`h-2 w-2 rounded-full ${live ? "aree-live-dot" : ""}`}
                  style={{ backgroundColor: indicatorColor }}
                  aria-hidden="true"
                />
                <span
                  className="hidden text-[11px] font-bold tracking-wider sm:inline"
                  style={{ color: indicatorColor }}
                >
                  {indicatorLabel}
                </span>
                <span className="sr-only">{indicatorLabel}</span>
              </span>

              <span className="hidden h-3.5 w-px bg-aree-border sm:block" aria-hidden="true" />
            </>
          ) : null}

          {/* Active / Known stations count */}
          <span
            className="aree-num text-aree-body text-[11px] font-semibold"
            title="Active stations / Known stations"
          >
            {status ? `${status.active_stations}/${status.known_stations}` : "—/—"}
            <span className="hidden sm:inline"> ONLINE</span>
          </span>

          {/* IST Server Clock */}
          <span className="hidden h-3.5 w-px bg-aree-border xl:block" aria-hidden="true" />

          <span className="aree-num text-aree-muted text-[11px] font-medium hidden xl:flex items-center gap-1">
            <Clock className="h-3 w-3 text-aree-dim" aria-hidden="true" />
            {clock ?? "—"}
          </span>
        </div>
        )}
      </div>
    </header>
  );
}
