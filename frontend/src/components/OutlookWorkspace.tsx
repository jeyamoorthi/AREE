"use client";

/* ==========================================================================
   Outlook — one workspace, two views.

   Summary answers "what is happening and what should be done"; Diagnostics answers
   "how well will the atmosphere clear, and how well does that model perform". They
   were separate routes, which made the second one look like a different subject
   rather than the evidence under the first.

   The moment selector sits in this header, not in either view, for the reason the
   provider exists: one payload. Two preset rows driving one fetch would have been a
   control duplicated, and a control that appears twice is one a user assumes is two
   different settings.
   ========================================================================== */

import OutlookView from "@/components/OutlookView";
import VentilationOutlook from "@/components/VentilationOutlook";
import {
  OUTLOOK_PRESETS,
  OutlookDataProvider,
  useOutlookData,
  type OutlookTab,
} from "@/components/providers/OutlookDataProvider";

/* The two files this page composes each carry their own paper palette; these are the
   same tokens, so the chrome above them matches the content below it rather than
   introducing a third look. */
const C = {
  ink: "var(--aree-text)",
  body: "var(--aree-body)",
  muted: "var(--aree-muted)",
  line: "var(--aree-border)",
  paper: "var(--aree-surface-1)",
};

const TABS: { id: OutlookTab; label: string; hint: string }[] = [
  {
    id: "summary",
    label: "Summary",
    hint: "What the atmosphere is doing, what it will do next, and what that means for air quality.",
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    hint: "Dispersion capacity, the intervention window, and the model's decision basis.",
  },
];

function Workspace() {
  const { preset, setPreset, tab, setTab } = useOutlookData();

  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  /* Arrow keys move between tabs, which is what a tablist is expected to do; Enter
     and Space activate through the native <button>. Focus follows selection, so the
     panel below always describes the tab the user is on. */
  function onTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = event.key === "ArrowRight" ? index + 1 : index - 1;
    const target = TABS[(next + TABS.length) % TABS.length];
    setTab(target.id);
    document.getElementById(`outlook-tab-${target.id}`)?.focus();
  }

  return (
    <div className="space-y-3" style={{ color: C.body }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[19px] font-bold tracking-tight" style={{ color: C.ink }}>
            Outlook
          </h1>
          <p className="mt-0.5 max-w-[70ch] text-[11.5px]" style={{ color: C.muted }}>
            {active.hint}
          </p>
        </div>

        {/* The moment. One selector for both views, so the two tabs can never be
            describing different hours. */}
        <div
          className="flex flex-wrap gap-1.5"
          role="group"
          aria-label="Forecast moment"
        >
          {OUTLOOK_PRESETS.map((p, i) => (
            <button
              key={p.label}
              type="button"
              onClick={() => setPreset(i)}
              aria-pressed={preset === i}
              className="rounded-md border px-3 py-1.5 text-[11.5px] font-semibold transition"
              style={
                preset === i
                  ? { background: C.ink, borderColor: C.ink, color: "var(--aree-bg)" }
                  : { background: C.paper, borderColor: C.line, color: C.body }
              }
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tabs. The active one is carried by weight, an underline and aria-selected —
          not by colour alone. */}
      <div
        role="tablist"
        aria-label="Outlook views"
        className="flex gap-1 border-b"
        style={{ borderColor: C.line }}
      >
        {TABS.map((t, index) => {
          const selected = t.id === tab;
          return (
            <button
              key={t.id}
              id={`outlook-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`outlook-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
              className={`-mb-px border-b-2 px-3.5 py-2 text-[12.5px] transition ${
                selected ? "font-bold" : "font-medium"
              }`}
              style={{
                borderColor: selected ? C.ink : "transparent",
                color: selected ? C.ink : C.muted,
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Both panel ELEMENTS stay in the DOM so each tab's aria-controls resolves to
          something, but only the active one is populated.

          Not display:none on a mounted chart: Recharts measures its container through
          a ResizeObserver, and a container inside a hidden subtree measures zero. A
          chart that came back 0 px tall on the first switch would look broken in a way
          a remount never does. Switching is still free of a refetch — the payload
          lives in the provider, not in either view. */}
      <div
        id="outlook-panel-summary"
        role="tabpanel"
        aria-labelledby="outlook-tab-summary"
        hidden={tab !== "summary"}
      >
        {tab === "summary" ? <OutlookView /> : null}
      </div>
      <div
        id="outlook-panel-diagnostics"
        role="tabpanel"
        aria-labelledby="outlook-tab-diagnostics"
        hidden={tab !== "diagnostics"}
      >
        {tab === "diagnostics" ? <VentilationOutlook /> : null}
      </div>
    </div>
  );
}

export default function OutlookWorkspace() {
  return (
    <OutlookDataProvider>
      <Workspace />
    </OutlookDataProvider>
  );
}
