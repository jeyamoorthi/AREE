# AREE Frontend

Next.js (App Router) + TypeScript + Tailwind dashboard for the **Autonomous
Regulatory Escalation Engine**. This app contains **no environmental logic** —
it renders data served by the FastAPI layer in `../backend/api`, which reads the
live Pathway engine.

## Running

```bash
npm install
npm run dev     # http://localhost:3000
```

The backend must be reachable at `NEXT_PUBLIC_API_URL` (see `.env.local`,
default `http://localhost:8000`). Start it from the project root:

```bash
uvicorn backend.api.main:api --reload --port 8000
```

Pathway ships Linux/macOS wheels only, so on Windows run the backend via Docker
or WSL — otherwise every data route answers `503 engine_unavailable` and the UI
shows `ENGINE OFFLINE`.

## Routes

| Route | Purpose |
|-------|---------|
| `/` | National overview: map, Top-5 lists, rankings, escalations, carbon |
| `/dashboard?station=…` | Single-station command center with selector |
| `/stations/[station]` | Same command center, deep-linkable |
| `/reports` | Per-station PDF report downloads |

## Structure

```
src/
├── app/           # routes (see above)
├── components/    # one component per dashboard section
│   └── ui/        # Card, SectionHeader, loading/error/empty states
├── hooks/         # usePolling, useLiveChannel, useEngineConfig
├── lib/           # api.ts (every API call), theme.ts (AREE palette)
└── types/         # TypeScript mirrors of the API schemas
```

## Data flow

- **Polling** every 5s is the base path (`usePolling`), with abort-on-unmount
  and interval cleanup.
- **WebSocket** `/ws/live` (`useLiveChannel`) only announces change events and
  bumps a `refreshKey` so sections refetch immediately. If it never connects the
  dashboard keeps working on polling alone and reports `polling only`.

## Conventions

- Add API calls to `lib/api.ts` only — components never call `fetch` directly.
- Card padding goes through the `padding` prop, not `className`: two utilities
  for the same property resolve by stylesheet order, so a `p-3` in `className`
  would lose to the default `p-5`.
- Colours come from `lib/theme.ts`, which carries the original dashboard's exact
  palette and threshold colour rules.
