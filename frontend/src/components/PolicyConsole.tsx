"use client";

/**
 * Policy intelligence workspace.
 */

import { CheckCircle2, Upload, AlertCircle, Lock } from "lucide-react";
import { useId, useRef, useState, useSyncExternalStore } from "react";

import { usePolling } from "@/hooks/usePolling";
import { ApiError, api, auth, errorMessage } from "@/lib/api";
import { istDateTime } from "@/lib/clock";
import { orDash } from "@/lib/theme";
import type { PolicyFile, PolicyResponse, PolicyUploadResponse } from "@/types";
import { IntelligencePanel, StatusBadge, Stat } from "./ui/Card";
import { EmptyState, SectionState } from "./ui/States";

/** The capability the upload route requires (backend/api/auth.py: admin only). */
const POLICY_WRITE = "policy:write";

/** The backend writes `modified` as "YYYY-MM-DD HH:MM" in UTC; shown in IST. */
function modifiedIst(modified: string): string {
  return istDateTime(`${modified.replace(" ", "T")}:00Z`) ?? `${modified} UTC`;
}

/* Upload failures an operator can act on, said in terms of what to do next. The
   session is the same one the case-authorisation panel uses (lib/api `auth`). */
function uploadErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 401) {
    return "Your sign-in has expired or was not accepted. Sign in again.";
  }
  if (err instanceof ApiError && err.status === 403) {
    return "Your role can't upload policy documents (administrator required).";
  }
  return errorMessage(err);
}

function AdminSignIn({ signedInAs }: { signedInAs: string | null }) {
  const userId = useId();
  const passId = useId();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setSigningIn(true);
    setError(null);
    try {
      await auth.signIn(username.trim(), password);
      setPassword("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSigningIn(false);
    }
  }

  return (
    <form
      className="mt-6 rounded-lg border border-aree-border bg-aree-surface-2 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void signIn();
      }}
    >
      <div className="flex items-center gap-2 text-sm font-bold text-aree-text">
        <Lock className="h-4 w-4" aria-hidden />
        Uploading policy documents requires an administrator sign-in
      </div>
      <p className="mt-1 text-xs text-aree-muted">
        {signedInAs
          ? `You are signed in as ${signedInAs}, which cannot upload. Signing in as an administrator replaces that session in this tab.`
          : "Sign in with an administrator account. The session is shared with case authorisation in this tab."}
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <label
            htmlFor={userId}
            className="block text-[10px] font-bold uppercase tracking-wide text-aree-muted"
          >
            Username
          </label>
          <input
            id={userId}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            className="mt-1 w-full rounded border border-aree-border bg-aree-surface-1 px-2 py-1.5 text-xs text-aree-text"
          />
        </div>
        <div>
          <label
            htmlFor={passId}
            className="block text-[10px] font-bold uppercase tracking-wide text-aree-muted"
          >
            Password
          </label>
          <input
            id={passId}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            className="mt-1 w-full rounded border border-aree-border bg-aree-surface-1 px-2 py-1.5 text-xs text-aree-text"
          />
        </div>
        <button
          type="submit"
          disabled={signingIn || !username.trim() || !password}
          className="rounded-md bg-aree-forest px-4 py-1.5 text-xs font-bold text-aree-on-solid transition disabled:opacity-50"
        >
          {signingIn ? "Signing in…" : "Sign in"}
        </button>
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-xs font-semibold text-aree-red">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export default function PolicyConsole() {
  const state = usePolling<PolicyResponse>((signal) => api.policy(signal), {
    intervalMs: 15000,
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<PolicyUploadResponse | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const session = useSyncExternalStore(auth.subscribe, auth.session, auth.serverSession);
  const canUpload = session?.capabilities?.includes(POLICY_WRITE) ?? false;

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    setResult(null);
    try {
      const response = await api.uploadPolicy(file);
      setResult(response);
      state.refresh();
    } catch (err) {
      // A rejected token is no longer a session worth showing as signed in.
      if (err instanceof ApiError && err.status === 401) auth.signOut();
      setUploadError(uploadErrorMessage(err));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <SectionState state={state} skeletonRows={4} loadingLabel="Loading policy index…">
      {(policy) => {
        const storeStatus = policy.store_status ?? "starting";
        const isStoreActive = storeStatus === "active";
        
        let statusColor = "var(--aree-yellow)";
        let statusVariant: "solid" | "outline" | "ghost" = "outline";
        
        if (isStoreActive) {
          statusColor = "var(--aree-green)";
          statusVariant = "solid";
        } else if (storeStatus !== "starting") {
          statusColor = "var(--aree-red)";
        }
        
        // Direct mode lists the documents on disk but embeds none of them.
        const directMode = storeStatus === "unavailable";
        const fileStatus = (file: PolicyFile) => {
          if (!file.supported) return { ok: false, label: "Unsupported" };
          if (file.parse_error) return { ok: false, label: "Parse error · not indexed" };
          if (directMode) return { ok: false, label: "On disk · not indexed (direct mode)" };
          if (!isStoreActive) return { ok: false, label: "Awaiting index" };
          return { ok: true, label: "Indexed" };
        };

        const latest =
          policy.policy_files.length > 0
            ? policy.policy_files.reduce((newest, file) =>
                file.modified > newest.modified ? file : newest,
              )
            : null;

        return (
          <div className="grid gap-6 grid-cols-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)]">
            <IntelligencePanel
              title="Policy index"
              variant="default"
              headerAction={
                <StatusBadge color={statusColor} variant={statusVariant}>
                  {storeStatus}
                </StatusBadge>
              }
            >
              <div className="p-4 sm:p-6">
                <div className="grid gap-6 grid-cols-[minmax(0,1fr)] sm:grid-cols-2 lg:grid-cols-4 mb-8">
                  <div className="bg-aree-surface-2 p-4 rounded-lg border border-aree-border">
                    <Stat label="Files on disk" value={policy.files_on_disk ?? policy.docs_indexed} color="var(--aree-green)" />
                  </div>
                  <div className="bg-aree-surface-2 p-4 rounded-lg border border-aree-border">
                    <Stat label="Chunks indexed" value={policy.chunks_indexed} />
                  </div>
                  <div className="bg-aree-surface-2 p-4 rounded-lg border border-aree-border">
                    <Stat
                      label="Index type"
                      value={orDash(policy.index_type, "Initializing")}
                      mono={false}
                      size="sm"
                    />
                  </div>
                  <div className="bg-aree-surface-2 p-4 rounded-lg border border-aree-border">
                    <Stat
                      label="Embedding model"
                      value={orDash(policy.embed_model, "Not available")}
                      mono={false}
                      size="sm"
                      sub={
                        policy.last_reindex ? `refreshed ${policy.last_reindex} UTC` : undefined
                      }
                    />
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-bold text-aree-text mb-4">Indexed Documents</h4>
                  {policy.policy_files.length === 0 ? (
                    <EmptyState>
                      No policy documents found in the policies/ folder.
                    </EmptyState>
                  ) : (
                    <div className="border border-aree-border bg-aree-card overflow-x-auto rounded-lg">
                      <table className="w-full border-collapse text-left text-sm">
                        <caption className="sr-only">
                          Policy documents in the retrieval index: filename, type,
                          size, last modified and parse status.
                        </caption>
                        <thead>
                          <tr className="border-b border-aree-border bg-aree-surface-2">
                            {["Filename", "Type", "Size", "Modified (IST)", "Status"].map((h, i) => (
                              <th
                                key={h}
                                scope="col"
                                className={`px-4 py-3 text-xs font-bold tracking-wider text-aree-muted uppercase ${
                                  i > 1 ? "text-right" : ""
                                }`}
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-aree-border">
                          {policy.policy_files.map((file) => {
                            const { ok, label } = fileStatus(file);
                            return (
                              <tr
                                key={file.name}
                                className="hover:bg-aree-surface-2 transition-colors"
                              >
                                <td className="px-4 py-3 font-mono text-aree-text text-xs break-all">
                                  {file.name}
                                </td>
                                <td className="px-4 py-3 text-aree-muted text-xs font-medium uppercase">
                                  {file.type}
                                </td>
                                <td className="px-4 py-3 text-aree-muted font-mono text-right text-xs">
                                  {file.size_kb} KB
                                </td>
                                <td className="px-4 py-3 text-aree-muted font-mono text-right text-xs">
                                  {modifiedIst(file.modified)}
                                </td>
                                <td
                                  className="px-4 py-3 text-right"
                                  title={file.parse_error ?? undefined}
                                >
                                  <StatusBadge
                                    color={ok ? "var(--aree-green)" : "var(--aree-yellow)"}
                                    variant={ok ? "ghost" : "outline"}
                                  >
                                    {label}
                                  </StatusBadge>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {policy.parse_errors.length > 0 ? (
                  <div className="mt-6 rounded-lg border border-[color-mix(in_srgb,var(--aree-yellow)_40%,transparent)] bg-[color-mix(in_srgb,var(--aree-yellow)_8%,transparent)] p-4">
                    <div className="flex items-center gap-2 text-aree-yellow text-xs font-bold tracking-wider uppercase mb-3">
                      <AlertCircle className="w-4 h-4" />
                      Documents not indexed
                    </div>
                    <div className="space-y-2">
                      {policy.parse_errors.map((e) => (
                        <div key={e.file} className="text-aree-body text-sm flex gap-3">
                          <span className="font-mono text-aree-yellow shrink-0">{e.file}</span>
                          <span>{e.error}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </IntelligencePanel>

            <IntelligencePanel
              title="Add policy document"
              variant="default"
              className="flex flex-col"
            >
              <div className="p-4 sm:p-6 flex-1 flex flex-col">
                <label
                  htmlFor="policy-upload"
                  aria-disabled={!canUpload || undefined}
                  className={`
                    flex flex-col items-center justify-center gap-4 rounded-lg border-2 border-dashed
                    px-6 py-10 text-center transition-all group
                    ${!canUpload
                      ? "border-aree-border opacity-60 cursor-not-allowed"
                      : uploading
                        ? "border-aree-forest/50 bg-aree-forest/5 cursor-pointer"
                        : "border-aree-border hover:border-aree-forest hover:bg-aree-surface-2 cursor-pointer"}
                  `}
                >
                  <div className={`
                    w-14 h-14 rounded-full flex items-center justify-center
                    ${uploading ? "bg-aree-forest/20" : "bg-aree-surface-2 group-hover:bg-aree-forest/10 transition-colors"}
                  `}>
                    <Upload
                      className={`h-6 w-6 ${uploading ? "text-aree-forest animate-pulse" : "text-aree-muted group-hover:text-aree-forest transition-colors"}`}
                      aria-hidden
                    />
                  </div>
                  <div>
                    <div className="text-sm font-bold text-aree-text mb-1">
                      {uploading ? "Uploading…" : "Upload PDF, DOCX or TXT"}
                    </div>
                    <div className="text-xs text-aree-muted">
                      {canUpload
                        ? `Saved to the policy folder · signed in as ${session?.subject}`
                        : "Administrator sign-in required"}
                    </div>
                  </div>
                </label>
                <input
                  ref={inputRef}
                  id="policy-upload"
                  type="file"
                  accept=".txt,.pdf,.docx"
                  disabled={uploading || !canUpload}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleUpload(file);
                  }}
                  className="sr-only"
                />

                {!canUpload ? (
                  <AdminSignIn
                    signedInAs={session ? `${session.subject} (${session.role})` : null}
                  />
                ) : null}

                {result ? (
                  <div
                    role="status"
                    className="mt-6 rounded-lg border border-[color-mix(in_srgb,var(--aree-green)_40%,transparent)] bg-[color-mix(in_srgb,var(--aree-green)_8%,transparent)] p-4"
                  >
                    <div className="text-[var(--aree-green)] flex items-center gap-2 text-sm font-bold mb-2">
                      <CheckCircle2 className="h-4 w-4" aria-hidden />
                      {/* The backend's own account of what happened. In direct mode nothing
                          is embedded, so a fixed "indexed in real time" was a false claim. */}
                      {result.message || "Document uploaded"}
                    </div>
                    {result.replaced ? (
                      <div className="text-[var(--aree-green)] text-xs font-semibold mb-1">
                        An existing file with this name was replaced.
                      </div>
                    ) : null}
                    <div className="text-[var(--aree-green)] text-xs space-y-1">
                      <div>{result.uploaded} ({(result.size_bytes / 1024).toFixed(1)} KB) &rarr; {result.saved_to}</div>
                      <div>{result.files_on_disk ?? result.docs_indexed} policy files on disk</div>
                    </div>
                  </div>
                ) : null}

                {uploadError ? (
                  <div
                    role="alert"
                    className="mt-6 rounded-lg border border-[color-mix(in_srgb,var(--aree-red)_40%,transparent)] bg-[color-mix(in_srgb,var(--aree-red)_8%,transparent)] p-4 text-aree-red text-xs font-medium"
                  >
                    {uploadError}
                  </div>
                ) : null}

                <div className="mt-auto pt-8">
                  <div className="border-t border-aree-border pt-6">
                    <div className="text-[10px] font-bold tracking-wider text-aree-dim uppercase mb-4">Latest Document</div>
                    {latest ? (
                      <div className="bg-aree-surface-2 rounded-lg p-4 border border-aree-border">
                        <div className="text-aree-text font-mono text-sm font-bold break-all mb-2">
                          {latest.name}
                        </div>
                        <div className="text-aree-muted text-xs flex items-center gap-2 mb-3">
                          <span>{latest.type.toUpperCase()}</span>
                          <span>&bull;</span>
                          <span className="font-mono">{latest.size_kb} KB</span>
                          <span>&bull;</span>
                          <span className="font-mono">{modifiedIst(latest.modified)}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <StatusBadge
                            color={fileStatus(latest).ok ? "var(--aree-green)" : "var(--aree-yellow)"}
                            variant="outline"
                          >
                            {fileStatus(latest).label}
                          </StatusBadge>
                        </div>
                      </div>
                    ) : (
                      <div className="text-aree-dim text-sm bg-aree-surface-2 rounded-lg p-4 text-center border border-aree-border border-dashed">
                        No document uploaded yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </IntelligencePanel>
          </div>
        );
      }}
    </SectionState>
  );
}
