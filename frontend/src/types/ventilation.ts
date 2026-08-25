// Types for the PS 26082 ventilation-forecast layer.
//
// Kept in their own module rather than appended to types/index.ts because this
// layer is independent of the Pathway streaming engine: its endpoints stay
// available when the engine is down, and nothing here should end up coupled to
// the station-centric types by accident.

/** The calibrated decision threshold, and what choosing it costs. */
export interface OperatingPoint {
  mode: string;
  threshold_m2_s: number;
  hit_rate?: number | null;
  false_alarm_rate?: number | null;
  auc_training?: number | null;
  n_train_episodes?: number | null;
  outcome_window_hours?: number | null;
  available_modes?: string[];
  caveat?: string | null;
  source?: string;
  calibrated: boolean;
}

/** One hour of the ventilation outlook. */
export interface VentilationPoint {
  time: string;
  ventilation_m2_s: number;
  blh_m: number;
  wind_ms: number;
  below_threshold: boolean;
}

/** A forecast sustained ventilation collapse. */
export interface Collapse {
  onset: string;
  hours_from_now: number;
  min_ventilation_m2_s: number;
  sustained_hours_below_threshold: number;
}

/**
 * Lead-time states, not severity states. For a disaster-management system the
 * actionable quantity is how long is left to act, so the bands describe the
 * shrinking intervention window rather than how bad the air is.
 */
export type VentilationState =
  | "clear"
  | "watch"
  | "approaching"
  | "imminent"
  | "collapsed"
  | "unknown";

export interface VentilationForecast {
  available: boolean;
  reason?: string;
  generated_at: string;
  location?: { lat: number; lon: number };
  horizon_hours: number;
  operating_point: OperatingPoint;
  state: VentilationState;
  collapse: Collapse | null;
  intervention_window_hours: number | null;
  summary: {
    min_ventilation_m2_s: number;
    max_ventilation_m2_s: number;
    mean_ventilation_m2_s: number;
    hours_below_threshold: number;
  };
  series: VentilationPoint[];
}

export interface VentilationCurrent {
  available: boolean;
  operating_point: OperatingPoint;
  latest: {
    time: string;
    ventilation_m2_s: number;
    blh_m: number;
    wind_ms: number;
    /** Measured, not assumed. Polling cadence is not data freshness. */
    data_age_minutes: number;
  };
  hours_below_threshold_24h: number;
  mean_24h_m2_s: number;
}

export interface EscalationCase {
  opened_at: string;
  jurisdiction: string;
  responsible_authority: string;
  priority: string;
  basis: string;
  trigger_rule: string;
  deadline: string | null;
  intervention_window_hours: number;
  recommended_measures: string[];
  status: string;
  approval_required: boolean;
  note: string;
}

export interface VentilationAssessment {
  assessed_at: string;
  triggered: boolean;
  trigger_rule: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  priority_rationale: string;
  intervention_window_hours: number | null;
  ventilation_state: VentilationState;
  grap_stage_observed: string;
  grap_stage_description: string;
  reasons: string[];
  operating_point: Partial<OperatingPoint>;
  confidence_note: string;
  case: EscalationCase | null;
  observation_provenance?: ObservationProvenance;
}

/**
 * Live ground-truth composite from the CPCB/DPCC network.
 *
 * Separate from the forecast because the two halves of the escalation trigger
 * come from entirely different places: the forecast is numerical weather model
 * output and uses no stations at all, this is measured air.
 */
/** One monitor behind the composite. */
export interface StationReading {
  station: string;
  pm25_ugm3: number;
  lat: number;
  lon: number;
  observed_at: string;
  age_minutes: number;
  location_id: number;
}

export interface ObservedComposite {
  available: boolean;
  reason?: string;
  pm25_ugm3?: number;
  n_stations?: number;
  /** Locations currently reporting at all, before the freshness filter. */
  n_active_locations?: number;
  min?: number;
  max?: number;
  domain?: string;
  served_from_cache?: boolean;
  degraded?: boolean;
  degraded_reason?: string;
  stations?: StationReading[];
  /** Readings older than the freshness window, excluded from the median. */
  n_stale_discarded?: number;
  p25?: number;
  p75?: number;
  newest_observation?: string;
  data_age_minutes?: number;
  source?: string;
}

export interface ObservationProvenance {
  input_source: "live" | "manual";
  n_stations?: number;
  n_stale_discarded?: number;
  data_age_minutes?: number;
  p25?: number;
  p75?: number;
  source?: string;
  note?: string;
}
