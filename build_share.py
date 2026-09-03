#!/usr/bin/env python
"""
Build a single self-contained AREE_Demo.html that can be emailed or messaged.

    python build_share.py                 # captures from a running API
    python build_share.py --from .tmp/snap  # reuse already-captured payloads

WHAT THIS PRODUCES AND WHY IT IS NOT A DEPLOYMENT
    One HTML file with the outlook payloads embedded in it. No server, no build
    step, no hosting: the recipient double-clicks it and the whole decision screen
    renders from data baked into the page. That is the only sharing mechanism that
    works when the people you are sending it to are in other cities, are not going
    to install anything, and may open it on a phone.

THE ONE RULE THIS FILE MUST NOT BREAK
    It is a SNAPSHOT, and it says so on every screen. The live view inside it is a
    frozen moment, not a live feed, and a page that let a reader believe otherwise
    would reproduce - in the most shareable possible form - exactly the confusion
    between live and replay that the application spent its whole development
    removing. Hence: a fixed banner naming the capture time, "captured" rather than
    "live" wording on the first preset, and no clock anywhere.

WHAT IS DELIBERATELY ABSENT
    The approve/reject control. Approval writes to an audit trail, and an audit
    trail needs a server. A button that appeared to record a regulatory decision
    into a file on someone's laptop would be theatre. The snapshot shows the case
    and its state, and says where the real one lives.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DEFAULT_API = "http://127.0.0.1:8102"

SCENES = [
    ("live", None, "Captured live"),
    ("nov02", "2024-11-02T06:00:00Z", "02 Nov 2024 · 06:00"),
    ("nov14", "2024-11-14T00:00:00Z", "14 Nov 2024 · 00:00"),
    ("nov16", "2024-11-16T00:00:00Z", "16 Nov 2024 · 00:00"),
]


def fetch(api: str, at: str | None) -> dict:
    url = f"{api}/api/aree/outlook" + (f"?at={at}" if at else "")
    with urllib.request.urlopen(url, timeout=180) as r:
        return json.loads(r.read().decode("utf-8"))


def collect(api: str, cache: Path | None) -> dict:
    scenes = {}
    for key, at, label in SCENES:
        if cache and (cache / f"{key}.json").exists():
            payload = json.loads((cache / f"{key}.json").read_text(encoding="utf-8"))
        else:
            print(f"  fetching {key} …")
            payload = fetch(api, at)
        if not payload.get("as_of"):
            print(f"  {key}: unavailable, skipped", file=sys.stderr)
            continue
        scenes[key] = {"label": label, "at": at, "payload": payload}
    return scenes


def build(scenes: dict, out: Path) -> None:
    captured = datetime.now(timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    data = json.dumps(scenes, separators=(",", ":"), default=str)
    html = TEMPLATE.replace("__DATA__", data).replace("__CAPTURED__", captured)
    out.write_text(html, encoding="utf-8")
    kb = out.stat().st_size / 1024
    print(f"\n  {out}  ({kb:.0f} KB)")
    print("  Send this one file. It opens in any browser, offline, with no server.\n")


TEMPLATE = r"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AREE — Atmospheric Outlook</title>
<style>
:root{
  --ink:#1a1a17;--body:#44403a;--muted:#7d776c;--dim:#a8a196;--line:#e8e3d7;
  --paper:#fff;--wash:#faf8f2;--bg:#f3f2ec;
  --amberBg:#fdf8ec;--amber:#f0e6c8;--amberInk:#8a6d1f;
  --greenBg:#f3f8f2;--green:#d9e7d9;--greenInk:#2f6b3f;
  --orangeBg:#fdf4ec;--orange:#f3ddc6;--orangeInk:#b3511c;
  --redBg:#fdf2f0;--red:#f0d5cd;--redInk:#b91c1c;
  --violet:#4338ca;
}
@media (prefers-color-scheme:dark){:root:not([data-t="light"]){
  --ink:#f0ece3;--body:#cdc7bb;--muted:#9a9287;--dim:#7a736a;--line:#2e2a24;
  --paper:#1b1915;--wash:#161410;--bg:#100f0c;
  --amberBg:#2a2314;--amber:#4a3d1c;--amberInk:#e0c273;
  --greenBg:#15241a;--green:#28402e;--greenInk:#8fca9f;
  --orangeBg:#2c1d12;--orange:#4d3320;--orangeInk:#f0a771;
  --redBg:#2e1614;--red:#4d2622;--redInk:#f09a92;
  --violet:#a5b4fc;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--body);
 font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:1240px;margin:0 auto;padding:0 16px 56px}
.snapbar{background:var(--violet);color:#fff;padding:7px 16px;font-size:12px;font-weight:600;
 text-align:center;letter-spacing:.01em}
.snapbar b{font-weight:700}
header{padding:20px 0 8px}
h1{font-size:21px;font-weight:800;letter-spacing:-.02em;color:var(--ink);margin:0}
.sub{font-size:12px;color:var(--muted);margin-top:4px;max-width:70ch}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 4px}
.tab{border:1px solid var(--line);background:var(--paper);color:var(--body);border-radius:7px;
 padding:7px 13px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.tab[aria-selected=true]{background:var(--ink);border-color:var(--ink);color:var(--bg)}
.sec{display:flex;flex-wrap:wrap;align-items:baseline;gap:11px;padding-top:16px;margin-bottom:7px}
.sec .n{font:700 11px ui-monospace,monospace;color:var(--dim)}
.sec h2{font-size:12.5px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--ink);margin:0}
.sec .h{font-size:11px;color:var(--muted)}
.card{background:var(--paper);border:1px solid var(--line);border-radius:9px;padding:15px}
.grid{display:grid;gap:11px}
@media(min-width:900px){.g2{grid-template-columns:1.25fr 1fr}.g5{grid-template-columns:repeat(5,1fr)}
 .g4{grid-template-columns:repeat(4,1fr)}.gA{grid-template-columns:1fr 1.6fr}}
.eyebrow{font-size:9.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:0}
.hero{border:1px solid;border-radius:9px;padding:16px}
.hero .lab{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
.chip{display:inline-block;border-radius:4px;padding:2px 7px;font-size:10px;font-weight:700;margin-left:7px}
.hl{font-size:19px;font-weight:800;line-height:1.25;color:var(--ink);margin:7px 0 0;letter-spacing:-.015em}
.dt{font-size:12.5px;margin:6px 0 0}
.cross{font-size:12px;font-weight:700;margin:6px 0 0}
.big{font-size:26px;font-weight:800;line-height:1;color:var(--ink);font-variant-numeric:tabular-nums}
.big s{font-size:11px;font-weight:600;color:var(--muted);text-decoration:none;margin-left:3px}
.cap{font-size:12px;font-weight:600;margin-top:5px}
.sml{font-size:10.5px;color:var(--dim);margin-top:4px;line-height:1.45}
table{border-collapse:collapse;width:100%;font-size:11.5px}
th{text-align:left;font-size:9.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;
 color:var(--dim);padding:0 10px 6px 0}
td{padding:6px 10px 6px 0;border-top:1px solid var(--line);vertical-align:top}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:middle}
.mech{display:flex;gap:8px;align-items:flex-start}
.mech .v{font-size:13px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums;margin:4px 0 0}
.mech .d{font-size:10.5px;font-weight:600;margin-top:2px}
ol.rank{list-style:none;margin:7px 0 0;padding:0}
ol.rank li{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:1px solid var(--line);font-size:11.5px}
ol.rank li:last-child{border-bottom:0}
ol.rank b{color:var(--ink);font-weight:600}
.meas{list-style:none;margin:11px 0 0;padding:11px 0 0;border-top:1px solid;display:grid;gap:6px}
@media(min-width:760px){.meas{grid-template-columns:1fr 1fr}}
.meas li{font-size:11.5px;padding-left:17px;position:relative}
.meas li::before{content:"○";position:absolute;left:0;font-size:11px}
.why{margin-top:11px;padding-top:11px;border-top:1px solid}
.why li{font-size:11px;line-height:1.5;margin:3px 0}
.prov{background:var(--wash);border:1px solid var(--line);border-radius:9px;padding:11px 15px;
 margin-top:11px;font-size:10.5px;color:var(--muted);display:flex;flex-wrap:wrap;gap:5px 18px}
.prov .m{font-weight:700;letter-spacing:.07em;text-transform:uppercase}
.legend{display:flex;flex-wrap:wrap;gap:5px 11px;margin-top:9px;padding-top:9px;border-top:1px solid var(--line)}
.legend span{font-size:9.5px;color:var(--muted)}
.empty{border:1px solid var(--line);background:var(--wash);border-radius:8px;padding:26px 20px;text-align:center}
.empty b{display:block;font-size:12px;color:var(--body);margin-bottom:5px}
.empty p{font-size:11px;color:var(--muted);margin:0;max-width:44ch;margin-inline:auto;line-height:1.5}
svg{display:block;max-width:100%}
.note{font-size:10.5px;color:var(--dim);margin-top:9px;line-height:1.5}
footer{margin-top:30px;padding-top:16px;border-top:1px solid var(--line);font-size:10.5px;color:var(--dim);line-height:1.6}
</style></head><body>

<div class="snapbar">
  CAPTURED SNAPSHOT — not a live system. Data frozen <b>__CAPTURED__</b>. Nothing on this page updates.
</div>

<div class="wrap">
<header>
  <h1>AREE — Atmospheric Outlook</h1>
  <p class="sub">Air pollution–weather coupled forecasting for Delhi NCR · SIH PS 26082.
  Every value below was computed by the AREE backend and captured verbatim; this file
  recomputes nothing.</p>
  <div class="tabs" id="tabs" role="tablist"></div>
</header>
<main id="view"></main>
<footer id="foot"></footer>
</div>

<script>
const SCENES = __DATA__;
const TONE = {
  critical:{bg:"--redBg",bd:"--red",ink:"--redInk",dot:"#b91c1c"},
  elevated:{bg:"--orangeBg",bd:"--orange",ink:"--orangeInk",dot:"#ea580c"},
  warning:{bg:"--amberBg",bd:"--amber",ink:"--amberInk",dot:"#ca8a04"},
  calm:{bg:"--greenBg",bd:"--green",ink:"--greenInk",dot:"#16a34a"}
};
const BANDS=[["Good",0,30,"#65ad5f"],["Satisfactory",30,60,"#9cbf54"],["Moderate",60,90,"#f4b942"],
             ["Poor",90,120,"#f28c28"],["Very Poor",120,250,"#ef5b22"],["Severe",250,null,"#d62828"]];
const BC=Object.fromEntries(BANDS.map(b=>[b[0],b[3]]));
const v=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

function ist(iso,withDate=true){
  const d=new Date(iso); if(isNaN(d)) return "—";
  const t=d.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Kolkata"});
  if(!withDate) return t+" IST";
  return d.toLocaleDateString("en-GB",{day:"2-digit",month:"short",timeZone:"Asia/Kolkata"})+", "+t+" IST";
}
const utc=s=>s.slice(0,10)+" "+s.slice(11,16)+" UTC";

/* ── chart: inline SVG, no library. Same encoding as the app: median line,
   upper-tail band, severe threshold, crossing marker, accumulation window. ── */
function chart(d){
  const S=d.forecast.series; if(!S.length) return "";
  const W=980,H=250,L=42,R=12,T=14,B=30;
  const thr=d.risk.threshold_ugm3;
  const ymax=Math.ceil(Math.max(thr,...S.map(p=>p.upper),d.observation.value)*1.15/50)*50;
  const x=i=>L+i*(W-L-R)/Math.max(S.length-1,1);
  const y=val=>T+(1-val/ymax)*(H-T-B);
  const path=k=>S.map((p,i)=>(i?"L":"M")+x(i).toFixed(1)+" "+y(p[k]).toFixed(1)).join(" ");
  const area=path("upper")+" L"+x(S.length-1).toFixed(1)+" "+y(0).toFixed(1)+" L"+x(0).toFixed(1)+" "+y(0).toFixed(1)+" Z";

  const idx=t=>S.findIndex(p=>p.valid_at===t);
  const cA=d.timeline.find(m=>m.kind==="collapse"), cB=d.timeline.find(m=>m.kind==="recovery");
  let bandRect="";
  if(cA){const a=idx(cA.at),b=cB?idx(cB.at):S.length-1;
    if(a>=0){const x1=x(a),x2=x(b>a?b:S.length-1);
      bandRect=`<rect x="${x1}" y="${T}" width="${Math.max(x2-x1,1)}" height="${H-T-B}" fill="#f3c9b0" opacity=".28"/>`;}}
  let crossLine="";
  const ci=d.risk.first_crossing?idx(d.risk.first_crossing):-1;
  if(ci>=0) crossLine=`<line x1="${x(ci)}" y1="${T}" x2="${x(ci)}" y2="${H-B}" stroke="${TONE[d.risk.status_tone].dot}" stroke-width="1.3" stroke-dasharray="3 3"/>
    <text x="${x(ci)+4}" y="${T+11}" font-size="9.5" fill="${TONE[d.risk.status_tone].dot}">crossing</text>`;

  const ticks=[0,.25,.5,.75,1].map(f=>{const val=Math.round(ymax*f);
    return `<line x1="${L}" y1="${y(val)}" x2="${W-R}" y2="${y(val)}" stroke="${v("--line")}" stroke-width="1"/>
            <text x="${L-7}" y="${y(val)+3.5}" text-anchor="end" font-size="9" fill="${v("--dim")}">${val}</text>`;}).join("");
  const step=Math.max(1,Math.floor(S.length/6));
  const xlab=S.map((p,i)=>i%step===0?`<text x="${x(i)}" y="${H-9}" text-anchor="middle" font-size="8.5" fill="${v("--dim")}">${ist(p.valid_at).replace(", "," ")}</text>`:"").join("");

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="PM2.5 forecast">
    ${ticks}${bandRect}
    <path d="${area}" fill="#fbe4d0" opacity=".85"/>
    <path d="${path("upper")}" fill="none" stroke="#ea8c4f" stroke-width="1.3"/>
    <path d="${path("central")}" fill="none" stroke="${v("--ink")}" stroke-width="1.9"/>
    <line x1="${L}" y1="${y(thr)}" x2="${W-R}" y2="${y(thr)}" stroke="${v("--redInk")}" stroke-width="1.2" stroke-dasharray="4 3"/>
    <text x="${L+5}" y="${y(thr)-5}" font-size="9.5" fill="${v("--redInk")}">Severe ${thr.toFixed(0)}</text>
    ${crossLine}${xlab}</svg>`;
}

/* ── spatial: proportional symbols on a plain pane. No basemap tiles, so the file
   works with no network at all; the panel says it is a station scatter, not a map. ── */
function spatial(d){
  const e=d.exposure;
  if(e.kind!=="network"){
    return `<div class="empty"><b>No station-level spatial field for this timestamp</b>
      <p>${esc(e.reason||"The target for this hour is an NCR composite.")}</p></div>`;
  }
  const pts=(e.points||[]).filter(p=>p.latitude!=null&&p.longitude!=null);
  if(!pts.length) return `<div class="empty"><b>No positioned stations</b></div>`;
  const W=560,H=300,P=34;
  const la=pts.map(p=>p.latitude),lo=pts.map(p=>p.longitude);
  const [a,b]=[Math.min(...la),Math.max(...la)],[c,e2]=[Math.min(...lo),Math.max(...lo)];
  const px=v2=>P+((v2-c)/Math.max(e2-c,.01))*(W-2*P);
  const py=v2=>H-P-((v2-a)/Math.max(b-a,.01))*(H-2*P);
  const r=n=>Math.max(4.5,Math.min(19,3+Math.sqrt(n)*.78));
  const sorted=[...pts].sort((m,n)=>n.pm25-m.pm25);
  const dots=sorted.map(p=>`<circle cx="${px(p.longitude).toFixed(1)}" cy="${py(p.latitude).toFixed(1)}"
      r="${r(p.pm25).toFixed(1)}" fill="${BC[p.band]||"#94a3b8"}" fill-opacity=".8" stroke="#fff" stroke-width="1.3">
      <title>${esc(p.station)} — ${p.pm25.toFixed(0)} µg/m³ (${esc(p.band)})</title></circle>`).join("");
  const seen=[],labs=[];
  for(const p of sorted){ if(labs.length>=4) break;
    if(seen.some(q=>Math.abs(q.latitude-p.latitude)<.08&&Math.abs(q.longitude-p.longitude)<.08)) continue;
    seen.push(p); labs.push(`<text x="${px(p.longitude)+r(p.pm25)+4}" y="${py(p.latitude)+3}" font-size="9.5"
      font-weight="700" fill="${v("--ink")}" paint-order="stroke" stroke="${v("--paper")}" stroke-width="2.5">${esc(p.place)}</text>`);}
  return `<svg viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" rx="7" fill="${v("--wash")}" stroke="${v("--line")}"/>${dots}${labs.join("")}</svg>`;
}

function render(key){
  const sc=SCENES[key], d=sc.payload, t=TONE[d.risk.status_tone]||TONE.calm;
  const ink=v(t.ink), bg=v(t.bg), bd=v(t.bd);
  const e=d.exposure, dec=d.decision, risk=d.risk, net=e.kind==="network";
  const vals=(e.points||[]).map(p=>p.pm25);
  const summary=net&&vals.length?`${e.points.length} reporting stations · median ${e.median_pm25?.toFixed(0)} µg/m³ · range ${Math.min(...vals).toFixed(0)}–${Math.max(...vals).toFixed(0)}`:"";

  document.getElementById("view").innerHTML = `
  <div class="sec"><span class="n">01</span><h2>What is happening?</h2>
    <span class="h">${d.mode==="replay"?"Reconstructed as of":"Captured at"} ${utc(d.as_of)}</span></div>

  <div class="hero" style="background:${bg};border-color:${bd}">
    <div class="grid g2">
      <div><span class="dot" style="background:${t.dot}"></span>
        <span class="lab" style="color:${ink}">${esc(risk.status_label)}</span>
        ${risk.status==="PREDICTIVE_WARNING"&&risk.lead_hours!=null
          ?`<span class="chip" style="background:${bd};color:${ink}">${risk.lead_hours.toFixed(0)} H LEAD</span>`:""}
        <p class="hl">${esc(d.narrative.headline)}</p>
        <p class="dt">${esc(d.narrative.detail)}</p>
        ${risk.first_crossing?`<p class="cross" style="color:${ink}">Upper-tail crosses ${risk.threshold_ugm3.toFixed(0)} µg/m³ at ${ist(risk.first_crossing)}${risk.sustained_hours?` · sustained ${risk.sustained_hours} h`:""}</p>`:""}
      </div>
      <div class="grid" style="grid-template-columns:1fr 1fr;align-self:start">
        <div><p class="eyebrow">Observed PM2.5</p>
          <p class="big">${d.observation.value.toFixed(0)}<s>µg/m³</s></p>
          <p class="cap" style="color:${ink}">${esc(d.observation.band)}</p></div>
        <div><p class="eyebrow">Target</p>
          <p style="font-size:12px;font-weight:700;color:var(--ink);margin:5px 0 0">
            ${d.observation.n_stations!=null?`${d.observation.n_stations} ${d.observation.n_stations===1?"monitor":"stations"}`:"count not recorded"}</p>
          <p class="sml">${esc(d.observation.target_label)}<br>${ist(d.observation.observed_at)}</p></div>
      </div>
    </div>
  </div>

  <div class="grid g2" style="margin-top:11px">
    <div class="card"><p class="eyebrow">Spatial outlook</p>
      <p class="sml" style="color:var(--body);font-weight:600;margin-top:3px">
        ${net?ist(e.observed_at):ist(d.as_of)}</p>
      <p class="sml" style="margin-top:1px">${net?`Network observation · ${e.n_stations} stations`:`Historical composite · ${e.n_monitors??"?"} monitor`}</p>
      <div style="margin-top:8px">${spatial(d)}</div>
      ${net?`<div class="legend">${BANDS.map(b=>`<span><span class="dot" style="background:${b[3]}"></span>${b[0]} ${b[2]===null?b[1]+"+":b[1]+"–"+b[2]}</span>`).join("")}</div>
      <p class="note">Colour = CPCB band · symbol area ∝ concentration. Size is a reading, not a modelled extent.<br><b>${summary}</b></p>`:""}
    </div>
    <div class="card"><p class="eyebrow">Top areas at risk</p>
      ${net?`<p class="sml">PM2.5 µg/m³ · ${e.n_stations} stations · ${ist(e.observed_at)}</p>
        <ol class="rank">${(e.worst||[]).map((s,i)=>`<li><span><span style="color:var(--dim);margin-right:8px">${i+1}</span><b>${esc(s.place)}</b></span><b style="color:${s.pm25>100?"#c0392b":"var(--body)"}">${s.pm25.toFixed(0)}</b></li>`).join("")}</ol>`
       :`<p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--orangeInk);margin:8px 0 0">Station-level data unavailable</p>
         <p style="font-size:11.5px;line-height:1.55;margin:8px 0 0">This replay target is a historical single-monitor composite. A spatial ranking exists only where station-level observations do.</p>
         <div style="background:var(--wash);border:1px solid var(--line);border-radius:7px;padding:11px;margin-top:11px">
           <p class="eyebrow">Target for this hour</p>
           <p class="big" style="font-size:19px;margin-top:5px">${(e.composite_pm25??d.observation.value).toFixed(0)}<s>µg/m³</s></p>
           <p class="sml">${e.n_monitors??1} monitor · ${esc(d.observation.source)}</p></div>
         <p class="note">Station-level capture began Sept 2026 — which is why AREE now records the whole network hourly.</p>`}
    </div>
  </div>

  <div class="sec"><span class="n">02</span><h2>What happens next?</h2>
    <span class="h">${d.forecast.horizon_hours}-hour PM2.5 forecast</span></div>
  <div class="card">
    <div class="legend" style="border-top:0;padding-top:0;margin-top:0;margin-bottom:8px">
      <span><span style="display:inline-block;width:13px;height:2px;background:var(--ink);vertical-align:middle;margin-right:5px"></span>Median forecast (L1)</span>
      <span><span style="display:inline-block;width:13px;height:8px;background:#f8d2b4;border-radius:2px;vertical-align:middle;margin-right:5px"></span>Upper-tail risk (q90) — not a prediction</span>
      <span><span style="display:inline-block;width:13px;height:2px;background:var(--redInk);vertical-align:middle;margin-right:5px"></span>Severe threshold</span>
      <span style="margin-left:auto">${Object.values(d.provenance.models).join(" · ")}</span>
    </div>
    ${chart(d)}
    <p class="note">Peak median <b style="color:var(--ink)">${d.forecast.summary.central_max.toFixed(0)}</b> ·
      peak upper-tail <b style="color:${ink}">${d.forecast.summary.upper_max.toFixed(0)}</b> µg/m³ ·
      Rule: q90 ≥ ${d.provenance.warning_rule.threshold_ugm3.toFixed(0)} µg/m³ for ≥ ${d.provenance.warning_rule.min_sustained_hours} h ·
      ${esc(d.provenance.warning_rule.validated_by)}</p>
  </div>

  <div class="sec"><span class="n">03</span><h2>Why?</h2>
    <span class="h">Meteorology drives dispersion, dispersion drives accumulation</span></div>
  <div class="card"><div class="grid g5">
    ${d.mechanism.links.filter(l=>l.available).map(l=>{
      const f=l.direction==="falling", w=l.label==="Wind"?"Weakening":l.label==="Boundary layer"?"Shrinking":"Deteriorating";
      return `<div class="mech"><div><p class="eyebrow">${esc(l.label)}</p>
        <p class="v">${l.now} → ${l.low}<s style="font-size:10px;color:var(--muted);font-weight:500;text-decoration:none"> ${esc(l.unit)}</s></p>
        <p class="d" style="color:${f?ink:"var(--muted)"}">${f?w:"Steady"}</p></div></div>`}).join("")}
    <div class="mech"><div><p class="eyebrow">Plume influence</p>
      <p class="v">${d.plume.available&&d.plume.influence!=null?d.plume.influence.toFixed(1):"None"}</p>
      <p class="d" style="color:var(--muted)">${d.plume.available?`${d.plume.detections_24h} detections`:"No fire record"}</p></div></div>
    <div class="mech"><div><p class="eyebrow">Dispersion</p>
      <p class="v" style="font-size:12.5px">${esc(d.mechanism.dispersion.verdict.replace(/^\w/,c=>c.toUpperCase()))}</p>
      <p class="d" style="color:${ink}">vs ${d.mechanism.dispersion.threshold_m2_s?.toFixed(0)} m²/s</p></div></div>
  </div>
  <p class="note" style="border-top:1px solid var(--line);padding-top:9px;margin-top:11px">${esc(d.mechanism.consequence)}.</p></div>

  <div class="sec"><span class="n">04</span><h2>When does risk cross?</h2>
    <span class="h">Forecast milestones, and how long is left to act</span></div>
  <div class="grid gA">
    <div class="grid" style="grid-template-columns:1fr 1fr;align-self:start">
      <div class="card"><p class="eyebrow">Severe expected</p>
        <p class="big" style="font-size:22px;color:${risk.first_crossing?ink:"var(--ink)"}">${risk.first_crossing?ist(risk.first_crossing,false):"None"}</p>
        <p class="cap">${risk.lead_hours!=null?`in ${risk.lead_hours.toFixed(0)} h`:"no crossing forecast"}</p>
        <p class="sml">${risk.first_crossing?`q90 ${risk.upper_at_crossing?.toFixed(0)} µg/m³`:`Upper tail stays below ${risk.threshold_ugm3.toFixed(0)}`}</p></div>
      <div class="card"><p class="eyebrow">Intervention window</p>
        <p class="big" style="font-size:22px">${dec.intervention_window_hours!=null?dec.intervention_window_hours.toFixed(1)+"":d.atmosphere.ventilation_forecast.intervention_window_hours?.toFixed(1)??"None"}<s>h</s></p>
        <p class="cap">Before the atmosphere stops clearing</p>
        <p class="sml">${d.atmosphere.ventilation_forecast.collapse?`Collapse ${ist(d.atmosphere.ventilation_forecast.collapse.onset)}`:"Ventilation stays above threshold"}</p></div>
    </div>
    <div class="card"><p class="eyebrow">Forecast milestones</p>
      <table><thead><tr><th>When</th><th>Atmospheric state</th><th>Consequence</th></tr></thead><tbody>
      ${d.timeline.map(m=>{const c=m.kind==="now"||m.kind==="recovery"?"#7fa86b":m.kind==="collapse"?"#e07a3f":"#c0392b";
        return `<tr><td style="white-space:nowrap;color:var(--ink);font-weight:600"><span class="dot" style="background:${c}"></span>${m.kind==="now"?"Now":ist(m.at)}${m.kind!=="now"?` <span style="color:var(--dim);font-weight:400">+${m.hours_from_now.toFixed(0)} h</span>`:""}</td>
        <td>${esc(m.state)}</td><td style="color:var(--muted)">${esc(m.consequence)}</td></tr>`}).join("")}
      </tbody></table></div>
  </div>

  <div class="sec"><span class="n">05</span><h2>What should the authority do?</h2>
    <span class="h">Advisory — legal authority rests with CAQM and the state boards</span></div>
  <div class="hero" style="background:${bg};border-color:${bd}">
    <div class="grid g2">
      <div><p class="eyebrow">Recommended response</p>
        <p style="font-size:15px;font-weight:800;color:${ink};margin:5px 0 0">${esc(dec.recommendation.call)}</p>
        <p class="dt">${esc(dec.recommendation.because)}</p>
        <p class="sml">GRAP stage from observed AQI: <b style="color:var(--body)">${esc(dec.grap_stage_observed)}</b> · priority ${esc(dec.priority)}</p></div>
      <div><p class="eyebrow">Case</p>
        <p style="font-size:13px;font-weight:700;color:var(--ink);margin:5px 0 0">${esc((dec.case_status||"NO CASE").replace(/_/g," "))}</p>
        <p class="sml">${dec.case_id?`Case ${esc(dec.case_id)} · deterministic id derived from the forecast moment`:"No case opened — trigger conditions not met"}</p>
        <p class="sml" style="margin-top:7px">Approval is recorded in the live system's audit trail. This snapshot is read-only.</p></div>
    </div>
    ${dec.recommended_measures.length?`<ul class="meas" style="border-color:${bd}">${dec.recommended_measures.map(m=>`<li>${esc(m)}</li>`).join("")}</ul>`:""}
    ${dec.reasons.length?`<div class="why" style="border-color:${bd}"><p class="eyebrow">Why this case exists</p>
      <ul style="margin:5px 0 0;padding-left:17px">${dec.reasons.map(r=>`<li>${esc(r)}</li>`).join("")}</ul></div>`:""}
  </div>

  <div class="prov">
    <span class="m" style="color:${d.mode==="replay"?"var(--violet)":"var(--greenInk)"}">${d.mode}</span>
    <span>${esc(d.provenance.note)}</span>
    <span style="color:var(--dim)">obs: ${esc(d.provenance.target_source)} · met: ${esc(d.provenance.feature_source)}</span>
  </div>`;

  document.getElementById("foot").innerHTML =
    `<b>What this file is.</b> A frozen capture of the AREE decision screen, taken __CAPTURED__.
     It contains the real payloads the backend produced — the forecast, the atmospheric mechanism,
     the warning rule and its validation, and the regulatory case — and it recomputes none of them.<br>
     <b>What it is not.</b> Not live, not a deployment, and not interactive beyond the four captured
     moments above. Approving a case writes to an audit trail, which needs the running system.<br>
     <b>Honest limits.</b> Replay meteorology is ERA5 reanalysis at valid time (perfect prognosis),
     not the forecast a duty officer held at that hour. The q90 line is upper-tail risk, never an
     expected value. There is no coupled chemistry model — AREE couples one way, forecast
     meteorology into a learned PM2.5 response. WRF-Chem is not implemented.`;

  [...document.querySelectorAll(".tab")].forEach(b=>b.setAttribute("aria-selected",String(b.dataset.k===key)));
}

const tabs=document.getElementById("tabs");
Object.entries(SCENES).forEach(([k,s])=>{
  const b=document.createElement("button");
  b.className="tab"; b.dataset.k=k; b.textContent=s.label; b.setAttribute("role","tab");
  b.onclick=()=>{location.hash=k;}; tabs.appendChild(b);
});

/* Hash routing, so a specific moment can be linked directly:
   AREE_Demo.html#nov02 opens the predictive-warning scene. Useful when the file is
   sent to someone with "look at this one" rather than "click the second tab". */
const KEYS=Object.keys(SCENES);
const DEFAULT=KEYS.includes("nov02")?"nov02":KEYS[0];
function show(){ const k=location.hash.replace("#",""); render(SCENES[k]?k:DEFAULT); }
addEventListener("hashchange",show);
show();
</script></body></html>
"""


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Build the shareable AREE snapshot")
    p.add_argument("--api", default=DEFAULT_API)
    p.add_argument("--from", dest="cache", default="",
                   help="directory of already-captured *.json payloads")
    p.add_argument("-o", "--out", default=str(ROOT / "AREE_Demo.html"))
    args = p.parse_args(argv)

    print("\nBuilding the shareable AREE snapshot")
    print("  " + "-" * 62)
    cache = Path(args.cache) if args.cache else None
    try:
        scenes = collect(args.api, cache)
    except Exception as exc:                                    # noqa: BLE001
        print(f"\n  Could not reach {args.api}: {exc}", file=sys.stderr)
        print("  Start the backend, or pass --from with captured payloads.\n",
              file=sys.stderr)
        return 2

    if not scenes:
        print("  No scenes captured.", file=sys.stderr)
        return 1
    for key, sc in scenes.items():
        d = sc["payload"]
        print(f"  {key:<6} {d['mode']:<7} {d['risk']['status']:<24} "
              f"{d['observation']['value']:>6.0f} ug/m3")
    build(scenes, Path(args.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
