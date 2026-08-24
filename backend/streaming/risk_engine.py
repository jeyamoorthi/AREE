# Causal environmental attribution + transport vector model
# Deterministic analysis inside the Pathway DAG via pw.apply

import math
from config import STATIONS


# --- Causal Attribution Engine ---

class CausalAttributionEngine:
    """
    Deterministic causal analysis combining fire, wind, and AQI data.
    Called via pw.apply inside the Pathway DAG.
    """

    # wind direction labels for human-readable output
    DIRECTIONS = [
        (0, 22.5, "N"), (22.5, 67.5, "NE"), (67.5, 112.5, "E"),
        (112.5, 157.5, "SE"), (157.5, 202.5, "S"), (202.5, 247.5, "SW"),
        (247.5, 292.5, "W"), (292.5, 337.5, "NW"), (337.5, 360, "N"),
    ]

    @staticmethod
    def _wind_label(deg):
        if deg is None:
            return "unknown"
        for lo, hi, label in CausalAttributionEngine.DIRECTIONS:
            if lo <= deg < hi:
                return label
        return "unknown"

    @staticmethod
    def analyze(aqi, aqi_trend, fire_count, wind_speed, wind_direction,
                pm10=None, pm25=None, transport_score=0):
        """
        Determine probable pollution cause from environmental signals.

        Returns dict with:
            pollution_cause: str
            cause_confidence: float (0-1)
            cause_factors: list[str]
        """
        cause = "undetermined"
        confidence = 0.0
        factors = []

        wind_label = CausalAttributionEngine._wind_label(wind_direction)
        has_fire = fire_count is not None and fire_count > 0
        has_wind = wind_speed is not None and wind_speed >= 2.0
        is_rising = aqi_trend in ("rising", "rapidly_rising")

        # Rule 1: Crop burning / regional transport
        if has_fire and fire_count >= 30 and has_wind and is_rising:
            cause = "crop_burning_transport"
            confidence = min(0.95, 0.5 + (fire_count / 100) + (transport_score / 200))
            factors = [
                f"{fire_count} thermal anomalies detected",
                f"Wind {wind_speed:.1f} m/s from {wind_label}",
                f"AQI trend: {aqi_trend}",
                f"Transport score: {transport_score}/100",
            ]

        # Rule 2: Moderate fire activity with some transport
        elif has_fire and fire_count >= 5 and has_wind and transport_score > 20:
            cause = "possible_regional_transport"
            confidence = min(0.75, 0.3 + (fire_count / 50) + (transport_score / 200))
            factors = [
                f"{fire_count} fires detected upwind",
                f"Transport score: {transport_score}/100",
            ]

        # Rule 3: Low wind + AQI rising → local accumulation
        elif (not has_wind or (wind_speed is not None and wind_speed < 2.0)) and is_rising:
            cause = "local_accumulation"
            confidence = 0.7
            factors = [
                "Low wind speed (< 2.0 m/s)",
                f"AQI trend: {aqi_trend}",
                "Pollutants accumulating locally",
            ]

        # Rule 4: PM10 spike → dust / construction / industrial
        elif pm10 is not None and pm25 is not None and pm10 > 0:
            ratio = pm10 / max(pm25, 1)
            if ratio > 2.5 and aqi >= 150:
                cause = "dust_or_construction"
                confidence = 0.65
                factors = [
                    f"PM10/PM2.5 ratio: {ratio:.1f} (high coarse fraction)",
                    "Likely dust resuspension or construction activity",
                ]
            elif pm10 > 200:
                cause = "industrial_emissions"
                confidence = 0.6
                factors = [
                    f"PM10: {pm10} (elevated)",
                    "Industrial emission pattern suspected",
                ]

        # Rule 5: High AQI but no clear attribution
        elif aqi >= 200:
            cause = "mixed_sources"
            confidence = 0.4
            factors = [
                f"AQI {aqi} elevated",
                "Multiple potential sources, no dominant signal",
            ]

        # Rule 6: Normal conditions
        else:
            cause = "background_pollution"
            confidence = 0.3
            factors = ["No anomalous conditions detected"]

        confidence = round(min(1.0, max(0.0, confidence)), 3)

        return {
            "pollution_cause": cause,
            "cause_confidence": confidence,
            "cause_factors": factors,
            "wind_label": wind_label,
        }


# --- Transport Vector Model ---

class TransportVectorModel:
    """
    Simplified plume transport probability model.
    Estimates likelihood that upwind fires are contributing
    to pollution at a monitoring station.

    Uses: fire centroid → wind vector → distance decay
    → station intersection → transport_probability
    """

    @staticmethod
    def _haversine_km(lat1, lon1, lat2, lon2):
        R = 6371.0
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        a = (math.sin(dlat / 2) ** 2 +
             math.cos(math.radians(lat1)) *
             math.cos(math.radians(lat2)) *
             math.sin(dlon / 2) ** 2)
        return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))

    @staticmethod
    def _bearing_deg(lat1, lon1, lat2, lon2):
        dlon = math.radians(lon2 - lon1)
        y = math.sin(dlon) * math.cos(math.radians(lat2))
        x = (math.cos(math.radians(lat1)) * math.sin(math.radians(lat2)) -
             math.sin(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.cos(dlon))
        return (math.degrees(math.atan2(y, x)) + 360) % 360

    @staticmethod
    def compute(station_key, fires, wind_dir, wind_speed):
        """
        Compute transport probability from fire data + wind vector.

        Args:
            station_key: station identifier to look up lat/lon
            fires: list of fire dicts with lat, lon, frp, confidence
            wind_dir: wind direction in degrees (wind blows FROM this direction)
            wind_speed: wind speed in m/s

        Returns dict:
            transport_probability: float 0-1
            fire_centroid: (lat, lon) or None
            plume_distance_km: float
            wind_alignment_deg: float
        """
        if not fires or wind_dir is None or wind_speed is None or wind_speed < 1.0:
            return {
                "transport_probability": 0.0,
                "fire_centroid": None,
                "plume_distance_km": 0.0,
                "wind_alignment_deg": 0.0,
            }

        station = STATIONS.get(station_key, {})
        slat = station.get("lat", 0)
        slon = station.get("lon", 0)

        if slat == 0 and slon == 0:
            return {
                "transport_probability": 0.0,
                "fire_centroid": None,
                "plume_distance_km": 0.0,
                "wind_alignment_deg": 0.0,
            }

        # compute fire centroid (FRP-weighted)
        total_frp = sum(max(f.get("frp", 1), 0.1) for f in fires)
        centroid_lat = sum(f["lat"] * max(f.get("frp", 1), 0.1) for f in fires) / total_frp
        centroid_lon = sum(f["lon"] * max(f.get("frp", 1), 0.1) for f in fires) / total_frp

        # distance from fire centroid to station
        distance_km = TransportVectorModel._haversine_km(
            centroid_lat, centroid_lon, slat, slon
        )

        # bearing from station to fire centroid
        bearing = TransportVectorModel._bearing_deg(slat, slon, centroid_lat, centroid_lon)

        # wind alignment: fire is upwind if bearing ≈ wind_dir
        # wind blows FROM wind_dir, so fires AT wind_dir heading are upwind
        alignment_diff = abs(bearing - wind_dir)
        if alignment_diff > 180:
            alignment_diff = 360 - alignment_diff

        # transport probability model
        # Factor 1: wind alignment (max at 0°, zero at >90°)
        if alignment_diff <= 45:
            alignment_factor = 1.0 - (alignment_diff / 90.0)
        elif alignment_diff <= 90:
            alignment_factor = 0.5 - (alignment_diff - 45) / 90.0
        else:
            alignment_factor = 0.0

        # Factor 2: distance decay (closer = higher probability)
        # Plume can travel ~50-200km depending on wind speed
        max_range_km = min(300, 50 + wind_speed * 20)
        if distance_km <= max_range_km:
            distance_factor = 1.0 - (distance_km / max_range_km) ** 0.5
        else:
            distance_factor = 0.0

        # Factor 3: wind speed (stronger wind = higher transport)
        wind_factor = min(1.0, wind_speed / 8.0)

        # Factor 4: fire intensity (more fires = higher probability)
        fire_factor = min(1.0, len(fires) / 20.0)

        # Combined probability
        transport_prob = (
            alignment_factor * 0.35 +
            distance_factor * 0.25 +
            wind_factor * 0.20 +
            fire_factor * 0.20
        )

        transport_prob = round(min(1.0, max(0.0, transport_prob)), 3)

        return {
            "transport_probability": transport_prob,
            "fire_centroid": (round(centroid_lat, 4), round(centroid_lon, 4)),
            "plume_distance_km": round(distance_km, 1),
            "wind_alignment_deg": round(alignment_diff, 1),
        }


# --- Combined Environmental Intelligence ---

def compute_environmental_intelligence(
    station, aqi, aqi_trend, fire_count, fires,
    wind_speed, wind_direction, transport_score,
    pm10=None, pm25=None,
):
    """
    Full environmental intelligence computation.
    Single entry point for pw.apply in the Pathway DAG.
    """
    # causal attribution
    causal = CausalAttributionEngine.analyze(
        aqi=aqi, aqi_trend=aqi_trend, fire_count=fire_count,
        wind_speed=wind_speed, wind_direction=wind_direction,
        pm10=pm10, pm25=pm25, transport_score=transport_score,
    )

    # transport vector model
    transport = TransportVectorModel.compute(
        station_key=station, fires=fires or [],
        wind_dir=wind_direction, wind_speed=wind_speed,
    )

    return {
        "pollution_cause": causal["pollution_cause"],
        "cause_confidence": causal["cause_confidence"],
        "cause_factors": causal["cause_factors"],
        "wind_label": causal["wind_label"],
        "transport_probability": transport["transport_probability"],
        "fire_centroid": transport["fire_centroid"],
        "plume_distance_km": transport["plume_distance_km"],
        "wind_alignment_deg": transport["wind_alignment_deg"],
    }
