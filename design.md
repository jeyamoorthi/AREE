# AREE — UI Design Spec

**Status:** v2 — rewritten against the codebase as it actually stands
**Last verified:** 2026-09-01 against `0915796`
**Scope:** Frontend only (`frontend/src`). No backend or API contract changes.

> **Read this first.** The original draft (v1) described a migration *from* a dark,
> top-nav layout *to* a light, sidebar-driven one. That migration has already
> shipped. The light token system, the sidebar shell and the light basemap are all
> live. This document records what exists, where the implementation diverges from
> the draft, and what genuinely remains open — so it can be used as a working
> reference rather than a plan for work already done.

---

## 1. Current state at a glance

| Draft phase | Status | Evidence |
|---|---|---|
| 1 — Tokens | **Done** (different names than drafted) | `globals.css:8-62`, `lib/theme.ts:4-31` |
| 2 — Shell | **Done** | `AppShell.tsx`, `Sidebar.tsx`, `CommandBar.tsx` |
| 3 — Map & cards | **Mostly done** | voyager tiles live; 324 hardcoded hex remain |
| 4 — Polish | **Partial** | responsive + focus done; footer illustration absent |
| 5 — Routing (§7) | **Open** | still 5 routes, no `/policy`, `/data-health`, `/settings` |

The one item that is not merely cosmetic is the hardcoded hex in §6 — four
components carry the *superseded dark palette*, so identical AQI values render in
different colors depending on which screen you are on.

---

## 2. Design tokens (as implemented)

Tokens live in `frontend/src/app/globals.css` under `:root`, and are exposed to
Tailwind through the `@theme inline` block immediately below. Component code
references them as utility classes (`bg-aree-surface-1`, `text-aree-muted`) or as
`var(--aree-*)` in inline styles.

`lib/theme.ts` mirrors the same values as a `COLORS` object for Recharts, which
cannot read CSS custom properties. **These two files must be kept in sync by
hand** — there is no build step that derives one from the other. Changing a color
in one place and not the other is the most likely way to introduce drift.

### 2.1 Surfaces

The draft proposed a `card` / `card-raised` pair. The implementation instead uses
a numbered surface ramp, which is the better call — it gives four elevation steps
rather than two, and the names do not imply a component.

| Token | Value | Usage |
|---|---|---|
| `--aree-bg` | `#f5f4ed` | page background (warm sand) |
| `--aree-bg-soft` | `#edebe2` | recessed regions |
| `--aree-surface-1` | `#ffffff` | primary card/panel surface |
| `--aree-surface-2` | `#faf9f4` | sidebar footer, subtle raise |
| `--aree-surface-3` | `#f2efe6` | hover states, table zebra |
| `--aree-surface-4` | `#e8e4d7` | deepest fill |
| `--aree-card` | `#ffffff` | alias of surface-1, retained for older call sites |
| `--aree-card-raised` | `#ffffff` | alias; **currently identical to `--aree-card`** |
| `--aree-border` | `#e4e0d4` | hairline borders |
| `--aree-border-strong` | `#cfcaba` | dividers, input borders |

> `--aree-card-raised` resolving to the same white as `--aree-card` means any
> component relying on it for visual separation gets none. Either give it a real
> value (`#faf9f4`) or migrate its call sites to the surface ramp and delete it.

### 2.2 Text

| Token | Value |
|---|---|
| `--aree-text` | `#17231c` (near-black, green cast) |
| `--aree-body` | `#2d3748` |
| `--aree-muted` | `#64748b` |
| `--aree-dim` | `#788796` |
| `--aree-faint` | `#9ba8b5` |

### 2.3 Brand accent

The draft proposed a single sage `#5b7c5b`. The implementation splits this into a
deep forest brand color and a brighter green accent, which reads better: forest
carries identity (logo, active nav, focus ring), accent carries state (live dot).

| Token | Value | Role |
|---|---|---|
| `--aree-forest` | `#143828` | brand, active nav fill, focus outline |
| `--aree-forest-hover` | `#1b4733` | hover on forest surfaces |
| `--aree-accent` | `#22c55e` | live/healthy indication |
| `--aree-accent-soft` | `rgba(34,197,94,.12)` | accent fill wash |
| `--aree-accent-glow` | `rgba(34,197,94,.25)` | live-dot pulse |
| `--aree-teal` | `#0d9488` | tertiary |
| `--aree-cyan` | `#0284c7` | tertiary |
| `--aree-blue` | `#2563eb` | informational chips |

> **Note the collision:** `--aree-accent` (`#22c55e`) is a *brand* token, while
> `--aree-green` (`#16a34a`) is a *semantic* token meaning "AQI Good". They are
> visually near-identical but carry different meanings, and only one of them is
> safe to restyle. Do not substitute one for the other.

### 2.4 Semantic ramp

These encode CPCB bands, GRAP stages and feed freshness. **The mapping from color
to severity is regulatory. Do not reassign it.** The hex values were darkened
during the light-theme migration to hold contrast against white — this is why the
stale values in §6 are a real problem rather than a cosmetic one.

| Token | v1 draft (dark-era) | **Current** | Text on white |
|---|---|---|---|
| `--aree-green` | `#22c55e` | `#16a34a` | pass |
| `--aree-lime` | `#84cc16` | `#65a30d` | pass |
| `--aree-yellow` | `#eab308` | `#ca8a04` | pass |
| `--aree-amber` | `#fbbf24` | `#d97706` | pass |
| `--aree-orange` | `#f97316` | `#ea580c` | pass |
| `--aree-red` | `#ef4444` | `#dc2626` | pass |
| `--aree-crimson` | `#dc2626` | `#991b1b` | pass |

The draft's warning that yellow/lime/amber were unsafe as text on white applied to
the *dark-era* values in the middle column. The current values were chosen to
resolve exactly that, so the blanket "fills only" rule no longer applies. It does
still apply anywhere the old values survive — see §6.

### 2.5 Typography

- `--font-sans` → Inter, `--font-mono` → JetBrains Mono, both loaded in `layout.tsx`.
- Numeric readouts (AQI values, station counts, clock) use `font-mono` so digits
  do not shift width as values tick. Keep this — a jittering AQI readout on a
  wall display is genuinely distracting.
- Sidebar nav labels: `text-xs`, `font-semibold`, `tracking-wide`.
- Eyebrow/label text: `text-[10px]`, `uppercase`, `tracking-[0.14em]`.

### 2.6 Radius, shadow, layout

| Token | Value |
|---|---|
| `--aree-radius-sm/md/lg/xl` | `6px` / `10px` / `12px` / `16px` |
| `--aree-shadow-sm` | `0 1px 2px rgba(0,0,0,.04)` |
| `--aree-shadow-md` | `0 1px 3px rgba(0,0,0,.05), 0 4px 12px -2px rgba(0,0,0,.04)` |
| `--aree-shadow-lg` | `0 4px 6px -1px rgba(0,0,0,.05), 0 10px 24px -4px rgba(0,0,0,.06)` |
| `--aree-sidebar-width` | `230px` |
| `--aree-sidebar-collapsed` | `68px` |
| `--aree-commandbar-height` | `70px` |

Focus ring is a `2px` `--aree-forest` outline at `2px` offset, applied globally via
`:where(a, button, select, input, summary, [tabindex]):focus-visible`. Do not
override this per-component.

---

## 3. Shell

`AppShell.tsx` composes `LiveDataProvider` → `Sidebar` + (`CommandBar` → page →
footer), plus a `CommandPalette` modal. Layout is driven by the `.aree-layout` /
`.aree-main` classes in `globals.css`, not by Tailwind grid utilities.

### 3.1 Regions

```
┌──────────────┬────────────────────────────────────────────┐
│              │  CommandBar (70px: search, status, mobile) │
│   Sidebar    ├────────────────────────────────────────────┤
│   230px      │                                            │
│   (68px      │  <main id="main-content">  page content    │
│   collapsed) │                                            │
│              ├────────────────────────────────────────────┤
│              │  footer (build/provenance line)            │
└──────────────┴────────────────────────────────────────────┘
```

### 3.2 Sidebar

Composition, top to bottom:

1. **Brand** — `AR` monogram tile on `bg-aree-forest` + "AREE" / "Environmental
   Intel" wordmark. Hidden when collapsed. Mobile close button (`X`).
2. **Nav** — four items, see §4.
3. **Telemetry** — live dot + `LIVE`/`DOWN`/`OFFLINE` state, IST clock, and
   active/known station count. Collapses to a bare dot with a `title` tooltip.
4. **Collapse toggle** — desktop only (`hidden lg:flex`), `ChevronLeft` /
   `ChevronRight`.
5. **Version** — `AREE v2.2`.

Three-state indicator, derived in `Sidebar.tsx:78-88`:

| Condition | Color | Label |
|---|---|---|
| fetch error, no cached status | `--aree-red` | `OFFLINE` |
| status present, `engine_loaded` false | `--aree-yellow` | `DOWN` |
| `engine_loaded` true | `--aree-green` | `LIVE` |

Distinguishing "we cannot reach the API" from "the API is up but the Pathway
engine is not" matters: the second state still serves the ventilation route,
which does not depend on the engine.

### 3.3 Responsive

| Breakpoint | Behavior |
|---|---|
| ≥1024px (`lg`) | Sidebar persistent; collapse toggle available |
| <1024px | Sidebar becomes an overlay drawer with a backdrop; opened from `CommandBar`, closed by backdrop click, `X`, or any nav click |

A resize listener force-closes the mobile drawer above 1024px so the two
mechanisms cannot both be active at once.

### 3.4 Accessibility

Already in place — preserve when editing:

- Skip link to `#main-content` (`sr-only` until focused).
- `aria-current="page"` on the active nav item.
- `aria-label` on the sidebar, nav, and every icon-only button.
- `aria-hidden="true"` on decorative icons and dots.
- `title` on collapsed nav items, since the label is visually hidden.

---

## 4. Icons

**Library: `lucide-react` (`^1.33.0`).** Already a dependency, already used
throughout. Icons are React components, so they tree-shake — only what is imported
ships. Do not add a second icon library or an icon webfont; both would ship an
entire glyph set to render a handful of marks.

### 4.1 Usage rules

```tsx
import { Wind } from "lucide-react";

<Wind className="h-4 w-4 shrink-0 text-aree-dim" aria-hidden="true" />
```

- **Size via Tailwind, not the `size` prop.** `h-4 w-4` (16px) in nav and inline
  contexts, `h-5 w-5` (20px) for standalone buttons. Keeps sizing in one system.
- **Always `shrink-0`** inside flex rows, or the icon squashes when the label wraps.
- **Color via token classes** (`text-aree-dim`, `text-aree-muted`), never a hex.
- **`aria-hidden="true"` when decorative** — which is nearly always, since icons
  here sit beside a text label. An icon-only button needs `aria-label` on the
  *button*, not the icon.
- **Named imports only.** `import * as Icons` defeats tree-shaking.

### 4.2 Icon vocabulary

One icon means one concept across the app.

| Concept | Icon | Where |
|---|---|---|
| National overview / geography | `MapPin` | nav |
| Command center / dashboard | `LayoutDashboard` | nav |
| Ventilation outlook | `Wind` | nav |
| Reports | `FileText` | nav |
| Live stream state | `Radio` | status |
| Collapse / expand | `ChevronLeft` / `ChevronRight` | sidebar |
| Dismiss | `X` | drawer, modal |

`Radio` is imported in `Sidebar.tsx` but not currently rendered — either use it
for the telemetry block or drop the import.

If new destinations land (§7), extend this table rather than picking ad hoc:
`ShieldCheck` for Policy Console, `Activity` for Data Health, `Settings` for
Settings.

---

## 5. Map

`StationMap.tsx` renders Leaflet via `StationMapLoader.tsx` (dynamic import,
`ssr: false` — Leaflet touches `window` at module scope and will crash SSR).

- **Basemap:** `rastertiles/voyager` (`StationMap.tsx:151`) — already the light
  tile set. The draft's `dark_all` → `light_all` change is done, and voyager was
  chosen over `light_all` for its terrain shading.
- **Markers:** fill from `aqiColor()`, semantic and unchanged. Halo/border is
  white so markers read against the light basemap.
- **Legend:** white rounded card, colored dots, dark text.

---

## 6. Open work — hardcoded hex

**324 hex literals across 16 `.tsx` files.** They fall into two classes, and only
the first is urgent.

### 6.1 Stale palette — correctness issue

Four components carry hex from the **pre-migration dark palette**. These values no
longer exist in `globals.css` or `theme.ts`, so these components render severity
colors that disagree with the rest of the app.

| File | Stale values |
|---|---|
| `station/AQIHero.tsx:22-27` | `#22c55e` `#84cc16` `#eab308` `#f97316` `#ef4444` |
| `StationMapLoader.tsx` | `#22c55e` `#eab308` `#f97316` `#94a3b8` |
| `ui/States.tsx` | `#eab308` `#ef4444` `#f97316` `#8a9bb4` |
| `AIAnalysis.tsx` | `#eab308` |

`AQIHero.tsx:22-27` is the clearest case — a private band table duplicating
`aqiColor()` with the old ramp:

```tsx
{ from: 100, to: 200, color: "#eab308" },   // theme.ts aqiColor() → #d97706
{ from: 300, to: 400, color: "#ef4444" },   // theme.ts aqiColor() → #dc2626
```

So AQI 150 is amber on the dashboard and yellow on the station hero. In a system
where color encodes a regulatory band, that is a data-integrity problem, not a
styling nit. `#8a9bb4` and `#94a3b8` are not in any palette at all.

**Fix:** delete the private tables and import `aqiColor()` / `COLORS` from
`lib/theme.ts`. Single source of truth, and the duplication cannot re-diverge.

### 6.2 Duplicated current values — maintenance issue

The remaining ~300 are *correct* values written literally instead of referenced:
`#143828`, `#17231c`, `#64748b`, `#788796`, `#e4e0d4`, `#faf9f4`. Concentrated in
`national/NationalPanels.tsx` (104), `ui/Card.tsx` (55), `PolicyConsole.tsx` (55),
`app/reports/page.tsx` (36).

Harmless today, but they are exactly what breaks on the next token change — the
same trap §6.1 already fell into. Replace with `var(--aree-*)` or token classes.
`ui/Card.tsx` is the highest-leverage target: it backs every primitive, so fixing
it propagates everywhere.

There is also `#f0eee4`, used in several files but defined nowhere. It sits
between `--aree-surface-3` and `--aree-surface-4`. Either promote it to a token or
snap it to the nearer one.

---

## 7. Open decision — routing

Five routes exist: `/`, `/dashboard`, `/reports`, `/ventilation`,
`/stations/[station]`. Four appear in the sidebar (`/stations/[station]` is
reached through the dashboard and matches via `extraMatch`).

Policy Console and Data Health exist only as components embedded in existing
pages. Settings does not exist.

- **A — Anchor links.** Sidebar entries scroll to the existing section. No new
  routes; active state needs scroll-spy instead of a route match.
- **B — Real routes.** `/policy`, `/data-health`, `/settings` render the existing
  components full-page. Cleaner, deep-linkable, more work.

**Recommendation: B**, but only after §6.1. The sidebar already handles four
routes cleanly and the components already exist as standalone units, so B is
mostly wiring — whereas A introduces scroll-spy state that the shell does not
currently have, to avoid work that is not actually hard.

---

## 8. Remaining polish

1. **§6.1 stale palette** — correctness. Do this first.
2. **`--aree-card-raised`** — give it a real value or remove it (§2.1).
3. **`ui/Card.tsx` hex** — highest-leverage §6.2 target.
4. **Sidebar footer illustration** — the drafted mountain/forest SVG and
   "Intelligence. Transparency. Better Decisions. Cleaner Tomorrow." tagline were
   never built. Purely decorative; lowest priority.
5. **Recent Events strip** — `EscalationHistory.tsx` exists and carries this data;
   confirm whether a separate strip is still wanted or whether that component
   already covers it.
6. **Unused `Radio` import** in `Sidebar.tsx` (§4.2).

---

## 9. Invariants

Things that must not change without a deliberate decision:

- **Semantic color → severity mapping.** Regulatory. Restyle the surface, never
  the meaning.
- **`globals.css` ↔ `theme.ts` parity.** Hand-maintained; drift is silent.
- **No new backend fields.** Every panel maps to data AREE already fetches.
- **`ssr: false` on the map loader.** Leaflet will crash SSR otherwise.
- **Accessibility affordances in §3.4.** Easy to drop accidentally in a restyle.
- **Light-only.** There is no theme toggle and none is planned; a single palette
  is the design, not an omission.
