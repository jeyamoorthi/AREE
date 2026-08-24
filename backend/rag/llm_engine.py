# Gemini structured risk interpretation
# Returns JSON only. Used for explanation, not enforcement.

import json
import os
import time
import google.generativeai as genai
from config import GEMINI_API_KEY, GEMINI_MODEL

# Last error seen from Gemini, surfaced through the API so a retired model id or
# an expired key is visible instead of silently degrading to the fallback.
_llm_status = {
    "configured": bool(GEMINI_API_KEY),
    "model": GEMINI_MODEL,
    "ready": False,
    "last_error": None,
}

_model = None
if GEMINI_API_KEY:
    try:
        genai.configure(api_key=GEMINI_API_KEY)
        _model = genai.GenerativeModel(GEMINI_MODEL)
        _llm_status["ready"] = True
        print(f"[LLM] gemini ready ({GEMINI_MODEL})")
    except Exception as e:
        _llm_status["last_error"] = f"init failed: {e}"
        print(f"[LLM] init failed: {e}")
else:
    _llm_status["last_error"] = "GEMINI_API_KEY not set"
    print("[LLM] GEMINI_API_KEY not set - deterministic analysis only")


def get_llm_status():
    """Current Gemini availability, for the API/status surface."""
    return dict(_llm_status)

# rate limiting
_last_call = {}
_cache = {}
COOLDOWN = 10
# The structured JSON reply plus its ```json fence does not fit in 300 tokens on
# current Gemini models: the response is truncated mid-object, json.loads fails
# and every station silently degrades to the deterministic fallback.
MAX_TOKENS = int(os.getenv("GEMINI_MAX_TOKENS", "1024"))
TEMP = 0.1

_FALLBACK = {
    "risk_trajectory": "unknown",
    "regulatory_escalation_likelihood": "unknown",
    "public_health_risk": "unknown",
    "anomaly_flag": False,
    "summary": "LLM analysis temporarily unavailable.",
}


def _deterministic_fallback(
    aqi=0, trend_direction="stable", band="",
    grap_stage="", vulnerability_max="low", anomaly=False,
    projected_5min=0, transport_score=0,
):
    """
    Deterministic intelligence when Gemini is rate-limited (429)
    or unavailable. Uses actual data instead of showing 'unknown'.
    """
    # risk trajectory from trend
    trajectory = trend_direction if trend_direction in ("rising", "falling", "stable") else "stable"

    # escalation likelihood from AQI + trend
    if aqi >= 300 and trajectory == "rising":
        esc_likelihood = "high"
    elif aqi >= 200 or (aqi >= 150 and trajectory == "rising"):
        esc_likelihood = "moderate"
    else:
        esc_likelihood = "low"

    # public health risk from vulnerability
    health_risk = vulnerability_max if vulnerability_max in ("low", "moderate", "high", "severe") else "low"

    # summary from data
    trend_word = {"rising": "increasing", "falling": "decreasing", "stable": "stable"}.get(trajectory, "stable")
    summary = (
        f"AQI {aqi} ({band}). Trend {trend_word}. "
        f"GRAP: {grap_stage}. "
        f"Projected 5-min: {projected_5min}. "
        f"Transport score: {transport_score}/100."
    )

    return {
        "risk_trajectory": trajectory,
        "regulatory_escalation_likelihood": esc_likelihood,
        "public_health_risk": health_risk,
        "anomaly_flag": anomaly,
        "summary": summary,
    }


def generate_llm_analysis(
    station, aqi, trend_direction, projected_5min,
    transport_score, policy_context,
    band="", grap_stage="", anomaly=False,
    projected_30min=None, vulnerability_max="low",
):
    if not _model:
        fb = _deterministic_fallback(
            aqi=aqi, trend_direction=trend_direction, band=band,
            grap_stage=grap_stage, vulnerability_max=vulnerability_max,
            anomaly=anomaly, projected_5min=projected_5min,
            transport_score=transport_score,
        )
        return {**fb, "model": "deterministic", "cached": False, "timestamp": None,
                "error": _llm_status.get("last_error")}

    now = time.time()
    if station in _last_call and now - _last_call[station] < COOLDOWN:
        cached = _cache.get(station)
        if cached:
            cached["cached"] = True
            return cached

    proj30_text = f"Projected 30-min AQI: {projected_30min}" if projected_30min else ""
    anomaly_text = "ANOMALY DETECTED: Current AQI deviates >2σ from recent trend." if anomaly else ""

    prompt = f"""You are a deterministic regulatory AI analyst.
Return ONLY valid JSON. Do not paraphrase numeric values. Use exact numbers provided.
Do not round or approximate. Do not infer beyond provided context.
Do not modify AQI values. Do not add numbers not present in the input.
Do not hallucinate predictions. Do not fabricate policy references.
The public_health_risk level MUST equal the highest vulnerable population category: {vulnerability_max}.

Station: {station}
Current AQI: {aqi} (exact)
CPCB Band: {band}
GRAP Stage: {grap_stage}
Trend: {trend_direction}
Projected 5-min AQI: {projected_5min} (exact)
{proj30_text}
Transport Score: {transport_score}/100
Highest Vulnerability Level: {vulnerability_max}
{anomaly_text}

Policy Context (verbatim):
{policy_context[:400]}

Return this exact JSON schema:
{{
  "risk_trajectory": "rising|stable|falling",
  "regulatory_escalation_likelihood": "low|moderate|high",
  "public_health_risk": "{vulnerability_max}",
  "anomaly_flag": {str(anomaly).lower()},
  "summary": "2-3 sentence explanation using exact numbers from input only"
}}"""

    try:
        response = _model.generate_content(
            prompt,
            generation_config=genai.types.GenerationConfig(
                temperature=TEMP,
                max_output_tokens=MAX_TOKENS,
            ),
        )
        raw = response.text.strip()

        # extract json from possible markdown blocks
        text = raw
        if "```json" in text:
            text = text.split("```json")[1].split("```")[0].strip()
        elif "```" in text:
            text = text.split("```")[1].split("```")[0].strip()

        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            # Almost always truncation: the reply hit max_output_tokens mid-object.
            finish = None
            try:
                finish = str(response.candidates[0].finish_reason)
            except Exception:  # noqa: BLE001
                pass
            _llm_status["last_error"] = (
                f"non-JSON output (finish_reason={finish}, "
                f"max_output_tokens={MAX_TOKENS}); raised on: {text[-60:]!r}"
            )
            raise

        for key in ["risk_trajectory", "regulatory_escalation_likelihood", "public_health_risk", "summary"]:
            if key not in parsed:
                parsed[key] = _FALLBACK[key]

        parsed["anomaly_flag"] = anomaly
        parsed["model"] = GEMINI_MODEL
        parsed["cached"] = False
        parsed["timestamp"] = now
        parsed["raw_response"] = raw[:500]
        parsed["error"] = None

        _llm_status["ready"] = True
        _llm_status["last_error"] = None

        _last_call[station] = now
        _cache[station] = parsed
        return parsed

    except json.JSONDecodeError:
        if not _llm_status.get("last_error"):
            _llm_status["last_error"] = "model returned non-JSON output"
        print(f"[LLM] {_llm_status['last_error']}")
        fb = _deterministic_fallback(
            aqi=aqi, trend_direction=trend_direction, band=band,
            grap_stage=grap_stage, vulnerability_max=vulnerability_max,
            anomaly=anomaly, projected_5min=projected_5min,
            transport_score=transport_score,
        )
        result = {**fb, "model": "deterministic-fallback", "cached": False,
                  "timestamp": now, "error": _llm_status["last_error"]}
        _last_call[station] = now
        _cache[station] = result
        return result

    except Exception as e:
        # Surface the reason: a retired model id, an invalid key or a quota stop
        # all land here and would otherwise be invisible behind the fallback.
        msg = f"{type(e).__name__}: {str(e)[:200]}"
        if _llm_status.get("last_error") != msg:
            print(f"[LLM] call failed ({GEMINI_MODEL}): {msg}")
        _llm_status["last_error"] = msg

        cached = _cache.get(station)
        if cached:
            cached["cached"] = True
            return cached
        fb = _deterministic_fallback(
            aqi=aqi, trend_direction=trend_direction, band=band,
            grap_stage=grap_stage, vulnerability_max=vulnerability_max,
            anomaly=anomaly, projected_5min=projected_5min,
            transport_score=transport_score,
        )
        return {**fb, "model": "deterministic-fallback", "cached": False,
                "timestamp": None, "error": msg}
