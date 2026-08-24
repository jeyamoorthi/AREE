// TypeScript mirrors of the AREE FastAPI response schemas (backend/api/schemas.py).

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  engine_loaded: boolean;
  engine_error: string | null;
}

export interface ApiErrorBody {
  error: string;
  detail: string;
  status_code: number;
  hint?: string;
  errors?: { field: string; message: string }[];
}

export interface BandRange {
  low: number;
  high: number;
  label: string;
}

export interface GrapStageRange {
  low: number;
  high: number;
  stage: string;
  description: string;
}

export interface EngineConfig {
  persistence_threshold: number;
  high_aqi_threshold: number;
  window_duration_minutes: number;
  window_hop_minutes: number;
  hysteresis_confirmations: number;
  aqi_poll_interval: number;
  fire_poll_interval: number;
  fresh_data_threshold_seconds: number;
  stale_data_threshold_seconds: number;
  firms_dataset: string;
  impact_radius_km: number;
  est_population: number;
  vulnerability_multipliers: Record<string, number>;
  cpcb_bands: BandRange[];
  grap_stages: GrapStageRange[];
}

export interface SystemStatus {
  engine_loaded: boolean;
  engine_error: string | null;
  pipeline: string;
  active_stations: number;
  known_stations: number;
  decisions_processed: number;
  escalations_recorded: number;
  /** Freshness breakdown; unavailable counts feeds with no usable AQI. */
  current_stations: number;
  aging_stations: number;
  stale_stations: number;
  unavailable_stations: number;
  rag_status: string | null;
  rag_docs_indexed: number | null;
  llm_ready: boolean | null;
  llm_model: string | null;
  llm_error: string | null;
  server_time: string;
}

export type EngineMode = "TRIGGERED" | "WATCH" | "NORMAL";

export interface StationSummary {
  station: string;
  feed_id: string;
  lat: number | null;
  lon: number | null;
  city: string | null;
  has_data: boolean;
  aqi: number | null;
  cpcb_band: string | null;
  grap_stage: string | null;
  eri_score: number | null;
  eri_category: string | null;
  engine_mode: EngineMode | null;
  transport_label: string | null;
  consecutive_windows: number | null;
  confidence_score: number | null;
  ingestion_status: string | null;
  feed_status: FeedStatus;
  feed_error: string | null;
  feed_last_reading: string | null;
  /** Staleness is independent of availability - do not conflate the two. */
  stale_seconds: number | null;
  freshness_status: FreshnessStatus;
  /** Retained for compatibility: freshness_status === "stale". */
  is_stale: boolean;
  /** WAQI's own debug.sync, UTC ISO. Null when WAQI does not report it. */
  feed_last_sync: string | null;
}

/** Upstream WAQI feed condition for a station. */
export type FeedStatus = "ok" | "awaiting" | "no_aqi" | "error";

/**
 * Reading-age classification from the backend.
 * current 0-90 min | aging >90-120 min | stale >120 min | unavailable no usable AQI.
 * Independent of availability: an unavailable feed is never merely "stale".
 */
export type FreshnessStatus = "current" | "aging" | "stale" | "unavailable";

export interface StationListResponse {
  total: number;
  active: number;
  unavailable: number;
  /** Freshness breakdown across the network. */
  current: number;
  aging: number;
  stale: number;
  stations: StationSummary[];
}

export interface ForecastBlock {
  slope: number;
  direction: "rising" | "falling" | "stable";
  projected_5min: number;
  projected_30min: number;
  predicted_grap: string;
  predicted_grap_30min: string;
  exposure_score_30min: number;
  escalation_eta: number | null;
  anomaly: boolean;
  rate_per_min: number;
  data_points: number;
}

export interface LLMAnalysis {
  summary: string;
  model: string;
  cached: boolean;
  timestamp: number | null;
  risk_trajectory: string;
  regulatory_escalation_likelihood: string;
  public_health_risk: string;
  anomaly_flag: boolean;
}

export interface VulnerableRiskEntry {
  score: number;
  level: string;
  multiplier: number;
}

export interface AQIHistoryPoint {
  timestamp: string | null;
  aqi: number | null;
}

/** Complete engine state for one station (GET /api/stations/{station}). */
export interface StationDetail {
  station: string;
  has_data: boolean;
  feed_id: string;
  lat: number | null;
  lon: number | null;
  city?: string | null;
  aqi: number | null;
  timestamp?: string | null;
  cpcb_band?: string;
  grap_stage?: string;
  grap_description?: string;
  grap_raw_stage?: string;
  previous_stage?: string;
  grap_transitioned?: boolean;
  hysteresis_pending?: string | null;
  hysteresis_count?: number;
  consecutive_windows?: number;
  remaining_windows?: number;
  projected_trigger_time?: string;
  engine_mode?: EngineMode;
  is_stale?: boolean;
  freshness_status?: FreshnessStatus;

  advisory_text?: string;
  governance_rule?: string;
  rag_policy_file?: string;
  rag_similarity_score?: number;
  rag_last_updated?: string;
  rag_index_type?: string;
  rag_docs_indexed?: number;
  rag_embed_model?: string;

  raw_pm25?: number | null;
  raw_pm10?: number | null;
  raw_no2?: number | null;
  raw_so2?: number | null;
  raw_o3?: number | null;
  raw_co?: number | null;
  dominant_pollutant?: string;
  pollutants_available?: number;

  wind_speed?: number | null;
  wind_direction?: number | null;
  waqi_aqi?: number | null;
  waqi_timestamp?: string;
  station_name_api?: string;
  stale_seconds?: number | null;
  /** Authoritative instant, zone-labelled by the backend: "2026-08-21 21:00 IST". */
  waqi_timestamp_local?: string | null;
  /** Same instant in UTC: "2026-08-21 15:30 UTC". */
  waqi_timestamp_utc?: string | null;
  /** WAQI's own debug.sync, UTC ISO. Null when WAQI does not report it. */
  feed_last_sync?: string | null;
  ingestion_status?: string;
  ingestion_error?: string | null;
  api_time?: string;

  fire_count?: number;
  high_conf_fires?: number;
  fire_bbox?: string;
  firms_sync?: string;
  firms_status?: string;
  firms_error?: string | null;
  firms_dataset?: string;
  transport_score?: number;
  aligned_fires?: number;
  transport_label?: string;
  confidence_score?: number;

  forecast?: ForecastBlock | null;
  vulnerable_risk?: Record<string, VulnerableRiskEntry>;
  vulnerability_max?: string;
  preemptive_advisory?: string[];
  llm_analysis?: LLMAnalysis;

  pollution_cause?: string;
  cause_confidence?: number;
  cause_factors?: string[];
  transport_probability?: number;
  fire_centroid?: number[] | null;
  plume_distance_km?: number;
  wind_alignment_deg?: number;
  wind_label?: string;

  avg_aqi_5min?: number | null;
  avg_aqi_15min?: number | null;
  max_aqi_5min?: number | null;
  max_aqi_15min?: number | null;
  aqi_rate_of_change?: number | null;

  eri_score?: number;
  eri_category?: string;
  eri_factors?: string[];

  history?: AQIHistoryPoint[];
}

export interface RankedEntry {
  rank: number;
  station: string;
  value: number | string | null;
  aqi: number | null;
  eri_score: number | null;
}

export interface RankingGroup {
  key: string;
  label: string;
  entries: RankedEntry[];
}

export interface MapPoint {
  station: string;
  lat: number;
  lon: number;
  aqi: number | null;
  cpcb_band: string | null;
  grap_stage: string | null;
  eri_score: number | null;
  engine_mode: EngineMode | null;
  status: string | null;
}

export interface CarbonResponse {
  total_gco2: number;
  decision_count: number;
  per_decision_gco2: number;
  model_note: string;
}

export interface DashboardResponse {
  active_stations: number;
  known_stations: number;
  triggered: number;
  watch: number;
  normal: number;
  map_points: MapPoint[];
  top_aqi: RankedEntry[];
  top_eri: RankedEntry[];
  rankings: RankingGroup[];
  carbon: CarbonResponse;
  escalations_recorded: number;
  server_time: string;
}

export interface PollutantReading {
  name: string;
  key: string;
  value: number | null;
  available: boolean;
}

export interface AQIResponse {
  station: string;
  aqi: number | null;
  cpcb_band: string | null;
  waqi_aqi: number | null;
  waqi_timestamp: string | null;
  station_name_api: string | null;
  feed_id: string | null;
  api_time: string | null;
  stale_seconds: number | null;
  is_stale: boolean;
  dominant_pollutant: string | null;
  pollutants_available: number;
  pollutants: PollutantReading[];
  ingestion_status: string | null;
  ingestion_error: string | null;
  avg_aqi_5min: number | null;
  avg_aqi_15min: number | null;
  max_aqi_5min: number | null;
  max_aqi_15min: number | null;
  aqi_rate_of_change: number | null;
}

export interface AQIHistoryResponse {
  station: string;
  points: AQIHistoryPoint[];
}

export interface DecisionTrace {
  input_aqi: number;
  threshold: number;
  persistence: string;
  hysteresis: string;
  engine_mode: EngineMode;
  escalation: string;
  reason: string;
  stage?: string;
}

export interface GRAPResponse {
  station: string;
  aqi: number | null;
  cpcb_band: string | null;
  grap_stage: string | null;
  grap_raw_stage: string | null;
  grap_description: string | null;
  previous_stage: string | null;
  grap_transitioned: boolean | null;
  hysteresis_pending: string | null;
  hysteresis_count: number;
  consecutive_windows: number;
  remaining_windows: number;
  persistence_percent: number;
  projected_trigger_time: string | null;
  engine_mode: EngineMode;
  governance_rule: string | null;
  decision_trace: DecisionTrace;
}

export interface RiskResponse {
  station: string;
  eri_score: number;
  eri_category: string;
  eri_factors: string[];
  confidence_score: number | null;
  transport_score: number | null;
  transport_label: string | null;
  aligned_fires: number | null;
  fire_count: number | null;
  high_conf_fires: number | null;
  fire_bbox: string | null;
  firms_sync: string | null;
  firms_status: string | null;
  firms_error: string | null;
  firms_dataset: string | null;
  wind_speed: number | null;
  wind_direction: number | null;
  wind_label: string | null;
  pollution_cause: string | null;
  cause_confidence: number | null;
  cause_factors: string[];
  transport_probability: number | null;
  fire_centroid: number[] | null;
  plume_distance_km: number | null;
  wind_alignment_deg: number | null;
}

export interface ForecastResponse {
  station: string;
  available: boolean;
  slope: number | null;
  direction: string | null;
  projected_5min: number | null;
  projected_30min: number | null;
  predicted_grap: string | null;
  predicted_grap_30min: string | null;
  exposure_score_30min: number | null;
  escalation_eta: number | null;
  anomaly: boolean;
  rate_per_min: number | null;
  data_points: number;
  history: AQIHistoryPoint[];
}

export interface VulnerableGroup {
  group: string;
  label: string;
  score: number;
  level: string;
  multiplier: number;
}

export interface HealthImpactResponse {
  station: string;
  available: boolean;
  projected_30min: number | null;
  predicted_grap_30min: string | null;
  exposure_score_30min: number | null;
  mitigation_urgency: string | null;
  vulnerability_max: string | null;
  groups: VulnerableGroup[];
  preemptive_advisory: string[];
  impact_radius_km: number;
  est_population: number;
}

export interface AdvisorySection {
  title: string;
  body: string;
}

export interface AdvisoryResponse {
  station: string;
  advisory_text: string;
  sections: AdvisorySection[];
  governance_rule: string | null;
  rag_policy_file: string | null;
  rag_similarity_score: number | null;
  rag_last_updated: string | null;
  rag_index_type: string | null;
  rag_docs_indexed: number | null;
  rag_embed_model: string | null;
  decision_trace: DecisionTrace;
}

export interface AIResponse {
  station: string;
  summary: string;
  model: string | null;
  cached: boolean;
  timestamp: number | null;
  risk_trajectory: string;
  regulatory_escalation_likelihood: string;
  public_health_risk: string;
  anomaly_flag: boolean;
  temperature: number;
  mode: string;
  /** Why the LLM fell back to deterministic analysis, when it did. */
  error: string | null;
}

export interface EscalationEvent {
  timestamp: string | null;
  city: string | null;
  aqi: number | null;
  from_stage: string | null;
  to_stage: string | null;
  trigger: string | null;
  band: string | null;
}

export interface EscalationsResponse {
  total: number;
  events: EscalationEvent[];
}

export interface PolicyFile {
  name: string;
  size_kb: number;
  modified: string;
  type: string;
  supported: boolean;
  parse_error: string | null;
}

export interface PolicyParseError {
  file: string;
  error: string;
}

export interface PolicyResponse {
  index_type: string | null;
  docs_indexed: number;
  chunks_indexed: number;
  embed_model: string | null;
  last_reindex: string | null;
  store_status: string | null;
  policy_files: PolicyFile[];
  parse_errors: PolicyParseError[];
  error: string | null;
}

export interface PolicyUploadResponse {
  uploaded: string;
  size_bytes: number;
  saved_to: string;
  docs_indexed: number;
  message: string;
}

export interface ReportMetaResponse {
  station: string;
  available: boolean;
  generated_for: string;
  engine_mode: EngineMode;
  aqi: number | null;
  grap_stage: string | null;
  pdf_url: string;
  filename: string;
}

/** Live event pushed over the WebSocket channel. */
export interface LiveEvent {
  type: "snapshot" | "station_update" | "escalation" | "status" | "error";
  station?: string;
  server_time: string;
  payload: unknown;
}
