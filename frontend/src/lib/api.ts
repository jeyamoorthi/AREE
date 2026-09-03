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

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:8000";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      cache: "no-store",
      headers: { Accept: "application/json", ...(init?.headers ?? {}) },
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
      response = await fetch(`${API_URL}/api/policy/upload`, {
        method: "POST",
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

  decideCase: (
    caseId: string,
    body: {
      decision: "approve" | "reject";
      as_of: string;
      actor?: string;
      actor_role?: string;
      reason?: string;
    },
  ) =>
    request<CaseRecord>(`/api/cases/${enc(caseId)}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),

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
