import type { CSSProperties, ReactNode } from "react";

/* AREE UI kit.
   One place for surfaces, labels, metrics and disclosure so every screen
   shares the same hierarchy: hero number, section title, card title,
   body, metadata. */

export function Card({
  children,
  className = "",
  style,
  padding = "p-5",
  raised = false,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /**
   * Padding utility for this card. Pass it here rather than in `className`:
   * two utilities for the same property resolve by stylesheet order, not by
   * class-attribute order, so a `p-3` in `className` would lose to the default.
   */
  padding?: string;
  /** Slightly lighter surface for panels that sit on top of a section. */
  raised?: boolean;
}) {
  return (
    <div
      className={`${raised ? "bg-aree-card-raised" : "bg-aree-card"} border-aree-border min-w-0 rounded-xl border ${padding} shadow-[0_1px_2px_rgba(0,0,0,0.4),0_8px_24px_-16px_rgba(0,0,0,0.9)] ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}

/**
 * A titled panel — the main building block of the redesigned screens.
 * The title row carries an optional right-hand slot for status or actions.
 */
export function Panel({
  title,
  icon,
  right,
  children,
  className = "",
  padding = "p-5",
  accent,
  bodyClassName = "",
}: {
  title?: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  padding?: string;
  /** Optional colour for the title marker, e.g. a severity. */
  accent?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={`bg-aree-card border-aree-border flex min-w-0 flex-col rounded-xl border shadow-[0_1px_2px_rgba(0,0,0,0.4),0_8px_24px_-16px_rgba(0,0,0,0.9)] ${className}`}
    >
      {title ? (
        <header className="border-aree-border flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b px-5 py-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {accent ? (
              <span
                className="h-3.5 w-[3px] shrink-0 rounded-full"
                style={{ background: accent }}
                aria-hidden
              />
            ) : null}
            {icon ? (
              <span className="text-aree-muted shrink-0" aria-hidden>
                {icon}
              </span>
            ) : null}
            <h3 className="aree-eyebrow truncate">{title}</h3>
          </div>
          {right ? <div className="min-w-0 max-w-full">{right}</div> : null}
        </header>
      ) : null}
      <div className={`min-w-0 ${padding} ${bodyClassName}`}>{children}</div>
    </section>
  );
}

export function CardLabel({ children }: { children: ReactNode }) {
  return <div className="aree-eyebrow mb-2">{children}</div>;
}

export function CardValue({
  children,
  color,
  className = "",
}: {
  children: ReactNode;
  color?: string;
  className?: string;
}) {
  return (
    <div
      className={`aree-num aree-tabular text-[22px] leading-none font-bold tracking-[0.5px] ${className}`}
      style={color ? { color } : undefined}
    >
      {children}
    </div>
  );
}

export function CardSub({ children }: { children: ReactNode }) {
  return <div className="text-aree-dim mt-1.5 text-[11px]">{children}</div>;
}

/** Compact metric tile: label, value, optional sub-caption. */
export function MetricCard({
  label,
  value,
  color,
  sub,
  center = true,
  valueClassName = "",
  padding,
  children,
}: {
  label: string;
  value: ReactNode;
  color?: string;
  sub?: ReactNode;
  center?: boolean;
  valueClassName?: string;
  padding?: string;
  children?: ReactNode;
}) {
  return (
    <Card className={center ? "text-center" : ""} padding={padding}>
      <CardLabel>{label}</CardLabel>
      <CardValue color={color} className={valueClassName}>
        {value}
      </CardValue>
      {sub ? <CardSub>{sub}</CardSub> : null}
      {children}
    </Card>
  );
}

/**
 * Dense statistic used inside panels — no card chrome of its own so several
 * can sit in one row without competing with the panel that holds them.
 */
export function Stat({
  label,
  value,
  color,
  sub,
  mono = true,
  size = "md",
  title,
}: {
  label: ReactNode;
  value: ReactNode;
  color?: string;
  sub?: ReactNode;
  mono?: boolean;
  size?: "sm" | "md" | "lg";
  title?: string;
}) {
  const sizes = {
    sm: "text-base",
    md: "text-xl",
    lg: "text-3xl",
  } as const;
  return (
    <div className="min-w-0" title={title}>
      <div className="aree-eyebrow mb-1.5 text-[10px]">{label}</div>
      <div
        className={`${mono ? "aree-num aree-tabular" : ""} ${sizes[size]} leading-none font-bold break-words`}
        style={color ? { color } : { color: "var(--aree-text)" }}
      >
        {value}
      </div>
      {sub ? <div className="text-aree-dim mt-1.5 text-[11px]">{sub}</div> : null}
    </div>
  );
}

/** Section heading used to structure a long page. */
export function SectionHeader({
  children,
  index,
  right,
}: {
  children: ReactNode;
  /** Two-digit ordinal, e.g. "03". Purely navigational. */
  index?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mt-9 mb-4 flex items-end justify-between gap-4">
      <h2 className="flex items-baseline gap-2.5">
        {index ? (
          <span className="text-aree-accent/70 aree-num text-xs font-bold tracking-[0.18em]">
            {index}
          </span>
        ) : null}
        <span className="text-aree-text text-sm font-bold tracking-[0.12em] uppercase">
          {children}
        </span>
      </h2>
      <div className="border-aree-border mb-1.5 hidden h-px flex-1 border-b sm:block" />
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

export function ProgressBar({
  percent,
  color,
  height = 6,
  label,
}: {
  percent: number;
  color: string;
  height?: number;
  label?: string;
}) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <div
      className="bg-aree-border/80 mt-2.5 overflow-hidden rounded-full"
      style={{ height }}
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className="h-full rounded-full transition-[width] duration-700 ease-out"
        style={{ width: `${value}%`, background: color }}
      />
    </div>
  );
}

/** Small status pill. Never colour-only: the text always carries the meaning. */
export function Pill({
  children,
  color = "var(--aree-muted)",
  filled = false,
  className = "",
  title,
}: {
  children: ReactNode;
  color?: string;
  filled?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-md border px-2 py-0.5 text-[10px] font-bold tracking-[0.1em] text-ellipsis whitespace-nowrap uppercase ${className}`}
      style={{
        color,
        borderColor: filled
          ? "transparent"
          : `color-mix(in srgb, ${color} 45%, transparent)`,
        background: filled
          ? `color-mix(in srgb, ${color} 18%, transparent)`
          : `color-mix(in srgb, ${color} 8%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

/** Label/value row for dense technical readouts. */
export function KeyValue({
  label,
  value,
  color,
  mono = true,
}: {
  label: ReactNode;
  value: ReactNode;
  color?: string;
  mono?: boolean;
}) {
  return (
    <div className="border-aree-border/70 flex items-baseline justify-between gap-4 border-b py-1.5 last:border-b-0">
      <span className="text-aree-muted min-w-0 text-[11px]">{label}</span>
      <span
        className={`${mono ? "aree-num" : ""} min-w-0 text-right text-[12px] font-semibold break-words`}
        style={{ color: color ?? "var(--aree-body)" }}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Progressive disclosure for engineering depth. Technical values are never
 * deleted — they move in here so the primary read stays clean.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  className = "",
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details
      className={`group bg-aree-card border-aree-border min-w-0 rounded-xl border ${className}`}
      open={defaultOpen}
    >
      <summary className="text-aree-muted hover:text-aree-body flex cursor-pointer list-none items-center gap-2 px-5 py-3 text-[11px] font-bold tracking-[0.12em] uppercase transition-colors">
        <span
          className="text-aree-accent inline-block transition-transform group-open:rotate-90"
          aria-hidden
        >
          ▸
        </span>
        {summary}
      </summary>
      <div className="border-aree-border border-t px-5 py-4">{children}</div>
    </details>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="py-1 text-center">
      <span className="text-aree-dim text-[11px] leading-relaxed">{children}</span>
    </div>
  );
}
