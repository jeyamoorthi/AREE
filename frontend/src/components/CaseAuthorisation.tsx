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

   AUTHENTICATION IS REAL, AND THE PANEL DOES NOT OVERSTATE IT
     An officer signs in; the server issues a short-lived signed token; the acting
     identity written into the audit trail is the token's subject. This screen
     cannot name the actor — the field for typing one is gone, because it had no
     effect worth offering. Actions recorded this way carry actor_verified = true.

     What the panel still says out loud is WHICH register the identity came from.
     An instance running on demo operators generated at startup has genuinely
     verified identity against a register that is not real, and those are two
     different claims. GET /api/auth/config reports the difference and the footer
     repeats it.
   ========================================================================== */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  History,
  Loader2,
  Lock,
  ShieldCheck,
  XCircle,
} from "lucide-react";

import EvidencePanel, { type CaseEvidence } from "@/components/EvidencePanel";
import { api, auth, errorMessage } from "@/lib/api";
import { COLORS } from "@/lib/theme";
import type { CaseRecord, OutlookDecision, OutlookMode, OutlookRisk } from "@/types";

const C = {
  ink: "var(--aree-text)",
  body: "var(--aree-body)",
  muted: "var(--aree-muted)",
  dim: "var(--aree-dim)",
  line: "var(--aree-border)",
  paper: "var(--aree-surface-1)",
  wash: "var(--aree-surface-2)",
  greenInk: "var(--aree-green)",
  greenBg: "color-mix(in srgb, var(--aree-green) 8%, transparent)",
  green: "color-mix(in srgb, var(--aree-green) 30%, transparent)",
  redInk: "var(--aree-red)",
  redBg: "color-mix(in srgb, var(--aree-red) 8%, transparent)",
  red: "color-mix(in srgb, var(--aree-red) 35%, transparent)",
  violet: "var(--aree-violet)",
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

/* ── the friction ─────────────────────────────────────────────────────────
   WHY A SECOND STEP EXISTS AT ALL
     Approve was one click from a regulatory record this build treats as FINAL — the
     backend answers 409 to a second decision, deliberately, because an audit trail
     whose last write wins is not an audit trail. A single mis-click was therefore
     unrecoverable. The confirmation is not ceremony; it is the only remaining point
     at which the decision can still be taken back.

   WHY A FIXED VOCABULARY
     Free text records whatever was typed, which across officers means nothing
     comparable. A closed list makes "on what grounds was this approved" a question
     the stored record can actually answer; the note carries the specifics that do
     not generalise. Both travel in the ONE field the API has.                     */
const DECISION_REASONS = [
  "Evidence sufficient",
  "Manual override — field conditions",
  "Escalating beyond recommendation",
  "Deferring — insufficient data",
] as const;

type DecisionReason = (typeof DECISION_REASONS)[number];
type DecisionKind = "approve" | "reject";

/**
 * The backend stores `reason` verbatim and truncates at 500 characters
 * (case_store.decide: `(reason or "").strip()[:500]`). The same limit is applied
 * here so an officer watches their note stop rather than discovering afterwards
 * that the audit trail kept only the first half of it.
 */
const REASON_MAX = 500;
const NOTE_SEPARATOR = " · ";

/**
 * One field, two pieces of information.
 *
 * The API has `reason` and nothing else. There is no `note` column, so the note is
 * appended to the selected reason rather than invented as a field the contract does
 * not have. What is sent is exactly what the decided panel reads back, so the round
 * trip stays honest.
 */
function composeReason(reason: DecisionReason, note: string): string {
  const trimmed = note.trim();
  const composed = trimmed ? `${reason}${NOTE_SEPARATOR}${trimmed}` : reason;
  return composed.slice(0, REASON_MAX);
}

/** Characters still available to the note, given the selected reason. */
function noteBudget(reason: DecisionReason | ""): number {
  if (!reason) return REASON_MAX;
  return Math.max(0, REASON_MAX - reason.length - NOTE_SEPARATOR.length);
}

/**
 * Confirmation dialog.
 *
 * Local to this file on purpose: it is not a generic modal, it is the second half of
 * one decision, and every control in it is specific to that. The application has no
 * shared dialog component — CommandPalette is the only other one — so this follows
 * that component's overlay pattern rather than introducing a framework for it.
 */
function ConfirmDecisionDialog({
  kind,
  decision,
  reason,
  note,
  submitting,
  error,
  onReasonChange,
  onNoteChange,
  onCancel,
  onConfirm,
}: {
  kind: DecisionKind;
  decision: OutlookDecision;
  reason: DecisionReason | "";
  note: string;
  submitting: boolean;
  error: string | null;
  onReasonChange: (reason: DecisionReason | "") => void;
  onNoteChange: (note: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descId = useId();
  const reasonId = useId();
  const reasonHintId = useId();
  const noteId = useId();
  const errorId = useId();

  const dialogRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLSelectElement>(null);

  const approving = kind === "approve";
  const accent = approving ? COLORS.green : COLORS.red;

  /* Focus enters on the control that gates the dialog, and returns to whatever
     opened it — so a keyboard user is never dropped back at the top of the page. */
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    reasonRef.current?.focus();
    return () => opener?.focus?.();
  }, []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        // Not while a decision is in flight: cancelling then would clear the reason
        // out from under the request that is carrying it.
        if (!submitting) {
          event.preventDefault();
          onCancel();
        }
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href]",
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onCancel, submitting],
  );

  const budget = noteBudget(reason);
  const ready = reason !== "" && !submitting;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 px-4 py-6 backdrop-blur-sm"
      role="presentation"
      onClick={submitting ? undefined : onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-lg border shadow-2xl"
        style={{ background: COLORS.surface1, borderColor: COLORS.border }}
      >
        <div
          className="flex items-start gap-2.5 border-b px-5 py-4"
          style={{ borderColor: COLORS.border }}
        >
          {approving ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" style={{ color: accent }} aria-hidden />
          ) : (
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: accent }} aria-hidden />
          )}
          <div className="min-w-0">
            <h2
              id={titleId}
              className="text-[14px] font-bold tracking-tight"
              style={{ color: COLORS.text }}
            >
              {approving ? "Confirm approval" : "Confirm rejection"}
            </h2>
            <p
              id={descId}
              className="mt-1 text-[11.5px] leading-snug"
              style={{ color: COLORS.muted }}
            >
              {approving
                ? `Recording approval of “${decision.recommendation.call}” for ${decision.responsible_authority}.`
                : `Recording rejection of “${decision.recommendation.call}”.`}{" "}
              A decision is final in this build and is written to the audit trail.
            </p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <label
            htmlFor={reasonId}
            className="block text-[10px] font-bold uppercase tracking-wide"
            style={{ color: COLORS.muted }}
          >
            Reason{" "}
            <span style={{ color: COLORS.red }} aria-hidden>
              *
            </span>
            <span className="sr-only">(required)</span>
          </label>
          <select
            ref={reasonRef}
            id={reasonId}
            value={reason}
            required
            aria-required="true"
            aria-describedby={reasonHintId}
            disabled={submitting}
            onChange={(event) => onReasonChange(event.target.value as DecisionReason | "")}
            className="mt-1.5 w-full rounded border px-2.5 py-2 text-[12.5px] disabled:opacity-60"
            style={{
              borderColor: COLORS.border,
              color: COLORS.text,
              background: COLORS.surface2,
            }}
          >
            <option value="">Select a reason…</option>
            {DECISION_REASONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
          <p id={reasonHintId} className="mt-1 text-[10.5px]" style={{ color: COLORS.dim }}>
            Required. Stored verbatim against this case.
          </p>

          <label
            htmlFor={noteId}
            className="mt-4 block text-[10px] font-bold uppercase tracking-wide"
            style={{ color: COLORS.muted }}
          >
            Note <span style={{ color: COLORS.dim }}>(optional)</span>
          </label>
          <textarea
            id={noteId}
            value={note}
            rows={3}
            maxLength={budget}
            disabled={submitting}
            onChange={(event) => onNoteChange(event.target.value)}
            placeholder="Anything the reason above does not capture"
            className="mt-1.5 w-full resize-y rounded border px-2.5 py-2 text-[12.5px] disabled:opacity-60"
            style={{ borderColor: COLORS.border, color: COLORS.text }}
          />
          <p className="mt-1 text-[10.5px]" style={{ color: COLORS.dim }}>
            {note.length}/{budget} characters · appended to the reason, which the record
            stores as one field.
          </p>

          {error ? (
            <p
              id={errorId}
              role="alert"
              aria-live="assertive"
              className="mt-3 flex items-start gap-1.5 rounded border px-2.5 py-2 text-[11.5px] font-semibold"
              style={{
                color: COLORS.red,
                borderColor: COLORS.red,
                background: `color-mix(in srgb, ${COLORS.red} 8%, transparent)`,
              }}
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                {error}
                <span className="mt-0.5 block font-normal" style={{ color: COLORS.muted }}>
                  Your reason has been kept — confirm again to retry.
                </span>
              </span>
            </p>
          ) : null}
        </div>

        <div
          className="flex flex-wrap items-center justify-end gap-2 border-t px-5 py-3.5"
          style={{ borderColor: COLORS.border, background: COLORS.surface2 }}
        >
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            aria-label={
              approving
                ? "Cancel this approval and close the dialog"
                : "Cancel this rejection and close the dialog"
            }
            className="rounded-md border px-3.5 py-2 text-[12px] font-semibold transition disabled:opacity-60"
            style={{ borderColor: COLORS.border, color: COLORS.body }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!ready}
            aria-describedby={error ? errorId : undefined}
            aria-label={
              approving
                ? "Record the approval. This decision is final."
                : "Record the rejection. This decision is final."
            }
            className="flex items-center gap-1.5 rounded-md px-4 py-2 text-[12px] font-bold text-aree-on-solid transition disabled:cursor-not-allowed disabled:opacity-50"
            style={{ background: accent }}
          >
            {submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Recording…
              </>
            ) : approving ? (
              "Confirm approval"
            ) : (
              "Confirm rejection"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CaseAuthorisation({
  decision,
  risk,
  asOf,
  mode,
  evidence,
  tone,
  onDecided,
}: {
  decision: OutlookDecision;
  risk: OutlookRisk;
  asOf: string;
  /**
   * The payload's own mode for THIS assessment.
   *
   * Passed rather than read from useOutlookMode() on purpose. That context is
   * published from an effect, so it trails the payload by one render immediately
   * after the moment changes — a window in which the page would already be showing
   * November 2024 while the context still said "live". A safety gate cannot have
   * that window, so it reads the same object the evidence and the case id came from.
   */
  mode: OutlookMode;
  /* Selected ONCE by the page from the same payload that produced `decision` and
     `risk`, then handed down. Passing the resolved rows rather than the whole
     response keeps this component from growing a dependency on the entire outlook
     contract, and makes it impossible for the evidence beside the Approve button
     to describe a different moment than the case it sits on. */
  evidence: CaseEvidence;
  tone: { ink: string; bg: string; border: string; dot: string };
  onDecided: () => void;
}) {
  const [open, setOpen] = useState(false);
  const session = useSyncExternalStore(
    auth.subscribe,
    auth.session,
    auth.serverSession,
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [demoRegister, setDemoRegister] = useState(false);
  const [record, setRecord] = useState<CaseRecord | null>(null);

  /* The pending decision. Non-null means the confirmation dialog is open and NOTHING
     has been sent yet — clicking Approve or Reject now only sets this. */
  const replayNoticeId = useId();
  const [pending, setPending] = useState<DecisionKind | null>(null);
  const [reasonChoice, setReasonChoice] = useState<DecisionReason | "">("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* Guards against a second POST from a double-click or a held Enter. `submitting`
     state cannot do this alone: two handlers can both run before React re-renders,
     and the backend answers 409 to the loser, which would surface as a spurious
     "already decided" error on a decision that in fact succeeded. */
  const inFlight = useRef(false);

  const caseId = decision.case_id;

  /* A replayed assessment is a reconstruction of a past hour. Approving one would
     write a real, final regulatory record against evidence that has already been
     overtaken — and the backend would accept it, because the decision endpoint
     recomputes from `as_of` and that recomputation succeeds perfectly well for 2024.
     Nothing downstream stops this; it has to stop here. */
  const replay = mode === "replay";

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

  // Restore an existing tab session, and ask the server which operator register
  // it is running. Both are read-only and safe to do on every mount.
  useEffect(() => {
    let cancelled = false;
    auth
      .config()
      .then((c) => {
        if (!cancelled) setDemoRegister(c.mode === "demo-credentials");
      })
      .catch(() => {
        /* Not knowing is not worth blocking the panel over. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function signIn() {
    setSigningIn(true);
    setAuthError(null);
    try {
      await auth.signIn(username.trim(), password);
      setPassword("");
    } catch (err) {
      setAuthError(errorMessage(err));
    } finally {
      setSigningIn(false);
    }
  }

  function signOut() {
    auth.signOut();
  }

  if (!caseId || !decision.triggered) return null;

  const decided =
    record?.status === "APPROVED" ||
    record?.status === "REJECTED" ||
    decision.case_decided;
  const status = record?.status ?? decision.case_status;

  /* STEP 1. Opens the dialog and remembers which way. No request is made here, and
     none is made by selecting a reason either — only `submit` talks to the API. */
  function openConfirm(kind: DecisionKind) {
    // Belt as well as braces: the buttons are disabled, but a programmatic call must
    // not be able to open a dialog whose only purpose is to reach the API.
    if (replay) return;
    setPending(kind);
    setError(null);
  }

  /* Cancel discards the whole pending decision, so reopening starts clean rather
     than silently reusing a reason chosen for the other outcome. */
  function cancelConfirm() {
    if (inFlight.current) return;
    setPending(null);
    setReasonChoice("");
    setNote("");
    setError(null);
  }

  /* STEP 2. The only place in this component that calls the API. */
  async function submit() {
    if (!caseId || !pending || reasonChoice === "") return;
    /* THE LOAD-BEARING GUARD. Every path to the decision endpoint runs through this
       function, so this one line is what makes "a replay cannot authorise" true rather
       than merely displayed. It stays even though the dialog cannot be opened in
       replay, because a disabled control is a UI state and this is a correctness one. */
    if (replay) return;
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.decideCase(caseId, {
        decision: pending,
        as_of: asOf,
        reason: composeReason(reasonChoice, note),
      });
      setRecord(result);
      // Only on success: a failed attempt keeps the dialog, the reason and the note
      // so the officer can retry instead of re-deciding from scratch.
      setPending(null);
      setReasonChoice("");
      setNote("");
      onDecided();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inFlight.current = false;
      setSubmitting(false);
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
            ? " · identity self-declared, recorded unverified"
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
            aria-expanded={open}
            aria-label={`Review the evidence behind case ${caseId}`}
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
            className="mt-3 grid gap-x-6 gap-y-1.5 border-t pt-3 grid-cols-[minmax(0,1fr)] sm:grid-cols-2"
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

          {/* The reason lives in the confirmation dialog, as a required closed list.
              IDENTITY. Not an input — a state. Either the server has verified an
              officer, or it has not, and no field on this screen changes which. */}
          {session ? (
            <div
              className="mt-3 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
              style={{ background: C.greenBg, borderColor: C.green }}
            >
              <ShieldCheck className="h-4 w-4" style={{ color: C.greenInk }} />
              <span className="text-[12px] font-bold" style={{ color: C.greenInk }}>
                {session.subject}
              </span>
              <span className="text-[11px]" style={{ color: C.body }}>
                signed in as {session.role}
              </span>
              <button
                type="button"
                onClick={signOut}
                className="ml-auto text-[11px] font-semibold underline"
                style={{ color: C.muted }}
              >
                Sign out
              </button>
            </div>
          ) : (
            <div
              className="mt-3 rounded-md border p-3"
              style={{ background: C.wash, borderColor: C.line }}
            >
              <p className="text-[11.5px] font-semibold" style={{ color: C.ink }}>
                Sign in to record a decision
              </p>
              <p className="mt-0.5 text-[11px]" style={{ color: C.muted }}>
                The acting officer is taken from your session, not from this page.
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Operator ID"
                  autoComplete="username"
                  className="rounded border px-2 py-1.5 text-[12px]"
                  style={{ borderColor: C.line, color: C.ink }}
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void signIn();
                  }}
                  placeholder="Password"
                  autoComplete="current-password"
                  className="rounded border px-2 py-1.5 text-[12px]"
                  style={{ borderColor: C.line, color: C.ink }}
                />
                <button
                  type="button"
                  disabled={signingIn || !username.trim() || !password}
                  onClick={() => void signIn()}
                  className="rounded-md px-4 py-1.5 text-[12px] font-bold text-white transition disabled:opacity-50"
                  style={{ background: C.ink }}
                >
                  {signingIn ? "Signing in…" : "Sign in"}
                </button>
              </div>
              {authError ? (
                <p
                  className="mt-1.5 text-[11.5px] font-semibold"
                  style={{ color: C.redInk }}
                >
                  {authError}
                </p>
              ) : null}
            </div>
          )}

          {/* The basis, one click away, immediately above the two buttons that act
              on it. The summary list higher up says WHAT is recommended; this says
              what the recommendation rests on. */}
          <EvidencePanel evidence={evidence} className="mt-3" />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* Disabled, NOT hidden. A missing button is ambiguous — it reads as "this
                case has no decision to make". A greyed one beside a sentence saying
                why reads as "not from here", which is the true statement. `disabled`
                is the real attribute, so the control is out of the tab order and
                inert to a click; it is not pointer-events trickery. */}
            <button
              type="button"
              disabled={submitting || replay || !session}
              aria-haspopup="dialog"
              aria-describedby={replay ? replayNoticeId : undefined}
              aria-label={`Approve the recommended escalation for case ${caseId}`}
              onClick={() => openConfirm("approve")}
              className="rounded-md px-4 py-2 text-[12px] font-bold text-aree-on-solid transition disabled:cursor-not-allowed disabled:opacity-50"
              style={{ background: C.greenInk }}
              title={replay ? "Authorisation unavailable in replay mode" : undefined}
            >
              Approve
            </button>
            <button
              type="button"
              disabled={submitting || replay || !session}
              aria-haspopup="dialog"
              aria-describedby={replay ? replayNoticeId : undefined}
              aria-label={`Reject the recommended escalation for case ${caseId}`}
              onClick={() => openConfirm("reject")}
              className="rounded-md border px-4 py-2 text-[12px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50"
              style={{ borderColor: C.red, color: C.redInk, background: C.redBg }}
              title={replay ? "Authorisation unavailable in replay mode" : undefined}
            >
              Reject
            </button>
            {replay ? (
              <span
                id={replayNoticeId}
                className="ml-auto flex items-center gap-1.5 text-[10.5px] font-semibold"
                style={{ color: C.violet }}
              >
                <History className="h-3 w-3" aria-hidden />
                Authorisation unavailable in replay mode — this view reconstructs{" "}
                {ist(asOf)} and cannot record a decision.
              </span>
            ) : (
              <span
                className="ml-auto flex items-center gap-1.5 text-[10.5px]"
                style={{ color: C.dim }}
              >
                <Lock className="h-3 w-3" />
                {!session
                  ? "Sign in to act. The server rejects an unauthenticated decision."
                  : demoRegister
                    ? "Identity verified against DEMO operators generated at startup — real, but not a real register."
                    : "Identity verified from your signed token and stored with the decision."}
              </span>
            )}
          </div>
        </>
      ) : (
        <p className="mt-1.5 text-[11.5px]" style={{ color: C.body }}>
          {decision.recommendation.next_step}
        </p>
      )}

      {pending ? (
        <ConfirmDecisionDialog
          kind={pending}
          decision={decision}
          reason={reasonChoice}
          note={note}
          submitting={submitting}
          error={error}
          onReasonChange={(next) => {
            setReasonChoice(next);
            // The reason eats into the same 500 characters, so a note typed before a
            // reason was picked can no longer fit. Trimming here keeps the counter
            // truthful; without it the field would read "500/476" and the backend
            // would do the cutting silently.
            setNote((current) => current.slice(0, noteBudget(next)));
          }}
          onNoteChange={setNote}
          onCancel={cancelConfirm}
          onConfirm={() => void submit()}
        />
      ) : null}
    </div>
  );
}
