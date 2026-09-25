import type { CSSProperties, ReactNode } from "react";

/* ==========================================================================
   AREE UI Kit — Environmental Command Platform (Light Theme)
   Clean white cards, refined headers, warm borders.
   ========================================================================== */

/* ── Base Card ── */
export function Card({
  children,
  className = "",
  style,
  padding = "p-4 sm:p-5",
  raised = false,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  padding?: string;
  raised?: boolean;
}) {
  return (
    <div
      className={`bg-aree-card border border-aree-border rounded-xl ${padding} ${className}`}
      style={{
        boxShadow: raised
          ? "0 4px 12px -2px rgba(0, 0, 0, 0.05)"
          : "0 1px 3px rgba(0, 0, 0, 0.03)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ── Panel ── Primary card with title and subtitle/actions ── */
export function Panel({
  title,
  subtitle,
  icon,
  right,
  headerAction,
  variant,
  children,
  className = "",
  padding = "p-4 sm:p-5",
  accent,
  bodyClassName = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
  headerAction?: ReactNode;
  variant?: string;
  children: ReactNode;
  className?: string;
  padding?: string;
  accent?: string;
  bodyClassName?: string;
}) {
  const actionSlot = right ?? headerAction;
  const variantClass = variant ? (variant === "default" ? "" : variant) : "";
  return (
    <section
      className={`bg-aree-card border border-aree-border rounded-xl flex min-w-0 flex-col shadow-xs ${variantClass} ${className}`}
    >
      {title ? (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-4 pt-4 pb-3 border-b border-aree-border sm:px-5">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2">
              {icon ? (
                <span className="shrink-0 text-aree-muted" aria-hidden>
                  {icon}
                </span>
              ) : null}
              {accent ? (
                <span
                  className="h-3.5 w-[3px] shrink-0 rounded-full"
                  style={{ background: accent }}
                  aria-hidden
                />
              ) : null}
              <h3 className="text-[12px] font-black tracking-wider uppercase text-aree-text font-sans">
                {title}
              </h3>
            </div>
            {subtitle ? (
              <p className="text-[11px] text-aree-dim mt-0.5">{subtitle}</p>
            ) : null}
          </div>
          {actionSlot ? <div className="min-w-0">{actionSlot}</div> : null}
        </header>
      ) : null}
      <div className={`min-w-0 ${padding} ${bodyClassName}`}>{children}</div>
    </section>
  );
}

/* ── Intelligence Panel ── */
export function IntelligencePanel({
  title,
  subtitle,
  icon,
  right,
  headerAction,
  variant,
  children,
  className = "",
  padding = "p-4 sm:p-5",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
  headerAction?: ReactNode;
  variant?: string;
  children: ReactNode;
  className?: string;
  padding?: string;
}) {
  return (
    <Panel
      title={title}
      subtitle={subtitle}
      icon={icon}
      right={right}
      headerAction={headerAction}
      variant={variant}
      padding={padding}
      className={className}
    >
      {children}
    </Panel>
  );
}

/* ── Typography blocks ── */
export function CardLabel({ children }: { children: ReactNode }) {
  return <div className="aree-eyebrow mb-1.5">{children}</div>;
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
      className={`aree-num text-[22px] leading-none font-bold tracking-tight text-aree-text ${className}`}
      style={color ? { color } : undefined}
    >
      {children}
    </div>
  );
}

export function CardSub({ children }: { children: ReactNode }) {
  return <div className="text-aree-dim mt-1 text-[11px]">{children}</div>;
}

/* ── MetricCard ── standalone metric with card chrome */
export function MetricCard({
  label,
  value,
  color,
  sub,
  center = false,
  valueClassName = "",
  padding = "p-3 sm:p-4",
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
    <div
      className={`bg-aree-surface-2 border border-aree-border rounded-lg ${padding} ${
        center ? "text-center" : ""
      }`}
    >
      <div className="text-[10px] font-bold tracking-wider text-aree-dim uppercase mb-1.5">
        {label}
      </div>
      <div
        className={`aree-num text-[20px] font-bold text-aree-text leading-tight ${valueClassName}`}
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      {sub ? <div className="text-aree-dim mt-1 text-[11px]">{sub}</div> : null}
      {children}
    </div>
  );
}

/* ── Stat ── dense statistic for inside panels */
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
  size?: "sm" | "md" | "lg" | "xl";
  title?: string;
}) {
  const sizes = {
    sm: "text-[16px]",
    md: "text-[22px]",
    lg: "text-[28px]",
    xl: "text-[34px]",
  } as const;
  return (
    <div className="bg-aree-surface-2 border border-aree-border rounded-lg p-2.5 sm:p-3.5" title={title}>
      <div className="text-[10px] font-bold tracking-wider text-aree-dim uppercase mb-1">
        {label}
      </div>
      <div
        className={`${mono ? "aree-num" : ""} ${sizes[size]} leading-tight font-extrabold text-aree-text`}
        style={color ? { color } : undefined}
      >
        {value}
      </div>
      {sub ? <div className="text-aree-dim mt-1 text-[11px] font-medium">{sub}</div> : null}
    </div>
  );
}

/* ── SectionHeader ── */
export function SectionHeader({
  children,
  index,
  right,
}: {
  children: ReactNode;
  index?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mt-6 mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 sm:mt-8">
      <h2 className="flex items-center gap-2 text-[12px] font-black tracking-widest text-aree-forest uppercase">
        {index ? (
          <span className="text-aree-accent font-mono font-bold">
            {index}
          </span>
        ) : null}
        <span>{children}</span>
      </h2>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

/* ── ProgressBar ── */
export function ProgressBar({
  percent,
  color = "var(--aree-green)",
  height = 6,
  label,
}: {
  percent: number;
  color?: string;
  height?: number;
  label?: string;
}) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <div
      className="mt-2 overflow-hidden bg-aree-border"
      style={{ height, borderRadius: height }}
      role="progressbar"
      aria-valuenow={Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div
        className="h-full transition-[width] duration-500 ease-out"
        style={{ width: `${value}%`, background: color, borderRadius: height }}
      />
    </div>
  );
}

/* ── Pill ── */
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
      className={`inline-flex items-center gap-1 px-2.5 py-0.5 text-[11px] font-bold rounded-md uppercase tracking-wider ${className}`}
      style={{
        color: filled ? "var(--aree-on-solid)" : color,
        backgroundColor: filled ? color : `color-mix(in srgb, ${color} 12%, transparent)`,
        border: filled ? "none" : `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

/* ── KeyValue ── */
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
    <div className="flex items-center justify-between gap-4 py-1.5 border-b border-aree-border last:border-b-0 text-[12px]">
      <span className="text-aree-muted">{label}</span>
      <span
        className={`${mono ? "aree-num" : ""} font-semibold text-aree-text`}
        style={color ? { color } : undefined}
      >
        {value}
      </span>
    </div>
  );
}

/* ── Disclosure ── */
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
      className={`group bg-aree-card border border-aree-border rounded-xl ${className}`}
      open={defaultOpen}
    >
      <summary className="text-aree-text hover:text-aree-forest flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 sm:px-5 text-[12px] font-bold uppercase tracking-wider transition-colors">
        <span
          className="inline-block transition-transform duration-200 group-open:rotate-90 text-aree-forest"
          aria-hidden
        >
          ▸
        </span>
        {summary}
      </summary>
      <div className="border-t border-aree-border px-4 py-4 sm:px-5">{children}</div>
    </details>
  );
}

/* ── Note ── */
export function Note({ children }: { children: ReactNode }) {
  return (
    <div className="py-1 text-center">
      <span className="text-[11px] text-aree-dim">{children}</span>
    </div>
  );
}

/* ── StatusBadge ── */
export function StatusBadge({
  status,
  label,
  color,
  pulse,
  variant,
  children,
  className = "",
}: {
  status?: "operational" | "degraded" | "offline";
  label?: string;
  color?: string;
  pulse?: boolean;
  variant?: string;
  children?: ReactNode;
  className?: string;
}) {
  if (status) {
    const config = {
      operational: { color: "var(--aree-green)", text: label ?? "OPERATIONAL", dotClass: "aree-live-dot" },
      degraded: { color: "var(--aree-yellow)", text: label ?? "DEGRADED", dotClass: "" },
      offline: { color: "var(--aree-red)", text: label ?? "OFFLINE", dotClass: "" },
    };
    const c = config[status];
    return (
      <div className={`flex items-center gap-1.5 ${className}`}>
        <span
          className={`inline-block h-2 w-2 rounded-full ${c.dotClass}`}
          style={{ background: c.color }}
          aria-hidden
        />
        <span className="text-[10px] font-bold tracking-wider uppercase" style={{ color: c.color }}>
          {c.text}
        </span>
      </div>
    );
  }

  const badgeColor = color ?? "var(--aree-green)";
  const isSolid = variant === "solid";
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-[10px] font-bold tracking-wider uppercase rounded ${className}`}
      style={{
        color: isSolid ? "var(--aree-on-solid)" : badgeColor,
        background: isSolid ? badgeColor : `color-mix(in srgb, ${badgeColor} 12%, transparent)`,
        border: isSolid ? "none" : `1px solid color-mix(in srgb, ${badgeColor} 30%, transparent)`,
      }}
    >
      {pulse !== false ? (
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${pulse ? "aree-live-dot" : ""}`}
          style={{ background: isSolid ? "var(--aree-on-solid)" : badgeColor }}
          aria-hidden
        />
      ) : null}
      {children ?? label}
    </span>
  );
}

/* ── LiveIndicator ── */
export function LiveIndicator({
  label = "LIVE",
  color = "var(--aree-green)",
  className = "",
}: {
  label?: string;
  color?: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span
        className="aree-live-dot inline-block h-2 w-2 rounded-full"
        style={{ background: color }}
        aria-hidden
      />
      <span className="text-[10px] font-bold tracking-wider uppercase" style={{ color }}>
        {label}
      </span>
    </span>
  );
}

/* ── TimelineEvent ── */
export function TimelineEvent({
  time,
  timestamp,
  icon,
  iconColor,
  title,
  description,
  color = "var(--aree-muted)",
  isLast = false,
  children,
}: {
  time?: ReactNode;
  timestamp?: ReactNode;
  icon?: ReactNode;
  iconColor?: string;
  title?: ReactNode;
  description?: ReactNode;
  color?: string;
  isLast?: boolean;
  children?: ReactNode;
}) {
  const displayTime = time ?? timestamp;
  const eventColor = iconColor ?? color;
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
          style={{
            background: `color-mix(in srgb, ${eventColor} 15%, transparent)`,
            border: `1px solid color-mix(in srgb, ${eventColor} 35%, transparent)`,
          }}
        >
          {icon ? (
            <span style={{ color: eventColor }} className="text-xs">{icon}</span>
          ) : (
            <span className="h-2 w-2 rounded-full" style={{ background: eventColor }} />
          )}
        </div>
        {!isLast ? (
          <div className="w-px flex-1 min-h-4 bg-aree-border" />
        ) : null}
      </div>
      <div className="min-w-0 flex-1 pb-3">
        {displayTime ? (
          <span className="aree-num text-aree-dim text-[10px] font-semibold">{displayTime}</span>
        ) : null}
        {title ? (
          <div className="text-[12px] font-bold text-aree-text">
            {title}
          </div>
        ) : null}
        {description ? (
          <div className="text-aree-muted text-[11px]">{description}</div>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/* ── DataHealthItem ── */
export function DataHealthItem({
  name,
  label,
  status,
  statusColor,
  level,
  detail,
  icon,
}: {
  name?: string;
  label?: string;
  status: string;
  statusColor?: string;
  level?: string;
  detail?: string | null;
  icon?: ReactNode;
}) {
  const displayName = name ?? label ?? "";
  const levelColors: Record<string, string> = {
    ok: "var(--aree-green)",
    warn: "var(--aree-yellow)",
    bad: "var(--aree-red)",
    unknown: "var(--aree-dim)",
  };
  const finalColor = statusColor ?? (level ? levelColors[level] : undefined) ?? "var(--aree-green)";

  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-aree-border last:border-b-0 text-[12px]">
      <div className="flex items-center gap-2.5 min-w-0">
        {icon ? (
          <span className="text-aree-dim shrink-0 text-sm">{icon}</span>
        ) : null}
        <div className="min-w-0 truncate">
          <span className="font-semibold text-aree-text">{displayName}</span>
          {detail ? <span className="text-aree-dim text-[10px] ml-2 font-normal">({detail})</span> : null}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: finalColor }}
          aria-hidden
        />
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: finalColor }}>
          {status}
        </span>
      </div>
    </div>
  );
}

/* ── SeverityIndicator ── */
export function SeverityIndicator({
  value,
  label,
  color = "var(--aree-green)",
  size = "md",
}: {
  value: ReactNode;
  label?: string;
  color?: string;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  const sizes = {
    sm: { num: "text-[20px]", ring: "h-12 w-12" },
    md: { num: "text-[26px]", ring: "h-16 w-16" },
    lg: { num: "text-[36px]", ring: "h-22 w-22" },
    xl: { num: "text-[44px]", ring: "h-26 w-26" },
  };
  const s = sizes[size] ?? sizes.lg;
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className={`${s.ring} flex items-center justify-center rounded-full`}
        style={{
          background: `color-mix(in srgb, ${color} 10%, transparent)`,
          border: `2px solid color-mix(in srgb, ${color} 40%, transparent)`,
        }}
      >
        <span className={`aree-hero-num ${s.num}`} style={{ color }}>
          {value}
        </span>
      </div>
      {label ? (
        <span className="text-[10px] font-bold tracking-wider uppercase" style={{ color }}>
          {label}
        </span>
      ) : null}
    </div>
  );
}
