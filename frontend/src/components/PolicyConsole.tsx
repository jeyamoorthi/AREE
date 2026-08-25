"use client";

/**
 * Policy intelligence workspace.
 */

import { CheckCircle2, Upload, AlertCircle } from "lucide-react";
import { useRef, useState } from "react";

import { usePolling } from "@/hooks/usePolling";
import { api, errorMessage } from "@/lib/api";
import { orDash } from "@/lib/theme";
import type { PolicyResponse, PolicyUploadResponse } from "@/types";
import { IntelligencePanel, StatusBadge, Stat } from "./ui/Card";
import { EmptyState, SectionState } from "./ui/States";

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
        const isStoreActive = storeStatus === "active";
        
        let statusColor = "#ca8a04";
        let statusVariant: "solid" | "outline" | "ghost" = "outline";
        
        if (isStoreActive) {
          statusColor = "#16a34a";
          statusVariant = "solid";
        } else if (storeStatus !== "starting") {
          statusColor = "#dc2626";
        }
        
        const latest =
          policy.policy_files.length > 0
            ? policy.policy_files.reduce((newest, file) =>
                file.modified > newest.modified ? file : newest,
              )
            : null;

        return (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)]">
            <IntelligencePanel
              title="Policy index"
              variant="default"
              headerAction={
                <StatusBadge color={statusColor} variant={statusVariant}>
                  {storeStatus}
                </StatusBadge>
              }
            >
              <div className="p-6">
                <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4 mb-8">
                  <div className="bg-[#faf9f4] p-4 rounded-lg border border-[#e4e0d4]">
                    <Stat label="Documents" value={policy.docs_indexed} color="#16a34a" />
                  </div>
                  <div className="bg-[#faf9f4] p-4 rounded-lg border border-[#e4e0d4]">
                    <Stat label="Chunks" value={policy.chunks_indexed} />
                  </div>
                  <div className="bg-[#faf9f4] p-4 rounded-lg border border-[#e4e0d4]">
                    <Stat
                      label="Index type"
                      value={orDash(policy.index_type, "Initializing")}
                      mono={false}
                      size="sm"
                    />
                  </div>
                  <div className="bg-[#faf9f4] p-4 rounded-lg border border-[#e4e0d4]">
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
                  <h4 className="text-sm font-bold text-[#17231c] mb-4">Indexed Documents</h4>
                  {policy.policy_files.length === 0 ? (
                    <EmptyState>
                      No policy documents found in the policies/ folder.
                    </EmptyState>
                  ) : (
                    <div className="border border-[#e4e0d4] bg-white overflow-x-auto rounded-lg">
                      <table className="w-full border-collapse text-left text-sm">
                        <thead>
                          <tr className="border-b border-[#e4e0d4] bg-[#faf9f4]">
                            {["Filename", "Type", "Size", "Modified", "Status"].map((h, i) => (
                              <th
                                key={h}
                                scope="col"
                                className={`px-4 py-3 text-xs font-bold tracking-wider text-[#64748b] uppercase ${
                                  i > 1 ? "text-right" : ""
                                }`}
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#e4e0d4]">
                          {policy.policy_files.map((file) => {
                            const ok = file.supported && !file.parse_error;
                            return (
                              <tr
                                key={file.name}
                                className="hover:bg-[#faf9f4] transition-colors"
                              >
                                <td className="px-4 py-3 font-mono text-[#17231c] text-xs break-all">
                                  {file.name}
                                </td>
                                <td className="px-4 py-3 text-[#64748b] text-xs font-medium uppercase">
                                  {file.type}
                                </td>
                                <td className="px-4 py-3 text-[#64748b] font-mono text-right text-xs">
                                  {file.size_kb} KB
                                </td>
                                <td className="px-4 py-3 text-[#64748b] font-mono text-right text-xs">
                                  {file.modified}
                                </td>
                                <td
                                  className="px-4 py-3 text-right"
                                  title={file.parse_error ?? undefined}
                                >
                                  <StatusBadge
                                    color={ok ? "#16a34a" : "#ca8a04"}
                                    variant={ok ? "ghost" : "outline"}
                                  >
                                    {ok ? "Indexed" : file.supported ? "Error" : "Unsupported"}
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
                  <div className="mt-6 rounded-lg border border-yellow-200 bg-yellow-50 p-4">
                    <div className="flex items-center gap-2 text-yellow-800 text-xs font-bold tracking-wider uppercase mb-3">
                      <AlertCircle className="w-4 h-4" />
                      Documents not indexed
                    </div>
                    <div className="space-y-2">
                      {policy.parse_errors.map((e) => (
                        <div key={e.file} className="text-yellow-900 text-sm flex gap-3">
                          <span className="font-mono text-yellow-700 shrink-0">{e.file}</span>
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
              <div className="p-6 flex-1 flex flex-col">
                <label
                  htmlFor="policy-upload"
                  className={`
                    flex flex-col items-center justify-center gap-4 rounded-lg border-2 border-dashed
                    px-6 py-10 text-center transition-all cursor-pointer group
                    ${uploading 
                      ? "border-[#143828]/50 bg-[#143828]/5" 
                      : "border-[#e4e0d4] hover:border-[#143828] hover:bg-[#faf9f4]"}
                  `}
                >
                  <div className={`
                    w-14 h-14 rounded-full flex items-center justify-center
                    ${uploading ? "bg-[#143828]/20" : "bg-[#faf9f4] group-hover:bg-[#143828]/10 transition-colors"}
                  `}>
                    <Upload
                      className={`h-6 w-6 ${uploading ? "text-[#143828] animate-pulse" : "text-[#64748b] group-hover:text-[#143828] transition-colors"}`}
                      aria-hidden
                    />
                  </div>
                  <div>
                    <div className="text-sm font-bold text-[#17231c] mb-1">
                      {uploading ? "Uploading and indexing…" : "Upload PDF, DOCX or TXT"}
                    </div>
                    <div className="text-xs text-[#64748b]">
                      Parsed, chunked and embedded by the Python RAG pipeline on arrival.
                    </div>
                  </div>
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
                  <div className="mt-6 rounded-lg border border-[#a7f3d0] bg-[#ecfdf5] p-4">
                    <div className="text-[#065f46] flex items-center gap-2 text-sm font-bold mb-2">
                      <CheckCircle2 className="h-4 w-4" aria-hidden />
                      Document ingested and indexed in real time
                    </div>
                    <div className="text-[#065f46] text-xs space-y-1">
                      <div>{result.uploaded} ({(result.size_bytes / 1024).toFixed(1)} KB) &rarr; {result.saved_to}</div>
                      <div>{result.docs_indexed} documents indexed</div>
                    </div>
                  </div>
                ) : null}

                {uploadError ? (
                  <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-red-700 text-xs font-medium">
                    {uploadError.message}
                  </div>
                ) : null}

                <div className="mt-auto pt-8">
                  <div className="border-t border-[#e4e0d4] pt-6">
                    <div className="text-[10px] font-bold tracking-wider text-[#788796] uppercase mb-4">Latest Document</div>
                    {latest ? (
                      <div className="bg-[#faf9f4] rounded-lg p-4 border border-[#e4e0d4]">
                        <div className="text-[#17231c] font-mono text-sm font-bold break-all mb-2">
                          {latest.name}
                        </div>
                        <div className="text-[#64748b] text-xs flex items-center gap-2 mb-3">
                          <span>{latest.type.toUpperCase()}</span>
                          <span>&bull;</span>
                          <span className="font-mono">{latest.size_kb} KB</span>
                          <span>&bull;</span>
                          <span className="font-mono">{latest.modified}</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <StatusBadge
                            color={latest.supported ? "#16a34a" : "#ca8a04"}
                            variant="outline"
                          >
                            {latest.supported ? "Parsed" : "Unsupported"}
                          </StatusBadge>
                          <StatusBadge
                            color={latest.parse_error ? "#ca8a04" : "#16a34a"}
                            variant="outline"
                          >
                            {latest.parse_error ? "Not indexed" : "Indexed"}
                          </StatusBadge>
                        </div>
                      </div>
                    ) : (
                      <div className="text-[#788796] text-sm bg-[#faf9f4] rounded-lg p-4 text-center border border-[#e4e0d4] border-dashed">
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
