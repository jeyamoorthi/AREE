# Pathway-native GRAP state machine and persistence engine
# All state tracked per-station inside Pathway transforms

from config import (
    PERSISTENCE_THRESHOLD, HIGH_AQI_THRESHOLD,
    HYSTERESIS_CONFIRMATIONS, GRAP_STAGES, CPCB_BANDS,
)


# --- Persistence Tracker (stateful UDF for pw.apply) ---

class PersistenceTracker:
    """
    Tracks consecutive high-AQI windows per station.
    Used as a stateful UDF inside the Pathway DAG.
    """
    def __init__(self, threshold=HIGH_AQI_THRESHOLD):
        self._consecutive = {}  # station -> count
        self.threshold = threshold

    def update(self, station, aqi):
        if aqi >= self.threshold:
            self._consecutive[station] = self._consecutive.get(station, 0) + 1
        else:
            self._consecutive[station] = 0

        consec = self._consecutive[station]
        remaining = max(0, PERSISTENCE_THRESHOLD - consec)
        triggered = consec >= PERSISTENCE_THRESHOLD

        return {
            "consecutive_windows": consec,
            "remaining_windows": remaining,
            "persistence_triggered": triggered,
        }


# --- GRAP State Machine (stateful UDF for pw.apply) ---

class GRAPStateMachine:
    """
    GRAP escalation state machine with hysteresis.
    Prevents oscillation by requiring multiple confirmations
    before transitioning between stages.
    """
    def __init__(self):
        # per-station state: {stage, pending_stage, confirm_count}
        self._state = {}

    def _compute_raw_stage(self, aqi):
        if aqi is None:
            return "None", "No data"
        for lo, hi, stage, desc in GRAP_STAGES:
            if lo <= aqi <= hi:
                return stage, desc
        return "Stage IV (Severe+)", "Emergency actions under GRAP Stage IV"

    def _compute_band(self, aqi):
        if aqi is None:
            return "Unknown"
        for lo, hi, label in CPCB_BANDS:
            if lo <= aqi <= hi:
                return label
        return "Severe"

    def update(self, station, aqi):
        raw_stage, grap_desc = self._compute_raw_stage(aqi)
        band = self._compute_band(aqi)

        if station not in self._state:
            self._state[station] = {
                "stage": "None",
                "pending": None,
                "count": 0,
            }

        rec = self._state[station]
        previous_stage = rec["stage"]
        transitioned = False

        if raw_stage == rec["stage"]:
            # same stage, reset pending
            rec["pending"] = None
            rec["count"] = 0
        elif raw_stage == rec.get("pending"):
            # same pending stage, increment confirmation
            rec["count"] += 1
            if rec["count"] >= HYSTERESIS_CONFIRMATIONS:
                rec["stage"] = raw_stage
                rec["pending"] = None
                rec["count"] = 0
                transitioned = True
        else:
            # new pending stage
            rec["pending"] = raw_stage
            rec["count"] = 1

        self._state[station] = rec

        return {
            "grap_stage": rec["stage"],
            "grap_raw_stage": raw_stage,
            "grap_description": grap_desc,
            "cpcb_band": band,
            "previous_stage": previous_stage,
            "grap_transitioned": transitioned,
            "hysteresis_pending": rec["pending"],
            "hysteresis_count": rec["count"],
        }


# --- Combined Streaming State Engine ---

class StreamingStateEngine:
    """
    Unified state engine combining persistence + GRAP.
    Single entry point for the Pathway pw.apply UDF.
    """
    def __init__(self):
        self.persistence = PersistenceTracker()
        self.grap = GRAPStateMachine()

    def process(self, station, aqi):
        """
        Process a single observation through the full state pipeline.
        Returns combined state dict.
        """
        p = self.persistence.update(station, aqi)
        g = self.grap.update(station, aqi)

        return {
            # persistence
            "consecutive_windows": p["consecutive_windows"],
            "remaining_windows": p["remaining_windows"],
            "persistence_triggered": p["persistence_triggered"],
            # GRAP
            "grap_stage": g["grap_stage"],
            "grap_raw_stage": g["grap_raw_stage"],
            "grap_description": g["grap_description"],
            "cpcb_band": g["cpcb_band"],
            "previous_stage": g["previous_stage"],
            "grap_transitioned": g["grap_transitioned"],
            "hysteresis_pending": g["hysteresis_pending"],
            "hysteresis_count": g["hysteresis_count"],
        }
