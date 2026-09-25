/**
 * What went wrong when a report was asked for, in the operator's language.
 *
 * WHY THIS IS NOT A GENERIC ERROR RENDERER
 *   components/ui/States.tsx already has one, and it is right for the rest of the
 *   application: it describes a failed FETCH. Report generation fails in ways that
 *   call for different actions from an authority — pick a different station, wait for
 *   the engine, call an administrator — and "Request failed with status 500" tells
 *   them none of that. Each case below is mapped to what the person in front of the
 *   screen should actually do next.
 *
 * THE STATUSES ARE THE BACKEND'S, NOT INVENTED
 *   Every branch corresponds to something api/deps.py or api/routes/reports.py
 *   actually raises: 404 station_not_found, 422 data_invalid, 424 feed_unavailable
 *   and feed_error, 425 awaiting_telemetry, 500 report_generation_failed, 503
 *   engine_starting and engine_unavailable. A status this file does not recognise
 *   falls through to a branch that says so plainly rather than guessing.
 */

import { ApiError, NetworkError, TimeoutError } from "@/lib/api";

export interface ReportErrorPresentation {
  /** Short state, in the same register as the rest of the application's banners. */
  title: string;
  /** The sentence the operator reads. Always names an action where one exists. */
  message: string;
  /** The backend's own words, kept for the record. Omitted when it adds nothing. */
  detail?: string;
  /** HTTP status, shown so a support conversation has something to quote. */
  status?: number;
  /** False where retrying cannot possibly help. */
  retryable: boolean;
}

export function reportErrorPresentation(error: Error): ReportErrorPresentation {
  if (error instanceof TimeoutError) {
    const seconds = Math.round(error.timeoutMs / 1000);
    return {
      title: "Generation timed out",
      message: `Report generation timed out after ${seconds} seconds. This may be a temporary issue.`,
      retryable: true,
    };
  }

  if (error instanceof NetworkError) {
    return {
      title: "Cannot reach the engine",
      message:
        "The browser could not reach the AREE API at all. Check that the backend is running, then try again.",
      detail: error.message,
      retryable: true,
    };
  }

  if (!(error instanceof ApiError)) {
    return {
      title: "Report generation failed",
      message:
        "The report could not be generated. Try again; if it keeps failing, contact your administrator.",
      detail: error.message,
      retryable: true,
    };
  }

  const status = error.status;
  const code = error.body?.error;
  const detail = error.body?.detail ?? error.message;

  /* The engine generated the brief and then failed to render it. The distinction
     matters: the DATA exists and is retrievable by other means, so the operator is
     not blocked on the analysis — they are blocked on a document. Retrying the same
     request will usually fail the same way, so this one does not invite it. */
  if (status === 500 && code === "report_generation_failed") {
    return {
      title: "Could not build the PDF",
      message:
        "The report was generated but could not be converted to PDF. The data is available — contact your administrator.",
      detail,
      status,
      retryable: false,
    };
  }

  if (status === 500) {
    return {
      title: "Server error",
      message: "The server encountered an error. Try again in a few minutes.",
      detail,
      status,
      retryable: true,
    };
  }

  if (status === 503) {
    return {
      title: code === "engine_starting" ? "Engine still starting" : "Engine offline",
      message:
        code === "engine_starting"
          ? "The AREE engine is still starting up. Try again in a few seconds."
          : "The AREE engine is currently offline. Check the engine status in the sidebar.",
      detail,
      status,
      retryable: true,
    };
  }

  if (status === 404) {
    return {
      title: "Station not found",
      message:
        "Station not found. It is no longer known to the engine — pick another from the list.",
      detail,
      status,
      retryable: false,
    };
  }

  /* 424 is the upstream feed, not AREE. Retrying is pointless while the monitor is
     dormant, so the action offered is a different station rather than another go. */
  if (status === 424) {
    return {
      title: "Station not reporting",
      message:
        "This station is not currently reporting data. Select a different station or try again later.",
      detail,
      status,
      retryable: false,
    };
  }

  if (status === 425) {
    return {
      title: "Awaiting telemetry",
      message:
        "The engine has not closed a window for this station yet, so there is nothing to report on. Try again in a few minutes.",
      detail,
      status,
      retryable: true,
    };
  }

  if (status === 422) {
    return {
      title: "Upstream data rejected",
      message:
        "The most recent payload for this station failed validation, so no report can be built from it. Select a different station or wait for the next reading.",
      detail,
      status,
      retryable: false,
    };
  }

  return {
    title: "Report generation failed",
    message: `The server answered ${status}. Try again; if it keeps failing, quote this status to your administrator.`,
    detail,
    status,
    retryable: true,
  };
}
