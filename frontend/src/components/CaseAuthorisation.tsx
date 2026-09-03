"use client";

/* ==========================================================================
   Authorisation — the point where AREE stops and a person decides.

   WHY THIS COMPONENT MATTERS MORE THAN IT LOOKS
     Everything above it on the page is a recommendation. This is the only place
     where the product's central claim — "the system proposes, the authority
     disposes" — is either true or a caption. Until this existed, the case sat at
     AWAITING_APPROVAL forever and the demo had to narrate a step the software
     could not perform.

   WHAT IS ACTUALLY SENT
     The decision, the moment it applies to, who decided and why. NOT the evidence:
     the server recomputes the assessment from `as_of` and refuses if the case id it
     derives differs from the one being decided. So an approval is recorded against
     what the engine concluded, never against what this screen happened to display.

   NO PRETEND AUTHENTICATION
     There is none in the build, and the panel says so rather than dressing a demo
     name up as an identity. Every stored action carries actor_verified = false and
     the recorded decision repeats it.
   ========================================================================== */

import { useEffect, useState } from "react";
import { CheckCircle2, ChevronRight, Lock, ShieldCheck, XCircle } from "lucide-react";

import { api, errorMessage } from "@/lib/api";
import type { CaseRecord, OutlookDecision, OutlookRisk } from "@/types";

const C = {
  ink: "#1a1a17",
  body: "#44403a",
  muted: "#7d776c",
  dim: "#a8a196",
  line: "#e8e3d7",
  paper: "#ffffff",
  wash: "#faf8f2",
  greenInk: "#2f6b3f",
  greenBg: "#f3f8f2",
  green: "#d9e7d9",
  redInk: "#b91c1c",
  redBg: "#fdf2f0",
  red: "#f0d5cd",
  violet: "#4338ca",
};

function ist(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  })} · ${d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  })} IST`;
}

export default function CaseAuthorisation({
  decision,
  risk,
  asOf,
  tone,
  onDecided,
}: {
  decision: OutlookDecision;
  risk: OutlookRisk;
  asOf: string;
  tone: { ink: string; bg: string; border: string; dot: string };
  onDecided: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [actor, setActor] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [record, setRecord] = useState<CaseRecord | null>(null);

  const caseId = decision.case_id;

  /* Load the record when the outlook says this case is already decided.
     Without it a page RELOAD showed "approved by authority" with no name, time or
     reason — the local record only existed for whoever had clicked the button in
     that session. Reloading and finding the decision intact, with its actor and its
     stated reason, is the whole point of persisting it. */
  useEffect(() => {
    if (!caseId || !decision.case_decided) return;
    let cancelled = false;
    void api
      .case(caseId)
      .then((r) => {
        if (!cancelled) setRecord(r);
      })
      .catch(() => {
        /* The banner still reports the decided state from the outlook payload. */
      });
    return () => {
      cancelled = true;
    };
  }, [caseId, decision.case_decided]);

  if (!caseId || !decision.triggered) return null;

  const decided =
    record?.status === "APPROVED" ||
    record?.status === "REJECTED" ||
    decision.case_decided;
  const status = record?.status ?? decision.case_status;

  async function send(kind: "approve" | "reject") {
    if (!caseId) return;
    setBusy(kind);
    setError(null);
    try {
      const result = await api.decideCase(caseId, {
        decision: kind,
        as_of: asOf,
        actor: actor.trim() || undefined,
        reason: reason.trim() || undefined,
      });
      setRecord(result);
      onDecided();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  /* ── decided: the record, not the form ── */
  if (decided) {
    const approved = status === "APPROVED";
    const act = record?.actions?.find(
      (a) => a.action === "APPROVED" || a.action === "REJECTED",
    );
    const S = approved
      ? { ink: C.greenInk, bg: C.greenBg, border: C.green }
      : { ink: C.redInk, bg: C.redBg, border: C.red };

    return (
      <div
        className="mt-3 rounded-md border p-3.5"
        style={{ background: S.bg, borderColor: S.border }}
      >
        <div className="flex flex-wrap items-center gap-2">
          {approved ? (
            <CheckCircle2 className="h-4 w-4" style={{ color: S.ink }} />
          ) : (
            <XCircle className="h-4 w-4" style={{ color: S.ink }} />
          )}
          <span
            className="text-[13px] font-bold uppercase tracking-wide"
            style={{ color: S.ink }}
          >
            {approved ? "Approved by authority" : "Rejected by authority"}
          </span>
          {act ? (
            <span className="text-[11.5px]" style={{ color: C.body }}>
              {ist(act.timestamp)}
              {act.actor ? ` · ${act.actor}` : ""}
              {act.actor_role ? ` (${act.actor_role})` : ""}
            </span>
          ) : null}
        </div>

        {act?.reason ? (
          <p className="mt-1.5 text-[11.5px] leading-snug" style={{ color: C.body }}>
            “{act.reason}”
          </p>
        ) : null}

        <p className="mt-2 text-[10.5px]" style={{ color: C.dim }}>
          Recorded in the audit trail · case {caseId} · decision is final
          {act && !act.actor_verified
            ? " · identity self-declared, not authenticated"
            : ""}
        </p>

        {record?.actions?.length ? (
          <ul className="mt-2 border-t pt-2" style={{ borderColor: S.border }}>
            {record.actions.map((a) => (
              <li
                key={a.action_id}
                className="flex flex-wrap gap-x-2 py-0.5 text-[10.5px]"
                style={{ color: C.muted }}
              >
                <span className="font-mono font-semibold" style={{ color: C.body }}>
                  {a.action}
                </span>
                <span>{ist(a.timestamp)}</span>
                <span>· {a.actor}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  /* ── awaiting: review, then decide ── */
  return (
    <div
      className="mt-3 rounded-md border p-3.5"
      style={{ background: C.paper, borderColor: tone.border }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" style={{ color: tone.ink }} />
          <span
            className="text-[12px] font-bold uppercase tracking-wide"
            style={{ color: tone.ink }}
          >
            Awaiting authority approval
          </span>
        </span>
        {!open ? (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-[11.5px] font-semibold transition"
            style={{ borderColor: tone.border, color: tone.ink, background: tone.bg }}
          >
            Review evidence <ChevronRight className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {open ? (
        <>
          {/* The basis, restated at the point of decision. An approval screen that
              does not show what is being approved is a button, not a decision. */}
          <dl
            className="mt-3 grid gap-x-6 gap-y-1.5 border-t pt-3 sm:grid-cols-2"
            style={{ borderColor: C.line }}
          >
            {[
              ["Recommendation", decision.recommendation.call],
              ["Priority", decision.priority],
              ["Basis", decision.trigger_rule],
              [
                "Lead time",
                risk.lead_hours !== null ? `${risk.lead_hours.toFixed(0)} h` : "—",
              ],
              [
                "Severe expected",
                risk.first_crossing ? ist(risk.first_crossing) : "not forecast",
              ],
              ["GRAP basis", decision.grap_stage_observed],
              ["Measures", `${decision.recommended_measures.length}`],
              ["Responsible", decision.responsible_authority],
            ].map(([k, v]) => (
              <div key={k as string} className="flex justify-between gap-3">
                <dt className="text-[11px]" style={{ color: C.muted }}>
                  {k as string}
                </dt>
                <dd
                  className="text-right text-[11px] font-semibold"
                  style={{ color: C.ink }}
                >
                  {v as string}
                </dd>
              </div>
            ))}
          </dl>

          <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <label className="block">
              <span className="text-[10px] font-bold uppercase" style={{ color: C.muted }}>
                Officer
              </span>
              <input
                value={actor}
                onChange={(e) => setActor(e.target.value)}
                placeholder="Demo Authority"
                className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
                style={{ borderColor: C.line, color: C.ink }}
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-bold uppercase" style={{ color: C.muted }}>
                Reason (recorded verbatim)
              </span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Basis for the decision"
                className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
                style={{ borderColor: C.line, color: C.ink }}
              />
            </label>
          </div>

          {error ? (
            <p className="mt-2 text-[11.5px] font-semibold" style={{ color: C.redInk }}>
              {error}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void send("approve")}
              className="rounded-md px-4 py-2 text-[12px] font-bold text-white transition disabled:opacity-60"
              style={{ background: C.greenInk }}
            >
              {busy === "approve" ? "Recording…" : "Approve"}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void send("reject")}
              className="rounded-md border px-4 py-2 text-[12px] font-bold transition disabled:opacity-60"
              style={{ borderColor: C.red, color: C.redInk, background: C.redBg }}
            >
              {busy === "reject" ? "Recording…" : "Reject"}
            </button>
            <span
              className="ml-auto flex items-center gap-1.5 text-[10.5px]"
              style={{ color: C.dim }}
            >
              <Lock className="h-3 w-3" />
              No authentication in this build — the name is self-declared and stored
              unverified.
            </span>
          </div>
        </>
      ) : (
        <p className="mt-1.5 text-[11.5px]" style={{ color: C.body }}>
          {decision.recommendation.next_step}
        </p>
      )}
    </div>
  );
}
