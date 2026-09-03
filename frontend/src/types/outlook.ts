// Mirrors GET /api/aree/outlook exactly.
//
// The backend is the authority on every number and every decision in here.
// Nothing in the UI recomputes a threshold, a status or a GRAP stage - it
// renders what the contract returns. If a field is missing from this file it
// is because the API does not send it, not because the UI derives it.

export type OutlookMode = "live" | "replay";

/** The primary state. UI branches on THIS, never on forecast_risk. */
export type OutlookStatus =
  | "SEVERE_EPISODE_UNDERWAY"
  | "PREDICTIVE_WARNING"
  | "EPISODE_UNDERWAY"
  | "MONITOR";

export interface OutlookPoint {
  valid_at: string;
  lead_hours: number;
  as_of: string;
  mode: OutlookMode;
  /** Conditional median. The line to draw. */
  central: number;
  /** Conditional 90th percentile. Upper-tail RISK, never a prediction. */
  upper: number;
  central_model: string;
  upper_model: string;
  ventilation_m2_s: number | null;
  blh_m: number | null;
  wind_ms: number | null;
  target_source: string;
  feature_source: string;
}

export interface OutlookTrend {
  available: boolean;
  now?: number;
  min?: number;
  max?: number;
  direction?: "falling" | "rising" | "steady";
  unit?: string;
}

export interface VentilationTrend extends OutlookTrend {
  threshold_m2_s: number | null;
  hours_below_threshold: number | null;
  sustained_low_now: boolean | null;
}

export interface OutlookInversion {
  available: boolean;
  strength_k?: number;
  capping?: boolean;
  lapse_rate_k_per_km?: number | null;
  reason?: string;
}

export interface VentilationCollapse {
  onset: string;
  hours_from_now: number | null;
  min_ventilation_m2_s: number;
  sustained_hours_below_threshold: number;
}

export interface VentilationBand {
  label: string;
  hours: number;
  colour: string;
  share: number;
}

export interface VentilationProfile {
  available: boolean;
  statistics?: { min: number; mean: number; max: number; hours: number };
  distribution?: VentilationBand[];
  hours_below_24h?: number;
  share_below_24h?: number;
  components?: {
    blh_m: number | null;
    wind_ms: number | null;
    ventilation_m2_s: number | null;
  };
}

export interface OutlookOperatingPoint {
  mode?: string;
  threshold_m2_s?: number;
  /** TRAINING skill (143 episodes). Never label these "validation". */
  hit_rate?: number | null;
  false_alarm_rate?: number | null;
  /** HELD-OUT skill (11 episodes) — materially worse, and the honest number to show. */
  holdout_hit_rate?: number | null;
  holdout_false_alarm_rate?: number | null;
  n_holdout_episodes?: number | null;
  auc_training?: number | null;
  n_train_episodes?: number | null;
  outcome_window_hours?: number | null;
  calibrated?: boolean;
  caveat?: string | null;
}

export interface OutlookAtmosphere {
  ventilation: VentilationTrend;
  pblh: OutlookTrend;
  wind: OutlookTrend;
  inversion: OutlookInversion;
  ventilation_forecast: {
    available: boolean;
    state?: string;
    collapse?: VentilationCollapse | null;
    intervention_window_hours?: number | null;
    operating_point?: OutlookOperatingPoint;
    reason?: string;
  };
  ventilation_profile: VentilationProfile;
}

export interface OutlookPlume {
  available: boolean;
  influence: number | null;
  detections_24h: number;
  total_frp_24h: number;
  source: string;
  note: string;
}

export interface OutlookRisk {
  status: OutlookStatus;
  status_detail: string;
  /**
   * Presentation composed by the backend, so the UI renders a state rather than
   * deriving one. Never infer from `forecast_risk` or a PM2.5 comparison: the engine
   * tests SEVERE before forecast_risk, so a continuing episode is not a new warning,
   * and a UI that re-derives will disagree with the decision it is displaying.
   */
  status_label: string;
  status_short: string;
  status_tone: "critical" | "warning" | "elevated" | "calm";
  severe_episode_underway: boolean;
  forecast_risk: boolean;
  first_crossing: string | null;
  lead_hours: number | null;
  threshold_ugm3: number;
  min_sustained_hours: number;
  trigger_source: string;
  central_at_crossing: number | null;
  upper_at_crossing: number | null;
  sustained_hours: number | null;
  peak_upper_ugm3?: number | null;
  peak_central_ugm3?: number | null;
  reason?: string;
}

export interface CaseAction {
  action_id: number;
  action: "OPENED" | "APPROVED" | "REJECTED";
  actor: string | null;
  actor_role: string | null;
  /** Always false in this build — there is no authentication. */
  actor_verified: boolean;
  timestamp: string;
  reason: string | null;
}

export interface CaseRecord {
  case_id: string;
  created_at: string;
  status: "AWAITING_APPROVAL" | "APPROVED" | "REJECTED";
  risk_status: string | null;
  priority: string | null;
  trigger: string | null;
  jurisdiction: string | null;
  mode: string | null;
  forecast_as_of: string;
  crossing_at: string | null;
  actions: CaseAction[];
  identity?: { authenticated: boolean; note: string };
}

export interface CasesResponse {
  total: number;
  counts: Record<string, number>;
  cases: (Omit<CaseRecord, "actions"> & {
    decided_at: string | null;
    decided_by: string | null;
  })[];
  identity: { authenticated: boolean; note: string };
}

export interface OutlookDecision {
  /** Deterministic id, derived from the forecast moment. Null when nothing triggered. */
  case_id: string | null;
  /** Persisted status when a decision exists, else the engine's proposal. */
  case_status: string | null;
  case_decided: boolean;
  grap_stage_observed: string;
  grap_stage_description: string;
  triggered: boolean;
  trigger_rule: string;
  priority: string;
  priority_rationale: string;
  reasons: string[];
  intervention_window_hours: number | null;
  approval_state: string;
  approval_required: boolean;
  recommended_measures: string[];
  responsible_authority: string;
  note: string;
  /** The call, the reason, and what to do next — composed by the backend. */
  recommendation: OutlookRecommendation;
}

export interface MechanismLink {
  available: boolean;
  label: string;
  unit?: string;
  now?: number;
  low?: number;
  change_pct?: number | null;
  direction?: "falling" | "steady";
  better_when?: string;
}

export interface OutlookMechanism {
  available: boolean;
  links: MechanismLink[];
  dispersion: { verdict: string; threshold_m2_s: number | null };
  consequence: string;
}

export interface TimelineMark {
  at: string;
  kind: "now" | "collapse" | "minimum" | "recovery" | "peak_risk";
  state: string;
  consequence: string;
  hours_from_now: number;
}

export interface ExposureStation {
  station: string;
  place: string;
  pm25: number;
  /** CPCB severity band. Classified by the backend, never by the UI. */
  band: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Who measured it, e.g. "CPCB CAAQMS via data.gov.in". Null when not recorded. */
  source?: string | null;
}

/**
 * What the spatial panel received for this hour.
 *
 *   network         real station-level rows AT OR BEFORE as_of
 *   composite_only  no station rows exist for that moment; the target is a composite
 *                   (for Nov 2022-24, of a single monitor)
 *   none            nothing stored at all
 *
 * Branch on `kind`. The panel must never fall back to "the latest data we have" - that
 * is precisely how a November 2024 replay came to display the September 2026 network.
 */
export type ExposureKind = "network" | "composite_only" | "none";

export interface OutlookExposure {
  available: boolean;
  kind?: ExposureKind;
  /** The hour these readings describe. Never after as_of. */
  observed_at?: string;
  /** The anchor this was resolved against, echoed for checking. */
  as_of?: string;
  /** How far before as_of `observed_at` sits. */
  age_hours?: number;
  n_stations?: number;
  worst?: ExposureStation[];
  /** Every positioned station, for the spatial panel. */
  points?: ExposureStation[];
  median_pm25?: number;
  spread_pm25?: number;

  /** composite_only: the value the target rests on, and how many monitors made it. */
  composite_pm25?: number;
  n_monitors?: number | null;
  series?: string;
  source?: string;

  reason?: string;
}

export interface OutlookRecommendation {
  call: string;
  tone: "critical" | "warning" | "calm";
  because: string;
  next_step: string;
}

export interface OutlookResponse {
  as_of: string;
  mode: OutlookMode;
  generated_at: string;
  location: { lat: number; lon: number; grid: string };
  observation: {
    value: number;
    unit: string;
    band: string | null;
    /** The hour this value describes. */
    observed_at: string;
    /** Which target series: the historical composite, or the live network median. */
    target: "legacy" | "network";
    target_label: string;
    /**
     * Monitors behind the value, read from the stored row. NULL where the store does
     * not record it — a UI must then say nothing rather than substitute a live count.
     * Replay of Nov 2024 reports 1; a live hour reports the number in that median.
     */
    n_stations: number | null;
    source: string;
  };
  forecast: {
    horizon_hours: number;
    labels: Record<string, string>;
    summary: {
      central_max: number;
      upper_max: number;
      central_mean: number;
    };
    series: OutlookPoint[];
  };
  narrative: { headline: string; detail: string };
  mechanism: OutlookMechanism;
  timeline: TimelineMark[];
  exposure: OutlookExposure;
  atmosphere: OutlookAtmosphere;
  plume: OutlookPlume;
  risk: OutlookRisk;
  decision: OutlookDecision;
  provenance: {
    target_source: string;
    feature_source: string;
    models: Record<string, string>;
    note: string;
    aggregated_by: string;
    warning_rule: {
      threshold_ugm3: number;
      min_sustained_hours: number;
      signal: string;
      validated_by: string;
    };
  };
}
