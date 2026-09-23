"use client";

/**
 * AREE Application Shell — sidebar-based command center layout.
 * Wraps all pages with: LiveDataProvider, Sidebar, CommandBar, and Ctrl+K palette.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { istDateTime } from "@/lib/clock";

import CommandBar from "@/components/CommandBar";
import CommandPalette from "@/components/CommandPalette";
import CriticalAlertBanner from "@/components/CriticalAlertBanner";
import ReplayModeBanner from "@/components/ReplayModeBanner";
import Sidebar from "@/components/Sidebar";
import {
  LiveDataProvider,
  useSystemStatus,
} from "@/components/providers/LiveDataProvider";
import { OutlookModeProvider } from "@/components/providers/OutlookModeProvider";
import { ThemeProvider } from "@/components/providers/ThemeProvider";

/**
 * What the system is actually running, named from /api/system/status.
 *
 * THE RULE THIS FOOTER NOW FOLLOWS
 *   Every clause here is a claim printed on every page and in every screenshot, read
 *   by an authority who has no way to check it. So a clause appears only when the
 *   status payload CONFIRMS it, and is absent otherwise — never "unknown", never
 *   "unavailable". Those two words were the whole problem: they published the
 *   application's uncertainty about itself as if it were a finding, on the one strip
 *   whose job is to say what is true.
 *
 *   Before the first poll answers, the footer is the version string alone. That is
 *   not a degraded state; it is the honest one, and it lasts a few hundred
 *   milliseconds.
 */
function SystemFooter() {
  const { data: status } = useSystemStatus();

  /* Built by appending only what is established. Nothing here has an else branch
     that prints a hedge. */
  const parts: string[] = ["AREE v2.2"];

  if (status) {
    parts.push(
      !status.engine_loaded
        ? "engine offline"
        : status.mode === "streaming"
          ? "Pathway streaming engine"
          : "direct engine",
    );

    /* Stations actually reporting IS the confirmation that the observation feed
       works — it is the only evidence available, and it is real evidence. With none
       reporting, naming the publisher would assert a working feed on the strength of
       a constant in this file. */
    if (status.active_stations > 0) {
      parts.push("observations CAQM / CPCB");
    }

    /* Only when the index is live. "policy retrieval unavailable" was the same
       mistake as "unknown" in a more confident font: it invited an operator to
       wonder what had broken, on a run where the direct engine simply has no
       retrieval layer and nothing is wrong. */
    if (status.rag_status === "active") {
      parts.push("policy retrieval active");
    }
  }

  /* "meteorology Open-Meteo" used to sit here unconditionally. There is no field on
     /api/system/status that says whether that feed is answering, so the claim could
     not be confirmed from anywhere — and an unconfirmable source label is exactly
     what this change exists to remove. The Outlook view names the provenance of the
     meteorology where the meteorology is actually used and where its own payload can
     back the statement. Restore it here the day the status endpoint reports it. */

  return (
    <footer
      className="mt-auto px-4 pb-4 pt-4 text-center sm:px-6"
      style={{ borderTop: "1px solid var(--aree-border)" }}
    >
      <span className="text-aree-faint text-[10px] tracking-[0.14em] uppercase">
        {parts.join(" · ")}
      </span>
    </footer>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  /* Collapse is the DESKTOP rail behaviour and has nothing to do with the mobile
     drawer. Toggling both from one handler meant collapsing the rail on a wide window
     also armed `mobileOpen`, which is invisible there — and the drawer then sprang
     open by itself the moment the window was narrowed past 1024px. */
  const toggleSidebar = useCallback(() => setSidebarCollapsed((c) => !c), []);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  // Ctrl+K / Cmd+K palette toggle
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /* WHEN THIS PAGE WAS PRINTED.
      The print header in globals.css composes its text from custom properties; this
      supplies the timestamp half. It is stamped on beforeprint rather than on a
      render because the operator may have had the tab open for hours, and a brief
      that claims to have been printed this morning is worse than one with no time
      on it at all. The mount-time value is only the fallback for a browser that
      does not fire beforeprint.

      This is the one clock in the application that is genuinely client-side: it
      records when the paper came out, not when anything was observed. It still goes
      through istDateTime, so it reads in the same zone as every other instant on
      the page. */
  useEffect(() => {
    const stamp = () => {
      const now = istDateTime(new Date().toISOString());
      document.documentElement.style.setProperty(
        "--aree-print-time",
        now ? `" · Printed ${now}"` : '""',
      );
    };
    stamp();
    window.addEventListener("beforeprint", stamp);
    return () => window.removeEventListener("beforeprint", stamp);
  }, []);

  // Close mobile sidebar on resize to desktop
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth >= 1024) {
        setMobileOpen(false);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <>
      {/* Skip link */}
      <a
        href="#main-content"
        className="bg-aree-surface-2 text-aree-body border-aree-accent sr-only rounded-md border px-3 py-2 text-xs focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[1100]"
      >
        Skip to main content
      </a>

      <div className="aree-layout">
        {/* Sidebar */}
        <Sidebar
          collapsed={sidebarCollapsed}
          mobileOpen={mobileOpen}
          onToggle={toggleSidebar}
          onMobileClose={closeMobile}
        />

        {/* Main content area */}
        <div className={`aree-main ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
          {/* Command bar */}
          <CommandBar
            onOpenSearch={openPalette}
            onOpenMobile={() => setMobileOpen(true)}
          />

          {/* First thing under the header, above even the critical alert: everything
              below it is qualified by whether it describes now. Non-sticky for the
              same reason the freshness ribbon is — the command bar and the alert
              already hold the two sticky layers under the sidebar, and the command
              bar carries its own REPLAY pill for the scrolled case. */}
          <ReplayModeBanner />

          {/* A triggered station is the one thing that must reach the operator on
              every page, including the ones that know nothing about stations. It
              sits BELOW the command bar and at a lower z-index deliberately: the
              alert must never cover the navigation used to act on it. Renders
              nothing at all when no station is triggered. */}
          <CriticalAlertBanner />

          {/* Page content */}
          <main id="main-content" className="flex flex-1 flex-col p-3 sm:p-4 lg:p-5">
            {children}
          </main>

          {/* Footer. This was a fixed strip reading "Pathway streaming · WAQI direct ·
              NASA FIRMS verified · live policy index" — four subsystem claims, all four
              false in the mode that actually runs on this machine, printed on every
              page and every screenshot. It now describes the running system. */}
          <SystemFooter />
        </div>
      </div>

      {/* Command palette modal */}
      {paletteOpen ? <CommandPalette onClose={closePalette} /> : null}
    </>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    /* Outermost: the theme is the one thing here that every other provider's output
       is painted on top of, and it must not wait on a network poll. */
    <ThemeProvider>
      <LiveDataProvider>
        <OutlookModeProvider>
          <Shell>{children}</Shell>
        </OutlookModeProvider>
      </LiveDataProvider>
    </ThemeProvider>
  );
}
