// Single point of contact with the AREE FastAPI backend.
// Every network call in the UI goes through here.

import type {
  AdvisoryResponse,
  AIResponse,
  AQIHistoryResponse,
  AQIResponse,
  ApiErrorBody,
  CarbonResponse,
  DashboardResponse,
  EngineConfig,
  EscalationsResponse,
  ForecastResponse,
  GRAPResponse,
  HealthImpactResponse,
  HealthResponse,
  PolicyResponse,
  PolicyUploadResponse,
  ReportMetaResponse,
  RiskResponse,
  StationDetail,
  StationListResponse,
  SystemStatus,
  VentilationAssessment,
  VentilationCurrent,
  VentilationForecast,
  OperatingPoint,
  ObservedComposite,
  OutlookResponse,
  CaseRecord,
  CasesResponse,
} from "@/types";

/**
 * Where the API lives, from the BROWSER's point of view.
 *
 * Empty string means same origin, and that is the right default: next.config.ts
 * rewrites /api and /ws to the backend, so a relative request works whether the page
 * is opened on this machine, on the LAN, or through a tunnel.
 *
 * THE BUG THIS REPLACES, BECAUSE IT WAS INVISIBLE FROM THE DEVELOPER'S CHAIR
 *   The fallback used to be "http://localhost:8000", reached whenever the env var was
 *   unset — and Next inlines an EMPTY var as undefined, so setting it to blank landed
 *   on the fallback too. Every visitor's browser then fetched THEIR OWN localhost.
 *   On the machine running AREE that resolves and everything looks correct; for
 *   anyone else the page hangs on "Loading outlook…" forever with the API answering
 *   200 to every check the developer runs. A default that only works where the server
 *   happens to be is worse than no default.
 *
 * An explicit absolute URL is still honoured, for running the frontend against a
 * backend somewhere else.
 */
const CONFIGURED_API = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "").trim();
export const API_URL = CONFIGURED_API ? CONFIGURED_API : "";

/* ── the authority session ────────────────────────────────────────────────
 *
 * The backend derives the acting officer from a signed token and ignores any
 * actor a client sends, so this layer's only job is to hold that token and put
 * it on the requests that write.
 *
 * WHY sessionStorage AND NOT localStorage
 *   A regulatory approval should not be one reopened tab away. sessionStorage is
 *   scoped to the tab and cleared when it closes, which matches how long an
 *   officer's authority to act at this terminal should reasonably last. Tokens
 *   are short-lived server-side regardless (15 minutes), so this is a
 *   convenience boundary, not the security one — the server is.
 *
 * Nothing here can grant authority. A forged or edited token fails signature,
 * audience and expiry checks server-side, and `actor_verified` is set by the
 * backend from the verified principal; it is not a field this code can reach.
 */

const TOKEN_KEY = "aree.auth.token";
const SESSION_KEY = "aree.auth.session";

export interface AuthSession {
  subject: string;
  role: string;
  capabilities: string[];
  expiresAt: number;
}

function readStore(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null; // private mode, or storage disabled
  }
}

function writeStore(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    /* Storage being unavailable must not break signing in for this page load. */
  }
}

/* The session is external state (sessionStorage), so components read it through
 * useSyncExternalStore rather than copying it into useState inside an effect.
 *
 * That is not a style preference. Reading it during render would differ between
 * the server (no storage, always null) and the client, producing a hydration
 * mismatch; copying it in an effect means a setState on every mount, which is the
 * cascading-render pattern the lint rules reject. useSyncExternalStore is the
 * mechanism React provides for exactly this shape, and it also gives sign-in and
 * sign-out a way to notify every mounted consumer.
 *
 * `getSnapshot` must be referentially stable while nothing has changed, or React
 * re-renders forever — hence the cache keyed on the raw stored string.
 */
let cachedRaw: string | null = null;
let cachedSession: AuthSession | null = null;
const sessionListeners = new Set<() => void>();

function notifySession(): void {
  for (const listener of sessionListeners) listener();
}

export const auth = {
  token: (): string | null => readStore(TOKEN_KEY),

  subscribe(listener: () => void): () => void {
    sessionListeners.add(listener);
    return () => {
      sessionListeners.delete(listener);
    };
  },

  /** The signed-in officer, or null. An expired session reads as signed out. */
  session(): AuthSession | null {
    const raw = readStore(SESSION_KEY);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      try {
        cachedSession = raw ? (JSON.parse(raw) as AuthSession) : null;
      } catch {
        cachedSession = null;
      }
    }
    // Expiry is checked without clearing storage: a snapshot getter must be free
    // of side effects, or React may call it mid-render and mutate as it reads.
    if (cachedSession && cachedSession.expiresAt <= Date.now()) return null;
    return cachedSession;
  },

  /** Server-render snapshot: there is no storage there, so nobody is signed in. */
  serverSession: (): AuthSession | null => null,

  async signIn(username: string, password: string): Promise<AuthSession> {
    const body = await request<{
      access_token: string;
      expires_in: number;
      subject: string;
      role: string;
      capabilities: string[];
    }>("/api/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    const session: AuthSession = {
      subject: body.subject,
      role: body.role,
      capabilities: body.capabilities,
      // A minute of headroom, so the UI stops offering an action slightly before
      // the server would refuse it rather than slightly after.
      expiresAt: Date.now() + (body.expires_in - 60) * 1000,
    };
    writeStore(TOKEN_KEY, body.access_token);
    writeStore(SESSION_KEY, JSON.stringify(session));
    notifySession();
    return session;
  },

  signOut(): void {
    writeStore(TOKEN_KEY, null);
    writeStore(SESSION_KEY, null);
    notifySession();
  },

  /** How this instance is configured — notably whether operators are demo ones. */
  config: (signal?: AbortSignal) =>
    request<{
      mode: "demo-credentials" | "configured";
      issuer: string;
      token_ttl_seconds: number;
      roles: Record<string, string[]>;
      note: string;
    }>("/api/auth/config", { signal }),
};

/** Error carrying the backend's structured JSON body. */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody | null;

  constructor(status: number, body: ApiErrorBody | null, message?: string) {
    super(message ?? body?.detail ?? `Request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }

  /** The engine is up but this station has no closed window yet. */
  get isWarmingUp(): boolean {
    return this.status === 425 || this.body?.error === "engine_starting";
  }

  get isEngineDown(): boolean {
    return this.status === 503;
  }

  /** The station's upstream WAQI feed is dormant or failing (not our fault). */
  get isFeedUnavailable(): boolean {
    return this.status === 424;
  }

  get hint(): string | undefined {
    return this.body?.hint;
  }
}

/** Thrown when the backend cannot be reached at all. */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
  opts?: { authenticated?: boolean },
): Promise<T> {
  let response: Response;
  // Opt-in rather than automatic. Attaching the token to every call would send an
  // officer's credential to endpoints that neither need nor check it, and would
  // make it harder to see, reading a route, whether it is a protected one.
  const bearer = opts?.authenticated ? auth.token() : null;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new NetworkError(
      `Cannot reach the AREE API at ${API_URL}. Is the backend running?`,
    );
  }

  if (!response.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = null;
    }
    throw new ApiError(response.status, body);
  }

  return (await response.json()) as T;
}

const enc = (station: string) => encodeURIComponent(station);

export const api = {
  health: (signal?: AbortSignal) =>
    request<HealthResponse>("/api/health", { signal }),

  systemStatus: (signal?: AbortSignal) =>
    request<SystemStatus>("/api/system/status", { signal }),

  systemConfig: (signal?: AbortSignal) =>
    request<EngineConfig>("/api/system/config", { signal }),

  dashboard: (signal?: AbortSignal) =>
    request<DashboardResponse>("/api/dashboard", { signal }),

  stations: (signal?: AbortSignal) =>
    request<StationListResponse>("/api/stations", { signal }),

  station: (station: string, signal?: AbortSignal) =>
    request<StationDetail>(`/api/stations/${enc(station)}`, { signal }),

  aqi: (station: string, signal?: AbortSignal) =>
    request<AQIResponse>(`/api/aqi/${enc(station)}`, { signal }),

  aqiHistory: (station: string, signal?: AbortSignal) =>
    request<AQIHistoryResponse>(`/api/aqi/${enc(station)}/history`, { signal }),

  grap: (station: string, signal?: AbortSignal) =>
    request<GRAPResponse>(`/api/grap/${enc(station)}`, { signal }),

  risk: (station: string, signal?: AbortSignal) =>
    request<RiskResponse>(`/api/risk/${enc(station)}`, { signal }),

  forecast: (station: string, signal?: AbortSignal) =>
    request<ForecastResponse>(`/api/forecast/${enc(station)}`, { signal }),

  healthImpact: (station: string, signal?: AbortSignal) =>
    request<HealthImpactResponse>(`/api/forecast/${enc(station)}/health`, { signal }),

  advisory: (station: string, signal?: AbortSignal) =>
    request<AdvisoryResponse>(`/api/advisory/${enc(station)}`, { signal }),

  ai: (station: string, signal?: AbortSignal) =>
    request<AIResponse>(`/api/ai/${enc(station)}`, { signal }),

  carbon: (signal?: AbortSignal) =>
    request<CarbonResponse>("/api/carbon", { signal }),

  escalations: (station?: string, signal?: AbortSignal) =>
    request<EscalationsResponse>(
      station ? `/api/escalations?station=${enc(station)}` : "/api/escalations",
      { signal },
    ),

  policy: (signal?: AbortSignal) =>
    request<PolicyResponse>("/api/policy", { signal }),

  reportMeta: (station: string, signal?: AbortSignal) =>
    request<ReportMetaResponse>(`/api/reports/${enc(station)}`, { signal }),

  reportPdfUrl: (station: string) =>
    `${API_URL}/api/reports/${enc(station)}/pdf`,

  async uploadPolicy(file: File): Promise<PolicyUploadResponse> {
    const form = new FormData();
    form.append("file", file);

    let response: Response;
    try {
      const bearer = auth.token();
      response = await fetch(`${API_URL}/api/policy/upload`, {
        method: "POST",
        headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
        body: form,
      });
    } catch {
      throw new NetworkError(`Cannot reach the AREE API at ${API_URL}.`);
    }

    if (!response.ok) {
      let body: ApiErrorBody | null = null;
      try {
        body = (await response.json()) as ApiErrorBody;
      } catch {
        body = null;
      }
      throw new ApiError(response.status, body);
    }
    return (await response.json()) as PolicyUploadResponse;
  },

  /** Download the PDF report through the browser without leaving the page. */
  async downloadReport(station: string): Promise<void> {
    const url = api.reportPdfUrl(station);
    const response = await fetch(url);
    if (!response.ok) {
      let body: ApiErrorBody | null = null;
      try {
        body = (await response.json()) as ApiErrorBody;
      } catch {
        body = null;
      }
      throw new ApiError(response.status, body);
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `escalation_report_${station
      .replace(/[^A-Za-z0-9_.-]+/g, "_")
      .slice(0, 60)}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  },
  // --- PS 26082 ventilation layer -----------------------------------------
  // These endpoints do not depend on the Pathway engine, so they keep working
  // when the streaming pipeline is unavailable. The UI treats them as a
  // separate capability rather than folding them into the station views.

  /**
   * The complete AREE outlook.
   *
   * `at` is passed straight through as the backend's `as_of`. Omitting it
   * gives live; supplying it replays that moment. There is no separate demo
   * endpoint, so the UI cannot drift from what production actually serves.
   */
  outlook: (at?: string, signal?: AbortSignal) =>
    request<OutlookResponse>(
      at ? `/api/aree/outlook?at=${enc(at)}` : "/api/aree/outlook",
      { signal },
    ),

  // --- Case management: the human-authority half of the decision chain ------
  //
  // The decision endpoint is given `as_of` rather than the evidence. The server
  // recomputes the assessment from that moment and refuses if the case id it derives
  // does not match the one being decided, so a decision cannot be attached to
  // evidence the browser supplied.

  cases: (status?: string, signal?: AbortSignal) =>
    request<CasesResponse>(
      status ? `/api/cases?status=${enc(status)}` : "/api/cases",
      { signal },
    ),

  case: (caseId: string, signal?: AbortSignal) =>
    request<CaseRecord>(`/api/cases/${enc(caseId)}`, { signal }),

  /**
   * Record a decision. Requires a signed-in officer holding `case:decide`.
   *
   * `actor` is deliberately NOT in this signature. The server takes the acting
   * officer from the verified token and ignores anything a body claims, so
   * offering the field here would imply an influence the client does not have.
   */
  decideCase: (
    caseId: string,
    body: { decision: "approve" | "reject"; as_of: string; reason?: string },
  ) =>
    request<CaseRecord>(
      `/api/cases/${enc(caseId)}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { authenticated: true },
    ),

  ventilationOperatingPoint: (mode?: string, signal?: AbortSignal) =>
    request<OperatingPoint>(
      `/api/ventilation/operating-point${mode ? `?mode=${enc(mode)}` : ""}`,
      { signal },
    ),

  ventilationCurrent: (signal?: AbortSignal) =>
    request<VentilationCurrent>("/api/ventilation/current", { signal }),

  ventilationForecast: (mode?: string, signal?: AbortSignal) =>
    request<VentilationForecast>(
      `/api/ventilation/forecast${mode ? `?mode=${enc(mode)}` : ""}`,
      { signal },
    ),

  ventilationObserved: (signal?: AbortSignal) =>
    request<ObservedComposite>("/api/ventilation/observed", { signal }),

  ventilationStations: (signal?: AbortSignal) =>
    request<ObservedComposite>("/api/ventilation/stations", { signal }),

  ventilationAssessment: (
    pm25: number | null,
    opts: { aqi?: number; station?: string; mode?: string } = {},
    signal?: AbortSignal,
  ) => {
    // pm25 omitted -> the backend uses the live CPCB/DPCC composite and
    // reports how many stations stood behind it.
    const q = new URLSearchParams();
    if (pm25 != null) q.set("pm25", String(pm25));
    if (opts.aqi != null) q.set("aqi", String(opts.aqi));
    if (opts.station) q.set("station", opts.station);
    if (opts.mode) q.set("mode", opts.mode);
    return request<VentilationAssessment>(
      `/api/ventilation/assessment?${q.toString()}`,
      { signal },
    );
  },
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof NetworkError) return err.message;
  if (err instanceof Error) return err.message;
  return "Unexpected error";
}
