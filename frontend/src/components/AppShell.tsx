"use client";

/**
 * Client shell for the whole application: shared live data, header, global
 * status strip and the Ctrl/Cmd+K palette. Pages render their own content
 * only — the operator chrome is identical on every screen.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";

import CommandPalette from "@/components/CommandPalette";
import Header from "@/components/Header";
import StatusStrip from "@/components/StatusStrip";
import { LiveDataProvider } from "@/components/providers/LiveDataProvider";

function Shell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);

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

  return (
    <>
      <a
        href="#main-content"
        className="bg-aree-card text-aree-body border-aree-accent sr-only rounded-md border px-3 py-2 text-xs focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[1100]"
      >
        Skip to main content
      </a>

      <div className="mx-auto w-full max-w-[1680px] px-4 pb-14 sm:px-6">
        <Header onOpenSearch={openPalette} />
        <main id="main-content" className="mt-5 flex flex-col">
          <StatusStrip />
          {children}
        </main>
        <footer className="border-aree-border mt-10 border-t pt-4 text-center">
          <span className="text-aree-faint text-[10px] tracking-[0.16em] uppercase">
            AREE v2.2 · Pathway streaming · WAQI direct · NASA FIRMS verified · live policy
            index
          </span>
        </footer>
      </div>

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
