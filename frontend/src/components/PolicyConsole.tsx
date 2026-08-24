"use client";

/**
 * Policy intelligence workspace.
 *
 * Upload posts multipart/form-data to FastAPI, which writes into the engine's
 * policies/ directory. All parsing, chunking and embedding stays in Python —
 * this surface only shows the index state and what happened to each document.
 */

import { CheckCircle2, FileUp, Library, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { usePolling } from "@/hooks/usePolling";
import { api, errorMessage } from "@/lib/api";
import { orDash } from "@/lib/theme";
import type { PolicyResponse, PolicyUploadResponse } from "@/types";
import { Panel, Pill, Stat } from "./ui/Card";
import { EmptyState, ErrorState, SectionState } from "./ui/States";

export default function PolicyConsole() {
  const state = usePolling<PolicyResponse>((signal) => api.policy(signal), {
    intervalMs: 15000,
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<PolicyUploadResponse | null>(null);
  const [uploadError, setUploadError] = useState<Error | null>(null);

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    setResult(null);
    try {
      const response = await api.uploadPolicy(file);
      setResult(response);
      state.refresh();
    } catch (err) {
      setUploadError(err instanceof Error ? err : new Error(errorMessage(err)));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <SectionState state={state} skeletonRows={4} loadingLabel="Loading policy index…">
      {(policy) => {
        const storeStatus = policy.store_status ?? "starting";
        const statusColor =
          storeStatus === "active"
            ? "var(--aree-green)"
            : storeStatus === "starting"
              ? "var(--aree-yellow)"
              : "var(--aree-red)";
        // "Latest" means most recently modified, not first in the scan order.
        const latest =
          policy.policy_files.length > 0
            ? policy.policy_files.reduce((newest, file) =>
                file.modified > newest.modified ? file : newest,
              )
            : null;

        return (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(300px,1fr)]">
            <Panel
              title="Policy index"
              icon={<Library className="h-3.5 w-3.5" />}
              accent="var(--aree-blue)"
              padding="p-5"
              right={
                <Pill color={statusColor} filled={storeStatus === "active"}>
                  {storeStatus}
                </Pill>
              }
            >
              <div className="grid gap-6 sm:grid-cols-4">
                <Stat label="Documents" value={policy.docs_indexed} color="var(--aree-accent)" />
                <Stat label="Chunks" value={policy.chunks_indexed} />
                <Stat
                  label="Index type"
                  value={orDash(policy.index_type, "Initializing")}
                  mono={false}
                  size="sm"
                />
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

              <div className="mt-5">
                {policy.policy_files.length === 0 ? (
                  <EmptyState>
                    No policy documents found in the policies/ folder. Upload one to ground
                    advisories in your own regulation.
                  </EmptyState>
                ) : (
                  <div className="border-aree-border overflow-x-auto rounded-lg border">
                    <table className="w-full border-collapse text-left">
                      <caption className="sr-only">Indexed policy documents</caption>
                      <thead>
                        <tr className="border-aree-border bg-aree-bg-soft/50 border-b">
                          {["Filename", "Type", "Size", "Modified", "Parsed"].map((h, i) => (
                            <th
                              key={h}
                              scope="col"
                              className={`aree-eyebrow px-3 py-2 text-[9.5px] ${
                                i > 1 ? "text-right" : ""
                              }`}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {policy.policy_files.map((file) => {
                          const ok = file.supported && !file.parse_error;
                          return (
                            <tr
                              key={file.name}
                              className="border-aree-border/60 border-b last:border-b-0"
                            >
                              <td className="text-aree-body px-3 py-2 font-mono text-[12px] break-all">
                                {file.name}
                              </td>
                              <td className="text-aree-muted px-3 py-2 text-[12px] uppercase">
                                {file.type}
                              </td>
                              <td className="text-aree-muted aree-num px-3 py-2 text-right text-[12px]">
                                {file.size_kb} KB
                              </td>
                              <td className="text-aree-muted aree-num px-3 py-2 text-right text-[12px]">
                                {file.modified}
                              </td>
                              <td
                                className="px-3 py-2 text-right text-[12px] font-semibold"
                                style={{
                                  color: ok ? "var(--aree-green)" : "var(--aree-yellow)",
                                }}
                                title={file.parse_error ?? undefined}
                              >
                                {ok ? "✔ indexed" : file.supported ? "error" : "unsupported"}
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
                <div
                  className="mt-3 rounded-lg border px-4 py-3"
                  style={{
                    borderColor: "color-mix(in srgb, #eab308 45%, transparent)",
                    background: "color-mix(in srgb, #eab308 6%, transparent)",
                  }}
                >
                  <div className="text-aree-yellow text-[11px] font-bold tracking-[0.1em] uppercase">
                    ◐ Documents not indexed
                  </div>
                  {policy.parse_errors.map((e) => (
                    <div key={e.file} className="text-aree-body mt-1 text-[12px]">
                      <span className="font-mono">{e.file}</span> — {e.error}
                    </div>
                  ))}
                </div>
              ) : null}

              {policy.error ? (
                <div className="mt-3 rounded-lg border border-[#7f1d1d] bg-[rgba(239,68,68,0.06)] px-4 py-3">
                  <span className="text-aree-red text-[12px] font-bold">RAG engine note</span>
                  <span className="text-aree-body ml-2 text-[12px]">{policy.error}</span>
                </div>
              ) : null}
            </Panel>

            <Panel
              title="Add policy document"
              icon={<FileUp className="h-3.5 w-3.5" />}
              accent="var(--aree-teal)"
              padding="p-5"
            >
              <label
                htmlFor="policy-upload"
                className="border-aree-border-strong hover:border-aree-accent flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-7 text-center transition-colors"
              >
                <Upload
                  className={`text-aree-accent h-5 w-5 ${uploading ? "animate-pulse" : ""}`}
                  aria-hidden
                />
                <span className="text-aree-body text-[13px] font-semibold">
                  {uploading ? "Uploading and indexing…" : "Upload PDF, DOCX or TXT"}
                </span>
                <span className="text-aree-dim text-[11px]">
                  Parsed, chunked and embedded by the Python RAG pipeline on arrival.
                </span>
              </label>
              <input
                ref={inputRef}
                id="policy-upload"
                type="file"
                accept=".txt,.pdf,.docx"
                disabled={uploading}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleUpload(file);
                }}
                className="sr-only"
              />

              {result ? (
                <div className="mt-4 rounded-lg border border-[#166534] bg-[rgba(34,197,94,0.06)] px-4 py-3">
                  <div className="text-aree-green flex items-center gap-2 text-[12.5px] font-bold">
                    <CheckCircle2 className="h-4 w-4" aria-hidden />
                    Document ingested and indexed in real time
                  </div>
                  <div className="text-aree-muted mt-1 text-[11px]">
                    {result.uploaded} ({(result.size_bytes / 1024).toFixed(1)} KB) → {result.saved_to}
                    {" · "}
                    {result.docs_indexed} documents indexed
                  </div>
                </div>
              ) : null}

              {uploadError ? (
                <div className="mt-4">
                  <ErrorState error={uploadError} compact />
                </div>
              ) : null}

              <div className="border-aree-border mt-5 border-t pt-4">
                <div className="aree-eyebrow mb-2">Latest document</div>
                {latest ? (
                  <>
                    <div className="text-aree-body font-mono text-[12px] break-all">
                      {latest.name}
                    </div>
                    <div className="text-aree-dim mt-1 text-[11px]">
                      {latest.type.toUpperCase()} · {latest.size_kb} KB · {latest.modified}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Pill
                        color={
                          latest.supported ? "var(--aree-green)" : "var(--aree-yellow)"
                        }
                      >
                        {latest.supported ? "● parsed" : "◐ unsupported"}
                      </Pill>
                      <Pill
                        color={
                          latest.parse_error ? "var(--aree-yellow)" : "var(--aree-green)"
                        }
                      >
                        {latest.parse_error ? "◐ not indexed" : "● indexed"}
                      </Pill>
                    </div>
                  </>
                ) : (
                  <div className="text-aree-muted text-[12px]">No document uploaded yet.</div>
                )}
              </div>

              <p className="text-aree-dim mt-4 text-[11px] leading-relaxed">
                Retrieval runs automatically for every station advisory — the retrieved
                document and its similarity score appear under Policy retrieval provenance.
              </p>
            </Panel>
          </div>
        );
      }}
    </SectionState>
  );
}
