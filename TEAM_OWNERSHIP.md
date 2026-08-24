# UrbanLive-AI — Full Team Structure & Ownership

This is the COMPLETE project structure. Do not delete files just because another teammate owns them.

## Ownership

### Part 1 — Data Ingestion
- backend/ingestion/
- backend/station_loader.py
- backend/config.py is READ ONLY

### Part 2 — Streaming + Risk Engine
- backend/streaming/
- backend/app.py
- backend/config.py changes only by team agreement / Part 4 lead

### Part 3 — AI + RAG + Policy
- backend/rag/
- backend/policies/
- backend/report_generator.py
- backend/api/routes/advisory.py
- backend/api/routes/ai.py
- backend/api/routes/policy.py
- backend/api/routes/reports.py

### Part 4 — FastAPI Backend
- backend/api/
- backend/api/schemas.py is the API contract owner
- backend/app.py / backend/config.py integration only with coordination

### Part 5 — Dashboard Frontend
- frontend/src/app/
- frontend/src/components/ (shared dashboard components)
- frontend/src/hooks/
- frontend/src/lib/
- frontend/src/types/
- frontend/src/lib/api.ts is the shared API client
- frontend/src/types/index.ts is the shared TypeScript contract

### Part 6 — Intelligence UI + Reports + Deployment
- frontend/src/app/stations/
- frontend/src/app/reports/
- frontend/src/components/station/
- frontend/src/components/AIAnalysis.tsx
- frontend/src/components/AdvisoryCard.tsx
- frontend/src/components/EscalationHistory.tsx
- frontend/src/components/HealthForecast.tsx
- frontend/src/components/PersistenceCard.tsx
- frontend/src/components/PolicyConsole.tsx
- frontend/src/components/ReportDownload.tsx
- frontend/src/components/SatelliteCard.tsx
- frontend/src/components/StationDashboard.tsx
- Dockerfile
- docker-compose.yml
- frontend/Dockerfile
- docs/

## Golden Rules
1. Keep this complete project structure in every teammate's clone.
2. Do NOT replace the project with a ZIP containing only your assigned folder.
3. Create a Git branch for your part and edit only your owned files unless coordinated.
4. `backend/api/schemas.py` is the API contract. Part 4 owns it.
5. `frontend/src/types/index.ts` is the TypeScript contract. Part 5 owns it.
6. `frontend/src/lib/api.ts` is the shared API client. Part 5 owns it.
7. Never commit `.env` or real API keys.
8. Before changing a shared contract, tell the affected teammate first.
9. Merge through Pull Requests into `main`.

## Branches
- feature/data-ingestion
- feature/streaming-risk-engine
- feature/ai-rag-policy
- feature/fastapi-api
- feature/dashboard-ui
- feature/stations-reports-deployment

## Recommended workflow

```bash
git clone <repository>
cd urbanlive-ai-main
git checkout -b <your-assigned-branch>

# edit your owned files

git add .
git commit -m "feat: describe your change"
git push origin <your-assigned-branch>
```

Then create a Pull Request into `main`.

The complete interface contract is in:
`TEAM_CONNECTION_STRUCTURE.md`
