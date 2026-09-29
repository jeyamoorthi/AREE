# Municipal governance report generator (AREE v2.2)
# 4-page PDF via reportlab. Deterministic values only.

import io
from datetime import datetime, timedelta, timezone

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak, KeepTogether,
)

from config import (
    PERSISTENCE_THRESHOLD, HIGH_AQI_THRESHOLD,
    WINDOW_DURATION_MINUTES, WINDOW_HOP_MINUTES,
    HYSTERESIS_CONFIRMATIONS, VULNERABILITY_MULTIPLIERS,
    DEFAULT_IMPACT_RADIUS_KM, DEFAULT_EST_POPULATION,
    AQI_POLL_INTERVAL, STALE_DATA_THRESHOLD_SECONDS,
)
from streaming.predictive_engine import grap_stage_for

try:
    from api.serialization import engine_mode
except ImportError:                                         # pragma: no cover
    from backend.api.serialization import engine_mode

# colors
NAVY       = HexColor("#0f172a")
SLATE_DARK = HexColor("#1e293b")
SLATE      = HexColor("#334155")
SLATE_MED  = HexColor("#475569")
SLATE_LT   = HexColor("#94a3b8")
WHITE      = HexColor("#ffffff")
OFFWHITE   = HexColor("#f8fafc")
ACCENT     = HexColor("#2563eb")
RED        = HexColor("#dc2626")
AMBER      = HexColor("#d97706")
GREEN      = HexColor("#16a34a")
BORDER     = HexColor("#cbd5e1")

PAGE_W, PAGE_H = A4
MARGIN = 18 * mm


def _running_engine() -> str:
    """Which engine produced the state in this report: 'streaming' or 'direct'.

    Detected from what is actually imported rather than assumed, because the footer
    used to assert four subsystems unconditionally - "Pathway Streaming | WAQI Direct |
    Satellite Verified | Live Policy Index" - on every page of a document meant for a
    regulator, in a mode where none of the four was running.
    """
    import sys
    if "app" in sys.modules:
        return "streaming"
    if "fallback_engine" in sys.modules:
        return "direct"
    return "unknown"


REPORT_NAME = "Regulatory Escalation Brief"

# One wording for every absent value. `.get(k, default)` does not substitute
# when the key exists with a None value, which is how "None" and "(None)" used
# to reach a regulator's page; every display path now goes through _show().
MISSING = "Not available"
NO_RANK = "—"   # em dash

IST = timezone(timedelta(hours=5, minutes=30))

NO_PROJECTION = "Not available - the trend projection needs at least 3 readings."


def _show(value, suffix: str = "", missing: str = MISSING) -> str:
    if value is None or (isinstance(value, str) and not value.strip()):
        return missing
    return f"{value}{suffix}"


def _stage(value) -> str:
    """GRAP stage for display. The engine's "None" stage is a real state
    (AQI <= 200, no action) and must not read like a missing value."""
    if value is None or value == "":
        return MISSING
    return "No GRAP stage (AQI 200 or below)" if value == "None" else str(value)


def _fmt_time(value) -> str:
    """ISO / engine timestamp -> "29 Sep 2026, 11:00 IST (05:30 UTC)".

    A timestamp with no zone is printed as received: guessing a zone would
    shift an observation time on a regulatory document by hours.
    """
    if value is None or value == "":
        return MISSING
    dt = value if isinstance(value, datetime) else None
    if dt is None:
        raw = str(value).strip()
        for parse in (lambda v: datetime.strptime(v, "%Y-%m-%d %H:%M:%S UTC")
                      .replace(tzinfo=timezone.utc),
                      lambda v: datetime.fromisoformat(v.replace("Z", "+00:00"))):
            try:
                dt = parse(raw)
                break
            except ValueError:
                continue
        if dt is None:
            return raw
    if dt.tzinfo is None:
        return str(value)
    ist, utc = dt.astimezone(IST), dt.astimezone(timezone.utc)
    utc_fmt = "%H:%M UTC" if ist.date() == utc.date() else "%d %b %H:%M UTC"
    return f"{ist:%d %b %Y, %H:%M} IST ({utc:{utc_fmt}})"


def _freshness(stale_sec) -> str:
    if stale_sec is None:
        return "Unknown"
    if stale_sec < 60:
        return "<1 min old"
    mins = int(stale_sec // 60)
    if mins < 120:
        return f"{mins} min old"
    return f"{mins // 60} h {mins % 60} min old"


def _is_stale(s: dict) -> bool:
    if s.get("freshness_status") == "stale":
        return True
    age = s.get("stale_seconds")
    return age is not None and age > STALE_DATA_THRESHOLD_SECONDS


# Pollutant display name -> raw_* key, and the spellings feeds use for each.
_POLLUTANTS = [
    ("PM2.5", "raw_pm25"), ("PM10", "raw_pm10"), ("NO2", "raw_no2"),
    ("SO2", "raw_so2"), ("O3", "raw_o3"), ("CO", "raw_co"),
]


def _pollutant_norm(name: str) -> str:
    return "".join(ch for ch in str(name).lower() if ch.isalnum())


def _make_footer(engine: str, source: str):
    label = {
        "streaming": "Pathway streaming engine",
        "direct": "Direct engine (no event-time windowing, no policy retrieval)",
    }.get(engine, "Engine mode unknown")
    line1 = f"AREE v2.2  |  {REPORT_NAME}  |  {label}  |  Advisory only"
    line2 = (f"Observations: {source}  |  Deterministic escalation engine - "
             f"no generative content")

    def _footer(canvas, doc):
        # Two lines, page number on the first at the right. On one line the
        # left and right strings overran each other ("Advisory onPage 1").
        canvas.saveState()
        canvas.setFont("Helvetica", 6)
        canvas.setFillColor(SLATE_LT)
        canvas.drawString(MARGIN, 10 * mm, line1)
        canvas.drawString(MARGIN, 7 * mm, line2)
        canvas.drawRightString(PAGE_W - MARGIN, 10 * mm, f"Page {doc.page}")
        canvas.restoreState()

    return _footer


def _styles():
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("rpt_title", fontSize=15, leading=19,
            textColor=NAVY, fontName="Helvetica-Bold", alignment=TA_CENTER, spaceAfter=2),
        "subtitle": ParagraphStyle("rpt_sub", fontSize=9, leading=12,
            textColor=SLATE_MED, fontName="Helvetica", alignment=TA_CENTER, spaceAfter=3),
        "timestamp": ParagraphStyle("rpt_ts", fontSize=7, leading=10,
            textColor=SLATE_LT, fontName="Helvetica", alignment=TA_CENTER, spaceAfter=6),
        "section": ParagraphStyle("rpt_sec", fontSize=11, leading=14,
            textColor=NAVY, fontName="Helvetica-Bold", spaceBefore=10, spaceAfter=4),
        "subsection": ParagraphStyle("rpt_ssec", fontSize=9, leading=12,
            textColor=SLATE_DARK, fontName="Helvetica-Bold", spaceBefore=6, spaceAfter=2),
        "body": ParagraphStyle("rpt_body", fontSize=8, leading=11,
            textColor=SLATE_DARK, fontName="Helvetica"),
        "mono": ParagraphStyle("rpt_mono", fontSize=7.5, leading=10,
            textColor=NAVY, fontName="Courier"),
        "note": ParagraphStyle("rpt_note", fontSize=7, leading=9,
            textColor=SLATE_MED, fontName="Helvetica-Oblique", spaceAfter=4),
        "label": base["Normal"],
    }


def _sec_header(text, sty):
    return [
        Spacer(1, 2 * mm),
        HRFlowable(width="100%", thickness=0.5, color=BORDER, spaceAfter=3),
        Paragraph(text, sty["section"]),
    ]


def _kv_table(pairs, col1=50*mm, col2=110*mm):
    sty = _styles()
    rows = []
    for k, v in pairs:
        rows.append([
            Paragraph(f'<b>{k}</b>', ParagraphStyle("kl", fontSize=8, textColor=SLATE_MED, fontName="Helvetica-Bold")),
            Paragraph(str(v), ParagraphStyle("kv", fontSize=8, textColor=NAVY, fontName="Helvetica")),
        ])
    t = Table(rows, colWidths=[col1, col2])
    t.setStyle(TableStyle([
        ('VALIGN', (0,0), (-1,-1), 'TOP'),
        ('TOPPADDING', (0,0), (-1,-1), 2.5),
        ('BOTTOMPADDING', (0,0), (-1,-1), 2.5),
        ('LINEBELOW', (0,0), (-1,-1), 0.25, BORDER),
    ]))
    return t


def _data_table(header, rows, col_widths=None):
    data = [header] + rows
    if not col_widths:
        n = len(header)
        col_widths = [(PAGE_W - 2*MARGIN) / n] * n
    t = Table(data, colWidths=col_widths)
    t.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), SLATE_DARK),
        ('TEXTCOLOR', (0,0), (-1,0), WHITE),
        ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
        ('FONTSIZE', (0,0), (-1,-1), 7.5),
        ('TOPPADDING', (0,0), (-1,-1), 3),
        ('BOTTOMPADDING', (0,0), (-1,-1), 3),
        ('GRID', (0,0), (-1,-1), 0.25, BORDER),
        ('ALIGN', (1,0), (-1,-1), 'CENTER'),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ]))
    return t


def _box_block(elements_list):
    inner = Table([[e] for e in elements_list], colWidths=[PAGE_W - 2*MARGIN - 8*mm])
    inner.setStyle(TableStyle([
        ('BOX', (0,0), (-1,-1), 1, SLATE),
        ('TOPPADDING', (0,0), (-1,-1), 4),
        ('BOTTOMPADDING', (0,0), (-1,-1), 4),
        ('LEFTPADDING', (0,0), (-1,-1), 8),
        ('RIGHTPADDING', (0,0), (-1,-1), 8),
    ]))
    return inner



def _engine_latest_state() -> dict:
    """
    The live station roster, from whichever engine is loaded.

    Tries the Pathway engine first because that is the full path; falls back to
    the direct engine, which publishes the identical dict. Returns {} rather
    than raising if neither is importable - a regional-comparison section is
    worth degrading, not worth failing a whole report for.
    """
    for module in ("app", "fallback_engine"):
        try:
            return __import__(module).latest_state
        except Exception:                                   # noqa: BLE001
            continue
    return {}


def generate_escalation_report(station_key, state_snapshot, carbon_state=None,
                               policy_state=None):
    """
    `policy_state` is engine.rag_state() - the source /api/policy reads - so the
    document count here matches the Policy console. Without it the per-station
    rag_* fields are used.
    """
    s = state_snapshot
    policy_state = policy_state or {}
    sty = _styles()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN,
        topMargin=14*mm, bottomMargin=16*mm,
    )

    els = []
    now_utc = datetime.now(timezone.utc)
    generated = _fmt_time(now_utc)
    engine = s.get("mode") if s.get("mode") in ("direct", "streaming") else _running_engine()
    direct = engine == "direct"
    aqi = s.get("aqi")
    band = s.get("cpcb_band")
    consec = s.get("consecutive_windows") or 0
    remaining = s.get("remaining_windows")
    fc = s.get("forecast") or {}
    proj5 = fc.get("projected_5min")
    proj30 = fc.get("projected_30min")

    # The rule the API and UI use (AQI at/above threshold AND persistence), so
    # the brief cannot head a page TRIGGERED that the dashboard calls NORMAL.
    eng_mode = engine_mode(aqi, consec, HIGH_AQI_THRESHOLD, PERSISTENCE_THRESHOLD)

    def _predicted_stage(key: str, projected) -> str:
        if fc.get(key):
            return _stage(fc.get(key))
        if projected is None:
            return MISSING
        # Derived with the engine's own GRAP table rather than left blank beside
        # a projected AQI that plainly falls in a stage.
        return f"{_stage(grap_stage_for(projected)[0])} (from projected AQI)"

    freshness = _freshness(s.get("stale_seconds"))
    stale_note = (f'  <font color="#dc2626"><b>STALE DATA</b> - older than '
                  f'{STALE_DATA_THRESHOLD_SECONDS // 60} min, not current</font>'
                  if _is_stale(s) else "")
    obs_time = _fmt_time(s.get("waqi_timestamp"))
    source = s.get("observation_source") or "CAQM / CPCB"

    # PAGE 1 - Executive Summary
    els.append(Paragraph("AUTONOMOUS REGULATORY ESCALATION ENGINE", sty["title"]))
    els.append(Paragraph(REPORT_NAME, sty["subtitle"]))
    els.append(Paragraph("Internal Governance Use", sty["subtitle"]))
    els.append(Paragraph(f"Generated: {generated}", sty["timestamp"]))
    els.append(HRFlowable(width="100%", thickness=1.5, color=ACCENT, spaceAfter=8))

    # A. Decision Snapshot
    els.extend(_sec_header("A. Decision Snapshot", sty))
    snapshot_box = _box_block([
        Paragraph(f'<font size="9" color="#475569"><b>Station:</b></font>  '
                  f'<font size="10" color="#0f172a"><b>{station_key}</b></font>', sty["body"]),
        Spacer(1, 2*mm),
        # Was "WAQI AQI". The number is CAQM's published sub-index for this station;
        # naming the wrong publisher in a regulatory brief is not a cosmetic error.
        Paragraph(f'<font size="9" color="#475569"><b>AQI (CAQM):</b></font>  '
                  f'<font size="18" color="#0f172a"><b>{_show(aqi)}</b></font>  '
                  f'<font size="9" color="#475569">{f"({band})" if band else ""}</font>', sty["body"]),
        Spacer(1, 1*mm),
        Paragraph(f'<font size="9" color="#475569"><b>GRAP Stage:</b></font>  '
                  f'<font size="10" color="#0f172a"><b>{_stage(s.get("grap_stage"))}</b></font>', sty["body"]),
        Spacer(1, 1*mm),
        Paragraph(f'<font size="9" color="#475569"><b>Data Freshness:</b></font>  '
                  f'<font size="9" color="#0f172a">{freshness}</font>{stale_note}', sty["body"]),
        Paragraph(f'<font size="9" color="#475569"><b>Observed:</b></font>  '
                  f'<font size="9" color="#0f172a">{obs_time}</font>', sty["body"]),
    ])
    els.append(snapshot_box)

    # B. Action Classification
    els.extend(_sec_header("B. Immediate Action Classification", sty))
    mode_label = {"NORMAL": "NORMAL OPERATIONS", "WATCH": "ESCALATION WATCH",
                  "TRIGGERED": "ESCALATION TRIGGERED"}[eng_mode]
    mode_hex = {"NORMAL": "#16a34a", "WATCH": "#d97706", "TRIGGERED": "#dc2626"}[eng_mode]

    # One sentence per engine_mode outcome, so the reason never contradicts
    # the heading above it.
    windows = f"{consec}/{PERSISTENCE_THRESHOLD} qualifying windows"
    if aqi is None:
        reason = "No AQI reading is available for this station."
    elif eng_mode == "TRIGGERED":
        reason = (f"AQI {aqi} at or above threshold ({HIGH_AQI_THRESHOLD}); "
                  f"{windows} sustained - persistence rule met.")
    elif eng_mode == "WATCH":
        reason = (f"AQI {aqi} at or above threshold ({HIGH_AQI_THRESHOLD}); "
                  f"{windows} so far, {PERSISTENCE_THRESHOLD} needed to trigger.")
    elif aqi >= HIGH_AQI_THRESHOLD:
        reason = (f"AQI {aqi} at or above threshold ({HIGH_AQI_THRESHOLD}), but no "
                  f"qualifying window has completed yet.")
    else:
        reason = f"AQI {aqi} below threshold ({HIGH_AQI_THRESHOLD}). No escalation."

    els.append(Paragraph(f'<font size="12" color="{mode_hex}"><b>{mode_label}</b></font>', sty["body"]))
    els.append(Spacer(1, 1*mm))
    els.append(Paragraph(f'<font size="8" color="#475569"><b>Reason:</b> {reason}</font>', sty["body"]))

    # C. Short-Term Outlook
    els.extend(_sec_header("C. Short-Term Risk Outlook (30 Minutes)", sty))
    if fc:
        eta = fc.get("escalation_eta")
        els.append(_kv_table([
            ("30-min Projected AQI", _show(proj30)),
            ("Predicted GRAP Stage", _predicted_stage("predicted_grap_30min", proj30)),
            ("Trend Direction", fc["direction"].upper() if fc.get("direction") else MISSING),
            ("Rate of Change", _show(fc.get("rate_per_min"), " AQI/min")),
            ("Escalation ETA", f"{eta} min" if eta else "No imminent escalation"),
            ("Exposure Score (30min)", _show(fc.get("exposure_score_30min"))),
            ("Anomaly Flag", "YES" if fc.get("anomaly") else "NO"),
        ]))
        els.append(Paragraph(
            f'Projection Method: Linear regression over the last '
            f'{_show(fc.get("data_points"), missing="available")} readings '
            f'(slope: {_show(fc.get("slope"))}).', sty["note"]))
    else:
        els.append(Paragraph(NO_PROJECTION, sty["body"]))

    # D. Vulnerable Population Risk
    els.extend(_sec_header("D. Vulnerable Population Risk Matrix", sty))
    vr = s.get("vulnerable_risk") or {}
    if vr:
        group_names = {"general": "General Public", "elderly": "Elderly (60+)",
                       "children": "Children (<14)", "respiratory": "Respiratory/Asthma"}
        vuln_rows = []
        for group, label in group_names.items():
            v = vr.get(group) or {}
            vuln_rows.append([label, f'x{_show(v.get("multiplier"), missing="1.0")}',
                              _show(v.get("score")), _show(v.get("level")).upper()])

        els.append(_data_table(
            ["Population Group", "Multiplier", "Projected Score", "Risk Category"],
            vuln_rows, col_widths=[50*mm, 25*mm, 35*mm, 30*mm],
        ))
        els.append(Spacer(1, 2*mm))
        # The cut points app.py applies (score >= 100 / 200 / 300), written so
        # that no score sits in two bands.
        els.append(Paragraph(
            "Vulnerable population exposure (VPPE) risk category:  0-99 LOW  |  "
            "100-199 MODERATE  |  200-299 HIGH  |  300+ SEVERE",
            sty["note"]))
        # The population figure was a configured constant (500,000) shipped with the
        # word "(placeholder)" beside it, inside a municipal brief. A regulator reading
        # an exposure count wants a census, and we have none - so the claim is dropped
        # rather than dressed up. The radius stays because it IS a stated assumption.
        els.append(Paragraph(
            f'Assumed impact radius: {DEFAULT_IMPACT_RADIUS_KM} km. '
            f'Exposed-population estimates are not produced - AREE holds no census '
            f'layer, and the multipliers above are relative risk weightings, not '
            f'people.',
            sty["note"]))
    else:
        els.append(Paragraph(
            "Vulnerable population exposure (VPPE) was not computed for this "
            "station." if fc else
            "Vulnerable population exposure (VPPE) is not available - it is "
            "scored from the 30-minute projection. " + NO_PROJECTION, sty["body"]))

    # E. Satellite Attribution
    els.extend(_sec_header("E. Satellite Transport Attribution", sty))
    # THREE STATES, NOT TWO.
    #
    # This section used to branch on `fire_count > 0` alone, so a station with no
    # fire count printed: "No upwind thermal anomalies detected. Local emission
    # dominant." Both halves were fabrications whenever FIRMS had not been polled
    # - and in direct mode it never is. The first asserts a satellite check that
    # did not happen; the second is a causal attribution that nothing computed.
    #
    # On a signed escalation report that is the most damaging place in the system
    # for an invented finding, because the document outlives the screen and is
    # the artefact an officer forwards.
    #
    # "Not polled" and "polled, nothing found" are different facts and now print
    # differently. `or 0` rather than a dict default because these keys EXIST with
    # a None value - .get(k, 0) would still return None and then compare or format.
    fire_count = s.get("fire_count")
    firms_status = s.get("firms_status") or "unknown"
    polled = firms_status == "ok" and fire_count is not None

    def _or_na(key: str, suffix: str = "") -> str:
        value = s.get(key)
        return f"{value}{suffix}" if value is not None else "not computed"

    if not polled:
        els.append(Paragraph(
            f"Satellite fire attribution was not computed for this report "
            f"(FIRMS status: {firms_status}). No thermal-anomaly search was "
            f"performed, so this section makes no finding either way - it is "
            f"neither evidence of transport nor evidence of its absence.",
            sty["body"]))
        els.append(_kv_table([
            ("FIRMS status", firms_status),
            ("Fire hotspots", "not computed"),
            ("Transport score", _or_na("transport_score", "/100")),
            ("Attribution label", _or_na("transport_label")),
        ]))
    elif fire_count > 0:
        els.append(_kv_table([
            ("Fire Hotspots", str(fire_count)),
            ("High Confidence Fires", _or_na("high_conf_fires")),
            ("Transport Score", _or_na("transport_score", "/100")),
            # `is not None`, not truthiness: calm air (0 m/s) and due north
            # (0 degrees) are readings, not gaps.
            ("Wind Speed", f'{float(s["wind_speed"]):.1f} m/s'
                           if s.get("wind_speed") is not None else MISSING),
            ("Wind Direction", f'{s["wind_direction"]}\u00b0'
                               if s.get("wind_direction") is not None else MISSING),
            ("Attribution Label", _or_na("transport_label")),
            ("Confidence", _or_na("confidence_score", "%")),
        ]))
    else:
        # Genuinely searched and found nothing. The absence of upwind fires is a
        # real result and is reported as one - but "local emission dominant" is a
        # causal conclusion this pipeline does not draw, so it is not asserted.
        els.append(Paragraph(
            "FIRMS was polled and returned no upwind thermal anomalies in the "
            "search window. This rules out detected fire transport as a "
            "contributor; it does not by itself attribute the episode to local "
            "emission.", sty["body"]))
        els.append(_kv_table([
            ("FIRMS status", firms_status),
            ("Fire hotspots", "0 (searched)"),
            ("Transport Score", _or_na("transport_score", "/100")),
            ("FIRMS Dataset", _show(s.get("firms_dataset"))),
        ]))

    # Pre-emptive advisory
    pa = s.get("preemptive_advisory") or []
    if pa:
        els.append(Spacer(1, 3*mm))
        els.append(Paragraph('<font color="#dc2626"><b>PRE-EMPTIVE PUBLIC HEALTH ADVISORY</b></font>', sty["body"]))
        for item in pa:
            els.append(Paragraph(f'<font color="#0f172a">  - {item}</font>', sty["body"]))

    # PAGE 2 - Technical Detail
    els.append(PageBreak())
    els.append(Paragraph("TECHNICAL ESCALATION DETAIL", sty["title"]))
    els.append(HRFlowable(width="100%", thickness=1.5, color=ACCENT, spaceAfter=8))

    # A. Pollutant Snapshot
    els.extend(_sec_header("A. Real-Time Pollutant Snapshot", sty))
    poll_rows = []
    reported = 0
    for name, key in _POLLUTANTS:
        val = s.get(key)
        reported += val is not None
        poll_rows.append([name, str(val) if val is not None else NO_RANK,
                          "Received" if val is not None else MISSING])
    els.append(_data_table(["Pollutant", "Value", "Status"], poll_rows,
                           col_widths=[40*mm, 40*mm, 50*mm]))
    els.append(Spacer(1, 2*mm))
    # Dominant only when that pollutant actually has a value here: the direct
    # engine defaults the field to "pm25", which printed beside "0 of 6".
    dom_raw = s.get("dominant_pollutant")
    dom = next(((n, k) for n, k in _POLLUTANTS
                if dom_raw and _pollutant_norm(n) == _pollutant_norm(dom_raw)), None)
    dom_txt = (dom[0] if dom and s.get(dom[1]) is not None
               else "Not determined (no concentration reported)")
    els.append(Paragraph(
        f'Dominant Pollutant: {dom_txt}  |  '
        f'Pollutants reported: {reported} of {len(_POLLUTANTS)}  |  '
        f'Source: {_show(s.get("pollutant_source"), missing="not reported")}'
        + ({"sub_index": '  |  Values are CPCB sub-indices, not concentrations',
            "us_sub_index": '  |  Values are US EPA-scale sub-indices (WAQI), '
                            'not CPCB values and not concentrations',
            }.get(s.get("pollutant_quantity"), ''))
        + (f'  |  Age: {s.get("pollutant_age_minutes")} min'
           if s.get("pollutant_age_minutes") is not None else ''), sty["note"]))

    # B. Engine Logic
    els.extend(_sec_header("B. Escalation Engine Logic", sty))
    trigger_rule = (
        f"Trigger Rule:\n"
        f"  AQI >= {HIGH_AQI_THRESHOLD}\n"
        f"  {PERSISTENCE_THRESHOLD} Consecutive Windows\n"
        f"  {WINDOW_DURATION_MINUTES}min Sliding  |  {WINDOW_HOP_MINUTES}min Hop\n"
        f"  Hysteresis: {HYSTERESIS_CONFIRMATIONS} confirmations"
    )
    els.append(_box_block([Paragraph(trigger_rule.replace('\n', '<br/>'), sty["mono"])]))

    # C. Persistence
    els.extend(_sec_header("C. Persistence State", sty))
    els.append(_kv_table([
        ("Current GRAP Stage", _stage(s.get("grap_stage"))),
        ("GRAP Description", _show(s.get("grap_description"))),
        ("Consecutive High Windows", f"{consec}/{PERSISTENCE_THRESHOLD}"),
        ("Remaining to Trigger", _show(remaining)),
        ("Projected Trigger Time", _show(s.get("projected_trigger_time"))),
        ("Engine Mode", eng_mode),
    ]))

    # D. Decision Trace
    els.extend(_sec_header("D. Decision Trace", sty))
    trace = (
        f"Input AQI: {_show(aqi)}\n"
        f"Threshold: {HIGH_AQI_THRESHOLD}\n"
        f"Persistence: {consec}/{PERSISTENCE_THRESHOLD}\n"
        f"Hysteresis: {HYSTERESIS_CONFIRMATIONS} confirmations required\n"
        f"Engine Mode: {eng_mode}\n"
        f"Stage: {_stage(s.get('grap_stage'))}"
    )
    els.append(_box_block([Paragraph(trace.replace('\n', '<br/>'), sty["mono"])]))

    # E. Predictive Detail
    els.extend(_sec_header("E. Predictive Intelligence Detail", sty))
    if fc:
        els.append(_kv_table([
            ("5-min Projected AQI", _show(proj5)),
            ("30-min Projected AQI", _show(proj30)),
            ("Trend Slope", _show(fc.get("slope"))),
            ("Trend Direction", fc["direction"].upper() if fc.get("direction") else MISSING),
            ("Rate of Change", _show(fc.get("rate_per_min"), " AQI/min")),
            ("Predicted GRAP (5min)", _predicted_stage("predicted_grap", proj5)),
            ("Predicted GRAP (30min)", _predicted_stage("predicted_grap_30min", proj30)),
            ("Exposure Score (30min)", _show(fc.get("exposure_score_30min"))),
            ("Anomaly Detected", "YES" if fc.get("anomaly") else "NO"),
            ("Data Points Used", _show(fc.get("data_points"))),
            ("Poll Interval", f"{AQI_POLL_INTERVAL}s"),
        ]))
    else:
        els.append(Paragraph(NO_PROJECTION, sty["body"]))

    # F. ERI Summary
    els.extend(_sec_header("F. Escalation Readiness Summary", sty))
    # A null ERI is "not computed", never 0/100 - zero is a real, and very
    # different, readiness reading.
    eri = s.get("eri_score")
    eri_factors = s.get("eri_factors") or []
    els.append(_kv_table([
        ("ERI Score", f"{eri}/100" if eri is not None else "Not computed"),
        ("Readiness Category", _show(s.get("eri_category"), missing="Not computed")
                               if eri is not None else "Not computed"),
    ]))
    if eri_factors:
        els.append(Spacer(1, 2*mm))
        els.append(Paragraph('<b>Contributing Factors:</b>', sty["body"]))
        for f in eri_factors:
            els.append(Paragraph(f'  - {f}', sty["body"]))
    els.append(Spacer(1, 2*mm))
    els.append(Paragraph(
        'ERI is advisory only. Does not affect GRAP trigger logic.',
        sty["note"]))

    # G. Regional Snapshot
    els.extend(_sec_header("G. Regional Comparative Snapshot", sty))
    # Read the roster from whichever engine is actually running.
    #
    # This used to be `from app import latest_state`, which hard-wired the
    # report to the Pathway module. Pathway ships Linux/macOS wheels only, so
    # on Windows - and in every direct-mode deployment - PDF generation died
    # with ModuleNotFoundError while the report METADATA endpoint kept
    # answering 200. The failure therefore looked like a broken PDF writer
    # rather than a missing engine.
    #
    # Both engines publish the same `latest_state` dict by design (see
    # tests_contract.py), so either satisfies this section.
    _all_st = _engine_latest_state()
    _act = {k: v for k, v in _all_st.items()
            if isinstance(v, dict) and v.get("aqi") is not None and v.get("status") != "DATA_INVALID"}
    n_stations = len(_act)
    if n_stations >= 1:
        aqi_rank = sorted(_act.items(), key=lambda x: x[1]["aqi"], reverse=True)
        # Only stations with a computed ERI are ranked on it; a null ERI used
        # to rank as 0 and printed e.g. "#53 of 73" for a score that did not exist.
        eri_rank = sorted(((k, v) for k, v in _act.items() if v.get("eri_score") is not None),
                          key=lambda x: x[1]["eri_score"], reverse=True)
        aqi_pos = next((i+1 for i, (k, _) in enumerate(aqi_rank) if k == station_key), None)
        eri_pos = next((i+1 for i, (k, _) in enumerate(eri_rank) if k == station_key), None)
        els.append(_kv_table([
            ("Total Stations", str(n_stations)),
            ("AQI Rank", f"#{aqi_pos} of {n_stations}" if aqi_pos else NO_RANK),
            ("ERI Rank", f"#{eri_pos} of {len(eri_rank)}" if eri_pos else NO_RANK),
        ]))
        top3 = aqi_rank[:3]
        top_rows = [[stn, str(v["aqi"]), _show(v.get("eri_score"), missing=NO_RANK)]
                    for stn, v in top3]
        if top_rows:
            els.append(Spacer(1, 3*mm))
            els.append(Paragraph("<b>Top Stations by AQI</b>", sty["body"]))
            els.append(_data_table(["Station", "AQI", "ERI"], top_rows,
                                   col_widths=[60*mm, 35*mm, 35*mm]))
    else:
        els.append(Paragraph("No cross-station data yet.", sty["body"]))

    # PAGE 3 - Policy Grounding
    els.append(PageBreak())
    els.append(Paragraph("POLICY CONTEXT AND LEGAL BASIS", sty["title"]))
    els.append(HRFlowable(width="100%", thickness=1.5, color=ACCENT, spaceAfter=8))

    # Same count /api/policy reports (policy documents on disk, both engines).
    docs = policy_state.get("docs_indexed", s.get("rag_docs_indexed"))
    els.extend(_sec_header("A. Policy Retrieval Metadata", sty))
    if direct:
        els.append(Paragraph(
            "Policy retrieval is not available in direct mode. Policy documents "
            "are held on disk but are not embedded or searched, so no document "
            "was retrieved for this station.", sty["body"]))
        els.append(Spacer(1, 2*mm))
        els.append(_kv_table([
            ("Policy Documents on Disk", _show(docs)),
            ("Index Type", "Not indexed (direct mode)"),
            ("Retrieval", "Not performed"),
        ]))
    else:
        els.append(_kv_table([
            ("Source Document", _show(s.get("rag_policy_file"))),
            ("Similarity Score", _show(s.get("rag_similarity_score"))),
            ("Documents Indexed", _show(docs)),
            ("Index Type", _show(s.get("rag_index_type"))),
            ("Embedding Model", _show(s.get("rag_embed_model"))),
            ("Last Sync", _fmt_time(s.get("rag_last_updated"))),
        ]))

    els.extend(_sec_header("B. Governance Protocol", sty))
    els.append(Paragraph(
        f'<font size="8" color="#0f172a">{_show(s.get("governance_rule"))}</font>', sty["body"]))

    els.append(Spacer(1, 6*mm))
    if direct:
        els.append(Paragraph(
            'No policy text in this brief was retrieved by AREE. Consult the CAQM '
            'GRAP schedule directly for the legal basis of any action.', sty["note"]))
    else:
        els.append(Paragraph(
            'This advisory references policy documents retrieved via Pathway DocumentStore '
            '(live indexed). Similarity scores reflect vector retrieval proximity only and '
            'do not imply legal enforcement.', sty["note"]))

    # PAGE 4 - System Transparency
    els.append(PageBreak())
    els.append(Paragraph("SYSTEM TRANSPARENCY AND AUDITABILITY", sty["title"]))
    els.append(HRFlowable(width="100%", thickness=1.5, color=ACCENT, spaceAfter=8))

    els.extend(_sec_header("A. Data Source Provenance", sty))
    els.append(_kv_table([
        ("Observation Source", source),
        ("Station feed ID", _show(s.get("feed_id"))),
        ("Observation timestamp", obs_time),
        ("API Response Time", _fmt_time(s.get("api_time"))),
        ("Data Freshness", freshness + stale_note),
        ("Station (API Name)", _show(s.get("station_name_api"))),
        ("Ingestion Status", _show(s.get("ingestion_status"))),
    ]))

    els.extend(_sec_header("B. Model Description", sty))
    els.append(_kv_table([
        ("Predictive Model", "Linear regression (numpy.polyfit, degree 1)"),
        ("Embedding Model", "Not used (direct mode)" if direct
                            else _show(s.get("rag_embed_model"), missing="all-MiniLM-L6-v2")),
        ("RAG Pipeline", "Not available in direct mode" if direct
                         else "Pathway DocumentStore (BruteForceKnnFactory, 384-dim)"),
        ("Satellite Dataset", _show(s.get("firms_dataset"), missing="Not polled")),
        ("Anomaly Detection", "Z-score threshold (>2 sigma)"),
    ]))

    els.extend(_sec_header("C. Engine Configuration", sty))
    els.append(_kv_table([
        ("Sliding Window", f"{WINDOW_DURATION_MINUTES} min duration, {WINDOW_HOP_MINUTES} min hop"),
        ("Persistence Threshold", f"{PERSISTENCE_THRESHOLD} consecutive windows"),
        ("Hysteresis Confirmations", str(HYSTERESIS_CONFIRMATIONS)),
        ("AQI Threshold", str(HIGH_AQI_THRESHOLD)),
        ("Poll Interval", f"{AQI_POLL_INTERVAL}s"),
    ]))

    els.extend(_sec_header("D. Carbon Accounting", sty))
    if carbon_state:
        els.append(_kv_table([
            ("Total Emissions", _show(carbon_state.get("total_gco2"), " gCO2eq")),
            ("Decisions Processed", _show(carbon_state.get("decision_count"))),
            ("Per-Decision Emission", _show(carbon_state.get("per_decision_gco2"), " gCO2eq")),
        ]))
    else:
        els.append(Paragraph("Carbon data not available.", sty["body"]))

    els.extend(_sec_header("E. Report Metadata", sty))
    els.append(_kv_table([
        ("Report", REPORT_NAME),
        ("Report Generated", generated),
        ("Engine Version", "AREE v2.2"),
        ("Architecture", "Direct engine (no streaming runtime, no policy retrieval)"
                         if direct else "Pathway xLLM | Single-Process DocumentStore"),
        ("LLM Content in Report", "No generative content - deterministic only"),
    ]))

    els.append(Spacer(1, 8*mm))
    els.append(HRFlowable(width="100%", thickness=0.5, color=BORDER))
    els.append(Spacer(1, 2*mm))
    els.append(Paragraph(
        'This document contains no generative narrative. All values are deterministic '
        'outputs from live system state.',
        sty["note"]))

    footer = _make_footer(engine, source)
    doc.build(els, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()
