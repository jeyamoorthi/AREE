"""Pydantic response schemas for the AREE API.

Models describing engine output use ``extra="allow"`` where the underlying
state dict is intentionally rich: the API must never silently drop a field the
engine produces, but the documented fields stay typed for the frontend.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, ConfigDict, Field


class HealthResponse(BaseModel):
    status: str = "ok"
    service: str = "AREE API"
    version: str
    engine_loaded: bool
    engine_error: Optional[str] = None


class ApiError(BaseModel):
    error: str
    detail: str
    status_code: int
    hint: Optional[str] = None


class EngineConfig(BaseModel):
    """Constants the dashboard needs to explain its own decisions."""
    persistence_threshold: int
    high_aqi_threshold: int
    window_duration_minutes: int
    window_hop_minutes: int
    hysteresis_confirmations: int
    aqi_poll_interval: int
    fire_poll_interval: int
    fresh_data_threshold_seconds: int
    stale_data_threshold_seconds: int
    firms_dataset: str
    impact_radius_km: int
    est_population: int
    vulnerability_multipliers: Dict[str, float]
    cpcb_bands: List[Dict[str, Any]]
    grap_stages: List[Dict[str, Any]]


class SystemStatus(BaseModel):
    engine_loaded: bool
    engine_error: Optional[str] = None
    pipeline: str
    #: Which engine is actually running: "streaming" (Pathway) or "direct".
    #: Published because the dashboard used to print "Pathway pipeline - Running" as a
    #: literal string regardless of what had started, and the footer advertised four
    #: subsystems that direct mode does not have.
    mode: Optional[str] = None
    #: True when subsystems are unavailable in the running mode (RAG, event-time windows).
    degraded: bool = False
    active_stations: int
    known_stations: int
    decisions_processed: int
    escalations_recorded: int
    #: Freshness breakdown. Independent of availability: unavailable counts
    #: feeds with no usable AQI, never merely old ones.
    current_stations: int = 0
    aging_stations: int = 0
    stale_stations: int = 0
    unavailable_stations: int = 0
    rag_status: Optional[str] = None
    rag_docs_indexed: Optional[int] = None
    llm_ready: Optional[bool] = None
    llm_model: Optional[str] = None
    llm_error: Optional[str] = None
    server_time: str


class StationSummary(BaseModel):
    model_config = ConfigDict(extra="allow")

    station: str
    feed_id: str = ""
    lat: Optional[float] = None
    lon: Optional[float] = None
    city: Optional[str] = None
    has_data: bool = False
    aqi: Optional[int] = None
    cpcb_band: Optional[str] = None
    grap_stage: Optional[str] = None
    eri_score: Optional[int] = None
    eri_category: Optional[str] = None
    engine_mode: Optional[str] = None
    transport_label: Optional[str] = None
    consecutive_windows: Optional[int] = None
    confidence_score: Optional[int] = None
    ingestion_status: Optional[str] = None
    # Upstream feed condition: ok | awaiting | no_aqi | error
    feed_status: str = "awaiting"
    feed_error: Optional[str] = None
    feed_last_reading: Optional[str] = None
    #: Staleness is orthogonal to availability: a station can be online and
    #: current, online but stale, or have no usable feed at all.
    stale_seconds: Optional[float] = None
    #: current | aging | stale | unavailable
    freshness_status: str = "unavailable"
    #: Retained for compatibility: freshness_status == "stale".
    is_stale: bool = False
    feed_last_sync: Optional[str] = None


class StationListResponse(BaseModel):
    total: int
    active: int
    #: Stations whose upstream feed is dormant or failing.
    unavailable: int = 0
    #: Freshness breakdown across the network.
    current: int = 0
    aging: int = 0
    stale: int = 0
    stations: List[StationSummary]


class StationDetail(BaseModel):
    """Full per-station engine state (every field latest_state holds)."""
    model_config = ConfigDict(extra="allow")

    station: str
    has_data: bool
    feed_id: str = ""
    lat: Optional[float] = None
    lon: Optional[float] = None
    aqi: Optional[int] = None
    #: current | aging | stale | unavailable
    freshness_status: str = "current"
    #: Presentation of the authoritative `time.iso` value, zone-labelled.
    waqi_timestamp_local: Optional[str] = None
    waqi_timestamp_utc: Optional[str] = None
    #: WAQI's own `debug.sync`; null when WAQI does not report it.
    feed_last_sync: Optional[str] = None


class RankedEntry(BaseModel):
    rank: int
    station: str
    value: Any
    aqi: Optional[int] = None
    eri_score: Optional[int] = None


class RankingGroup(BaseModel):
    key: str
    label: str
    entries: List[RankedEntry]


class MapPoint(BaseModel):
    station: str
    lat: float
    lon: float
    aqi: Optional[int] = None
    cpcb_band: Optional[str] = None
    grap_stage: Optional[str] = None
    eri_score: Optional[int] = None
    engine_mode: Optional[str] = None
    status: Optional[str] = None


class DashboardResponse(BaseModel):
    active_stations: int
    known_stations: int
    triggered: int
    watch: int
    normal: int
    map_points: List[MapPoint]
    top_aqi: List[RankedEntry]
    top_eri: List[RankedEntry]
    rankings: List[RankingGroup]
    carbon: Dict[str, Any]
    escalations_recorded: int
    server_time: str


class PollutantReading(BaseModel):
    name: str
    key: str
    value: Optional[float] = None
    available: bool


class AQIResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    station: str
    aqi: Optional[int] = None
    cpcb_band: Optional[str] = None
    waqi_aqi: Optional[int] = None
    waqi_timestamp: Optional[str] = None
    station_name_api: Optional[str] = None
    feed_id: Optional[str] = None
    api_time: Optional[str] = None
    stale_seconds: Optional[float] = None
    #: current | aging | stale | unavailable
    freshness_status: str = "current"
    #: Retained for compatibility: freshness_status == "stale".
    is_stale: bool = False
    #: Same instant as waqi_timestamp, rendered with an explicit zone label.
    waqi_timestamp_local: Optional[str] = None
    waqi_timestamp_utc: Optional[str] = None
    #: WAQI's own `debug.sync` - when it last ingested this station. Never
    #: fabricated; null when WAQI does not report it.
    feed_last_sync: Optional[str] = None
    dominant_pollutant: Optional[str] = None
    pollutants_available: int = 0
    pollutants: List[PollutantReading] = Field(default_factory=list)
    #: Concentrations can come from a different, slower feed than the AQI
    #: above them. Both are published so neither is read as the other's age.
    pollutant_source: Optional[str] = None
    pollutant_age_minutes: Optional[int] = None
    ingestion_status: Optional[str] = None
    ingestion_error: Optional[str] = None
    avg_aqi_5min: Optional[float] = None
    avg_aqi_15min: Optional[float] = None
    max_aqi_5min: Optional[float] = None
    max_aqi_15min: Optional[float] = None
    aqi_rate_of_change: Optional[float] = None


class AQIHistoryPoint(BaseModel):
    timestamp: Optional[str] = None
    aqi: Optional[int] = None


class AQIHistoryResponse(BaseModel):
    station: str
    points: List[AQIHistoryPoint]


class GRAPResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    station: str
    aqi: Optional[int] = None
    cpcb_band: Optional[str] = None
    grap_stage: Optional[str] = None
    grap_raw_stage: Optional[str] = None
    grap_description: Optional[str] = None
    previous_stage: Optional[str] = None
    grap_transitioned: Optional[bool] = None
    hysteresis_pending: Optional[str] = None
    hysteresis_count: int = 0
    consecutive_windows: int = 0
    remaining_windows: int = 0
    persistence_percent: int = 0
    projected_trigger_time: Optional[str] = None
    engine_mode: str = "NORMAL"
    governance_rule: Optional[str] = None
    decision_trace: Dict[str, Any] = Field(default_factory=dict)


class RiskResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    station: str
    # Optional because direct mode does not compute ERI. A non-optional int with
    # a 0 default does not merely permit a fabricated value, it REQUIRES one - the
    # route had no way to say "not computed" while satisfying this schema.
    eri_score: Optional[int] = None
    eri_category: Optional[str] = None
    eri_factors: List[str] = Field(default_factory=list)
    confidence_score: Optional[int] = None
    transport_score: Optional[int] = None
    transport_label: Optional[str] = None
    aligned_fires: Optional[int] = None
    fire_count: Optional[int] = None
    high_conf_fires: Optional[int] = None
    fire_bbox: Optional[str] = None
    firms_sync: Optional[str] = None
    firms_status: Optional[str] = None
    firms_error: Optional[str] = None
    firms_dataset: Optional[str] = None
    wind_speed: Optional[float] = None
    wind_direction: Optional[float] = None
    wind_label: Optional[str] = None
    pollution_cause: Optional[str] = None
    cause_confidence: Optional[float] = None
    cause_factors: List[str] = Field(default_factory=list)
    transport_probability: Optional[float] = None
    fire_centroid: Optional[List[float]] = None
    plume_distance_km: Optional[float] = None
    wind_alignment_deg: Optional[float] = None


class ForecastResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    station: str
    available: bool
    slope: Optional[float] = None
    direction: Optional[str] = None
    projected_5min: Optional[int] = None
    projected_30min: Optional[int] = None
    predicted_grap: Optional[str] = None
    predicted_grap_30min: Optional[str] = None
    exposure_score_30min: Optional[int] = None
    escalation_eta: Optional[float] = None
    anomaly: bool = False
    rate_per_min: Optional[float] = None
    data_points: int = 0
    history: List[AQIHistoryPoint] = Field(default_factory=list)


class VulnerableGroup(BaseModel):
    group: str
    label: str
    score: int
    level: str
    multiplier: float


class HealthImpactResponse(BaseModel):
    station: str
    available: bool
    projected_30min: Optional[int] = None
    predicted_grap_30min: Optional[str] = None
    exposure_score_30min: Optional[int] = None
    mitigation_urgency: Optional[str] = None
    vulnerability_max: Optional[str] = None
    groups: List[VulnerableGroup] = Field(default_factory=list)
    preemptive_advisory: List[str] = Field(default_factory=list)
    impact_radius_km: int = 0
    est_population: int = 0


class AdvisorySection(BaseModel):
    title: str
    body: str


class AdvisoryResponse(BaseModel):
    station: str
    advisory_text: str = ""
    sections: List[AdvisorySection] = Field(default_factory=list)
    governance_rule: Optional[str] = None
    rag_policy_file: Optional[str] = None
    rag_similarity_score: Optional[float] = None
    rag_last_updated: Optional[str] = None
    rag_index_type: Optional[str] = None
    rag_docs_indexed: Optional[int] = None
    rag_embed_model: Optional[str] = None
    decision_trace: Dict[str, Any] = Field(default_factory=dict)


class AIResponse(BaseModel):
    model_config = ConfigDict(extra="allow")

    station: str
    summary: str = ""
    model: Optional[str] = None
    cached: bool = False
    timestamp: Optional[float] = None
    risk_trajectory: str = "unknown"
    regulatory_escalation_likelihood: str = "unknown"
    public_health_risk: str = "unknown"
    anomaly_flag: bool = False
    temperature: float = 0.1
    mode: str = "Structured JSON"
    #: Why the engine fell back to deterministic analysis, when it did.
    error: Optional[str] = None


class CarbonResponse(BaseModel):
    total_gco2: float = 0.0
    decision_count: int = 0
    per_decision_gco2: float = 0.0
    model_note: str = "Carbon model: deterministic per-event cost assumption"


class EscalationEvent(BaseModel):
    model_config = ConfigDict(extra="allow")

    timestamp: Optional[str] = None
    city: Optional[str] = None
    aqi: Optional[int] = None
    from_stage: Optional[str] = None
    to_stage: Optional[str] = None
    trigger: Optional[str] = None
    band: Optional[str] = None


class EscalationsResponse(BaseModel):
    total: int
    events: List[EscalationEvent]


class PolicyFile(BaseModel):
    name: str
    size_kb: float
    modified: str
    #: File extension without the dot (txt / pdf / docx).
    type: str = "unknown"
    #: Whether a parser exists for this format.
    supported: bool = True
    #: Why this document could not be indexed, when applicable.
    parse_error: Optional[str] = None


class PolicyParseError(BaseModel):
    file: str
    error: str


class PolicyResponse(BaseModel):
    index_type: Optional[str] = None
    docs_indexed: int = 0
    chunks_indexed: int = 0
    embed_model: Optional[str] = None
    last_reindex: Optional[str] = None
    store_status: Optional[str] = None
    policy_files: List[PolicyFile] = Field(default_factory=list)
    parse_errors: List[PolicyParseError] = Field(default_factory=list)
    error: Optional[str] = None


class PolicyUploadResponse(BaseModel):
    uploaded: str
    size_bytes: int
    saved_to: str
    docs_indexed: int
    message: str


class ReportMetaResponse(BaseModel):
    station: str
    available: bool
    generated_for: str
    engine_mode: str
    aqi: Optional[int] = None
    grap_stage: Optional[str] = None
    pdf_url: str
    filename: str
