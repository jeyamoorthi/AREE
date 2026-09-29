/**
 * The 404, inside the application shell.
 *
 * Rendered for any unknown route and for any page that calls next/navigation's
 * `notFound()` — the station page does, for a station the engine does not know.
 * The wording is therefore generic ("page or station") rather than route-specific,
 * and the way out is the two places an operator actually starts from.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { LayoutDashboard, MapPin, SearchX } from "lucide-react";

export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 items-center justify-center py-12">
      <section className="bg-aree-card border border-aree-border w-full rounded-xl p-6 text-center shadow-xs sm:p-8">
        <SearchX className="text-aree-dim mx-auto mb-4 h-8 w-8" aria-hidden />
        <p className="aree-eyebrow mb-2">404</p>
        <h1 className="text-aree-text text-xl font-bold tracking-tight">Page not found</h1>
        <p className="text-aree-muted mx-auto mt-2 max-w-sm text-sm leading-relaxed">
          This page or station could not be found. It may have been renamed, or the
          link may be out of date.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/"
            className="bg-aree-forest inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold text-white transition-colors hover:opacity-90"
          >
            <MapPin className="h-4 w-4" aria-hidden />
            NCR Overview
          </Link>
          <Link
            href="/dashboard"
            className="border-aree-border bg-aree-surface-1 text-aree-body hover:bg-aree-surface-2 hover:text-aree-text inline-flex items-center gap-2 rounded-lg border px-4 py-2 text-xs font-semibold transition-colors"
          >
            <LayoutDashboard className="h-4 w-4" aria-hidden />
            Command Center
          </Link>
        </div>
      </section>
    </div>
  );
}
