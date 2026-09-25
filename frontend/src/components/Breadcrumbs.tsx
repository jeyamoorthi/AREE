"use client";

/**
 * Where am I, and what is one level up.
 *
 * WHY IT IS NOT IN THE COMMAND BAR
 *   The obvious home for a breadcrumb is the header, and that is where it cannot go.
 *   The command bar sits in AppShell above every route, so reading `?station=` there
 *   would mean useSearchParams() — which this version of Next forces into a Suspense
 *   boundary, and the boundary would be the whole application shell. The codebase
 *   already refuses that trade once, in useSyncPresetToUrl, for the same reason.
 *
 *   The station pages hand their key down as a prop instead, so the trail is rendered
 *   where the identity already is. That also means it appears on station views and
 *   nowhere else by construction, rather than by a pathname test that has to be kept
 *   in step with the router.
 *
 * WHAT IT IS SUBORDINATE TO
 *   Everything. It sits above the station header in the page's quietest type, because
 *   its job is to answer a question the operator only asks when they are lost.
 */

import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface Crumb {
  label: string;
  /** Omitted for the current page, which is never a link. */
  href?: string;
}

export default function Breadcrumbs({
  items,
  className = "",
}: {
  items: Crumb[];
  className?: string;
}) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className={className}>
      {/* Ordered, because the steps are a hierarchy and not a set. flex-wrap rather
          than a scroller: a long station name wraps to the next line instead of
          pushing the page sideways. */}
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="flex min-w-0 items-center">
              {index > 0 ? (
                <ChevronRight
                  className="mx-0.5 h-3 w-3 shrink-0 text-aree-faint"
                  aria-hidden="true"
                />
              ) : null}

              {item.href && !last ? (
                <Link
                  href={item.href}
                  /* Underlined on hover and focus, not distinguished by colour alone.
                     The global focus-visible rule in globals.css supplies the ring. */
                  className="truncate text-[11px] font-medium text-aree-muted underline-offset-2 transition-colors hover:text-aree-forest hover:underline focus-visible:underline"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? "page" : undefined}
                  className="truncate text-[11px] font-semibold text-aree-body"
                  title={item.label}
                >
                  {item.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
