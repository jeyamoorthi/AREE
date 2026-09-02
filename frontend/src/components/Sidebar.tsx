"use client";

/**
 * AREE Sidebar Navigation Component
 * Provides clean collapsible desktop sidebar and responsive mobile drawer navigation.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  FileText,
  LayoutDashboard,
  MapPin,
  Radio,
  Wind,
  X,
} from "lucide-react";

import { useSystemStatus } from "@/components/providers/LiveDataProvider";
import { istClock } from "@/lib/clock";

interface SidebarProps {
  collapsed: boolean;
  mobileOpen: boolean;
  onToggle: () => void;
  onMobileClose: () => void;
}

const NAV_ITEMS = [
  {
    href: "/",
    label: "National Overview",
    shortLabel: "Overview",
    icon: MapPin,
    exact: true,
  },
  {
    href: "/dashboard",
    label: "Command Center",
    shortLabel: "Command",
    icon: LayoutDashboard,
    exact: false,
    extraMatch: "/stations",
  },
  {
    // The MVP screen: the whole chain on one page, and like /ventilation it is
    // free of the Pathway engine so a demonstration cannot be killed by one
    // import failing.
    href: "/outlook",
    label: "Atmospheric Outlook",
    shortLabel: "Outlook",
    icon: Activity,
    exact: false,
  },
  {
    // Ventilation is the only route here that does not depend on the Pathway
    // engine - it reads a met feed and a calibrated threshold - so it stays
    // usable when the streaming pipeline is down.
    href: "/ventilation",
    label: "Ventilation Outlook",
    shortLabel: "Ventilation",
    icon: Wind,
    exact: false,
  },
  {
    href: "/reports",
    label: "Reports",
    shortLabel: "Reports",
    icon: FileText,
    exact: false,
  },
];

export default function Sidebar({
  collapsed,
  mobileOpen,
  onToggle,
  onMobileClose,
}: SidebarProps) {
  const pathname = usePathname();
  const statusState = useSystemStatus();
  const status = statusState.data;

  const offline = Boolean(statusState.error) && !status;
  const engineDown = Boolean(status && !status.engine_loaded);
  const live = Boolean(status?.engine_loaded);

  const indicatorColor = offline
    ? "var(--aree-red)"
    : engineDown
      ? "var(--aree-yellow)"
      : "var(--aree-green)";

  const indicatorLabel = offline ? "OFFLINE" : engineDown ? "DOWN" : "LIVE";
  const clock = istClock(status?.server_time);

  return (
    <>
      {/* Mobile Backdrop Overlay */}
      {mobileOpen && (
        <div
          className="aree-sidebar-overlay lg:hidden"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}

      {/* Main Sidebar Container */}
      <aside
        className={`aree-sidebar flex flex-col justify-between select-none ${
          collapsed ? "collapsed" : ""
        } ${mobileOpen ? "mobile-open" : ""}`}
        aria-label="Sidebar navigation"
      >
        {/* Top: Branding & Toggle */}
        <div className="flex flex-col">
          {/* Header */}
          <div className="flex h-[70px] items-center justify-between border-b border-aree-border px-4">
            <Link
              href="/"
              onClick={onMobileClose}
              className="flex items-center gap-3 overflow-hidden group focus:outline-none"
              title="AREE Environmental Intelligence"
            >
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-aree-forest text-white font-black text-sm tracking-wider shadow-sm transition-transform duration-200 group-hover:scale-105"
                aria-hidden="true"
              >
                AR
              </span>

              {!collapsed && (
                <div className="flex flex-col min-w-0 transition-opacity duration-200">
                  <span className="text-base font-black tracking-[0.14em] text-aree-text leading-tight">
                    AREE
                  </span>
                  <span className="text-[10px] font-semibold tracking-wider text-aree-dim uppercase truncate">
                    Environmental Intel
                  </span>
                </div>
              )}
            </Link>

            {/* Mobile close button */}
            <button
              type="button"
              onClick={onMobileClose}
              className="lg:hidden p-1.5 rounded-lg text-aree-muted hover:text-aree-text hover:bg-aree-surface-3 transition-colors"
              aria-label="Close sidebar"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Navigation Links */}
          <nav className="p-3 space-y-1.5" aria-label="Main Navigation">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = item.exact
                ? pathname === item.href
                : pathname.startsWith(item.href) ||
                  (item.extraMatch && pathname.startsWith(item.extraMatch));

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onMobileClose}
                  aria-current={active ? "page" : undefined}
                  title={collapsed ? item.label : undefined}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-xs font-semibold tracking-wide transition-all ${
                    active
                      ? "bg-aree-forest text-white shadow-sm"
                      : "text-aree-body hover:bg-aree-surface-3 hover:text-aree-text"
                  } ${collapsed ? "justify-center px-0" : ""}`}
                >
                  <Icon
                    className={`h-4 w-4 shrink-0 ${
                      active ? "text-aree-accent" : "text-aree-dim"
                    }`}
                    aria-hidden="true"
                  />
                  {!collapsed && (
                    <span className="truncate">{item.label}</span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Bottom: Telemetry, Collapse Button & Footer */}
        <div className="border-t border-aree-border p-3 space-y-3 bg-aree-surface-2/60">
          {/* Live Status Telemetry Pill */}
          {!collapsed ? (
            <div className="rounded-lg border border-aree-border bg-aree-surface-1 p-2.5 text-xs shadow-xs space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <span
                    className={`h-2 w-2 rounded-full ${
                      live ? "aree-live-dot" : ""
                    }`}
                    style={{ backgroundColor: indicatorColor }}
                    aria-hidden="true"
                  />
                  <span
                    className="text-[11px] font-bold tracking-wider uppercase"
                    style={{ color: indicatorColor }}
                  >
                    {indicatorLabel}
                  </span>
                </span>
                <span className="text-[10px] text-aree-dim font-mono">
                  {clock ?? "—"}
                </span>
              </div>

              <div className="flex items-center justify-between text-[11px] text-aree-muted pt-1 border-t border-aree-border/60">
                <span>Active Nodes</span>
                <span className="font-semibold text-aree-text font-mono">
                  {status
                    ? `${status.active_stations}/${status.known_stations}`
                    : "—/—"}
                </span>
              </div>
            </div>
          ) : (
            <div className="flex justify-center py-1" title={`${indicatorLabel} · ${status ? `${status.active_stations}/${status.known_stations} active` : ""}`}>
              <span
                className={`h-2.5 w-2.5 rounded-full ${live ? "aree-live-dot" : ""}`}
                style={{ backgroundColor: indicatorColor }}
                aria-hidden="true"
              />
            </div>
          )}

          {/* Desktop Collapse / Expand Toggle */}
          <button
            type="button"
            onClick={onToggle}
            className={`hidden lg:flex w-full items-center gap-2 rounded-lg border border-aree-border bg-aree-surface-1 py-1.5 text-xs font-medium text-aree-muted hover:text-aree-text hover:bg-aree-surface-3 transition-colors ${
              collapsed ? "justify-center px-0" : "px-3 justify-between"
            }`}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {!collapsed && (
              <span className="text-[11px] tracking-wide uppercase text-aree-dim">
                Collapse
              </span>
            )}
            {collapsed ? (
              <ChevronRight className="h-4 w-4 text-aree-dim" />
            ) : (
              <ChevronLeft className="h-4 w-4 text-aree-dim" />
            )}
          </button>

          {/* Version Notice */}
          {!collapsed && (
            <div className="text-center">
              <span className="text-[10px] tracking-widest text-aree-faint uppercase font-mono">
                AREE v2.2
              </span>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
