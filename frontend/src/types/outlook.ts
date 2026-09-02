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
    reason?: string;
  };
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

export interface OutlookDecision {
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
}

export interface OutlookResponse {
  as_of: string;
  mode: OutlookMode;
  generated_at: string;
  location: { lat: number; lon: number; grid: string };
  observation: {
    value: number;
    unit: string;
    source: string;
    band: string | null;
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
