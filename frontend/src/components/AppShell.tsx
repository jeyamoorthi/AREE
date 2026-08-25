"use client";

/**
 * AREE Application Shell — sidebar-based command center layout.
 * Wraps all pages with: LiveDataProvider, Sidebar, CommandBar, and Ctrl+K palette.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import CommandBar from "@/components/CommandBar";
import CommandPalette from "@/components/CommandPalette";
import Sidebar from "@/components/Sidebar";
import { LiveDataProvider } from "@/components/providers/LiveDataProvider";

function Shell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((c) => !c);
    setMobileOpen((o) => !o);
  }, []);
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
          <CommandBar onOpenSearch={openPalette} />

          {/* Page content */}
          <main id="main-content" className="flex flex-col p-4 sm:p-5">
            {children}
          </main>

          {/* Footer */}
          <footer className="px-6 pb-6 pt-8 text-center" style={{ borderTop: "1px solid var(--aree-border)" }}>
            <span className="text-aree-faint text-[10px] tracking-[0.14em] uppercase">
              AREE v2.2 · Pathway streaming · WAQI direct · NASA FIRMS verified · live policy index
            </span>
          </footer>
        </div>
      </div>

      {/* Command palette modal */}
      {paletteOpen ? <CommandPalette onClose={closePalette} /> : null}
    </>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <LiveDataProvider>
      <Shell>{children}</Shell>
    </LiveDataProvider>
  );
}
