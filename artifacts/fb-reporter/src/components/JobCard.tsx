import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJob, type ReportJob } from "../lib/api";

interface Props {
  job: ReportJob;
  onDelete: (jobId: string) => void;
}

export function JobCard({ job: initialJob, onDelete }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [expandedUrl, setExpandedUrl] = useState<string | null>(null);

  const { data: job = initialJob } = useQuery({
    queryKey: ["job", initialJob.jobId],
    queryFn: () => getJob(initialJob.jobId),
    refetchInterval: initialJob.status === "running" ? 2000 : false,
    initialData: initialJob,
  });

  const progress     = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const successCount = job.reportedCount ?? job.results.filter((r) => r.status === "success").length;
  const failedCount  = job.failedCount  ?? job.results.filter((r) => r.status === "failed").length;

  const statusColor = {
    running:   "bg-blue-100 text-blue-700",
    completed: "bg-green-100 text-green-700",
    failed:    "bg-red-100 text-red-700",
  }[job.status];

  const statusLabel = {
    running:   "Đang chạy",
    completed: "Hoàn thành",
    failed:    "Lỗi",
  }[job.status];

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColor}`}>
                {statusLabel}
              </span>
              <span className="text-xs text-gray-400 font-mono truncate">{job.jobId}</span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {new Date(job.startedAt).toLocaleString("vi-VN")}
              {job.finishedAt && ` → ${new Date(job.finishedAt).toLocaleString("vi-VN")}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setExpanded((v) => !v)}
              className="text-xs text-blue-600 hover:underline"
            >
              {expanded ? "Thu gọn" : "Chi tiết"}
            </button>
            {job.status !== "running" && (
              <button
                onClick={() => onDelete(job.jobId)}
                className="text-xs text-red-500 hover:underline"
              >
                Xóa
              </button>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{job.done}/{job.total} tài khoản</span>
            <span>{progress}%</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all duration-500 ${
                job.status === "failed"    ? "bg-red-500" :
                job.status === "completed" ? "bg-green-500" : "bg-blue-500"
              }`}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Summary counts */}
        <div className="flex gap-4 mt-2 text-xs flex-wrap">
          <span className="text-green-600 font-medium">✓ {successCount} thành công</span>
          <span className="text-red-500 font-medium">✗ {failedCount} thất bại</span>
          <span className="text-gray-400">{job.results.filter((r) => r.status === "pending").length} chờ</span>
        </div>

        {job.error && (
          <div className="mt-2 text-xs text-red-600 bg-red-50 rounded p-2">{job.error}</div>
        )}
      </div>

      {/* Expanded results */}
      {expanded && (
        <div className="border-t border-gray-100 max-h-[500px] overflow-y-auto">
          {job.results.map((r, i) => {
            const isExpanded = expandedUrl === r.url;
            const hasForms   = r.formResults && r.formResults.length > 0;

            return (
              <div
                key={i}
                className={`border-b border-gray-50 last:border-0 ${
                  r.status === "success" ? "bg-green-50" :
                  r.status === "failed"  ? "bg-red-50"   : ""
                }`}
              >
                {/* URL row */}
                <div className="px-4 py-2 flex items-start gap-2 text-xs">
                  <span className={`mt-0.5 shrink-0 ${
                    r.status === "success" ? "text-green-500" :
                    r.status === "failed"  ? "text-red-500"   :
                    r.status === "pending" ? "text-gray-300"  : "text-gray-400"
                  }`}>
                    {r.status === "success" ? "✓" : r.status === "failed" ? "✗" : r.status === "pending" ? "○" : "−"}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-mono truncate text-gray-700">{r.url}</p>

                      {/* Forms submitted badge */}
                      {hasForms && (
                        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          (r.formsSubmitted ?? 0) > 0
                            ? "bg-green-100 text-green-700"
                            : "bg-red-100 text-red-600"
                        }`}>
                          {r.formsSubmitted ?? 0}/{(r.formResults?.length ?? 0)} form
                        </span>
                      )}

                      {hasForms && (
                        <button
                          onClick={() => setExpandedUrl(isExpanded ? null : r.url)}
                          className="shrink-0 text-[10px] text-blue-500 hover:underline"
                        >
                          {isExpanded ? "Ẩn" : "Xem form"}
                        </button>
                      )}
                    </div>

                    {r.message && (
                      <p className="text-gray-400 mt-0.5 break-words">{r.message}</p>
                    )}

                    {r.timestamp && (
                      <p className="text-gray-300 mt-0.5">
                        {new Date(r.timestamp).toLocaleTimeString("vi-VN")}
                      </p>
                    )}
                  </div>
                </div>

                {/* Per-form breakdown */}
                {isExpanded && hasForms && (
                  <div className="px-8 pb-2 space-y-1">
                    {r.formResults!.map((f, fi) => (
                      <div
                        key={fi}
                        className={`flex items-start gap-2 text-[11px] rounded px-2 py-1 ${
                          f.success ? "bg-green-100 text-green-800" : "bg-red-100 text-red-700"
                        }`}
                      >
                        <span className="shrink-0 font-bold">{f.success ? "✓" : "✗"}</span>
                        <div className="min-w-0">
                          <span className="font-medium">{f.label}</span>
                          <span className="text-[10px] text-gray-500 ml-1">#{f.formId}</span>
                          <p className="text-[10px] opacity-70 break-words">{f.message}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
