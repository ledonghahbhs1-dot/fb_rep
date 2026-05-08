import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getJob, stopJob, type ReportJob } from "../lib/api";
import { toast } from "sonner";

interface Props {
  job: ReportJob;
  onDelete: (jobId: string) => void;
}

export function JobCard({ job: initialJob, onDelete }: Props) {
  const [expanded,    setExpanded]    = useState(false);
  const [expandedUrl, setExpandedUrl] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data: job = initialJob } = useQuery({
    queryKey: ["job", initialJob.jobId],
    queryFn:  () => getJob(initialJob.jobId),
    refetchInterval: initialJob.status === "running" ? 2000 : false,
    initialData: initialJob,
  });

  const stopMutation = useMutation({
    mutationFn: () => stopJob(job.jobId),
    onSuccess:  () => {
      toast.info("Đã gửi tín hiệu dừng", { description: "Job sẽ dừng sau vòng hiện tại" });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  const progress     = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const successCount = job.reportedCount ?? job.results.filter(r => r.status === "success").length;
  const failedCount  = job.failedCount  ?? job.results.filter(r => r.status === "failed").length;
  const isContinuous = job.continuous ?? false;
  const isRunning    = job.status === "running";

  const statusMeta: Record<string, { label: string; color: string }> = {
    running:   { label: isContinuous ? `Chạy liên tục — Vòng ${job.round ?? 1}` : "Đang chạy",  color: "bg-blue-100 text-blue-700" },
    completed: { label: "Hoàn thành", color: "bg-green-100 text-green-700" },
    failed:    { label: "Lỗi",        color: "bg-red-100 text-red-700" },
    stopped:   { label: "Đã dừng",    color: "bg-gray-100 text-gray-600" },
  };
  const { label: statusLabel, color: statusColor } = statusMeta[job.status] ?? statusMeta.completed;

  return (
    <div className={`bg-white border rounded-xl shadow-sm overflow-hidden ${isContinuous ? "border-orange-300" : "border-gray-200"}`}>
      <div className="p-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${statusColor}`}>
                {statusLabel}
              </span>
              {isContinuous && (
                <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">
                  ∞ Liên tục
                </span>
              )}
              <span className="text-xs text-gray-400 font-mono truncate">{job.jobId}</span>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {new Date(job.startedAt).toLocaleString("vi-VN")}
              {job.finishedAt && ` → ${new Date(job.finishedAt).toLocaleString("vi-VN")}`}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Stop button for continuous running jobs */}
            {isRunning && isContinuous && (
              <button
                onClick={() => stopMutation.mutate()}
                disabled={stopMutation.isPending}
                className="text-xs bg-red-100 text-red-600 hover:bg-red-200 px-2 py-1 rounded font-medium transition-colors disabled:opacity-50"
              >
                {stopMutation.isPending ? "Đang dừng..." : "⏹ Dừng"}
              </button>
            )}
            <button onClick={() => setExpanded(v => !v)} className="text-xs text-blue-600 hover:underline">
              {expanded ? "Thu gọn" : "Chi tiết"}
            </button>
            {!isRunning && (
              <button onClick={() => onDelete(job.jobId)} className="text-xs text-red-500 hover:underline">
                Xóa
              </button>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>{job.done}/{job.total} trong vòng này</span>
            <span>{progress}%</span>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-2">
            <div
              className={`h-2 rounded-full transition-all duration-500 ${
                job.status === "failed"  ? "bg-red-500" :
                job.status === "stopped" ? "bg-gray-400" :
                job.status === "completed" ? "bg-green-500" :
                isContinuous ? "bg-orange-400" : "bg-blue-500"
              }`}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        {/* Stats */}
        <div className="flex gap-4 mt-2 text-xs flex-wrap">
          <span className="text-green-600 font-medium">✓ {successCount} thành công</span>
          <span className="text-red-500 font-medium">✗ {failedCount} thất bại</span>
          <span className="text-gray-400">{job.results.filter(r => r.status === "pending").length} chờ</span>
          {/* Cumulative stats for continuous mode */}
          {isContinuous && (job.totalRounds ?? 0) > 0 && (
            <span className="text-orange-600 font-medium">
              Tổng: {job.totalRounds} vòng · {job.totalReported} báo cáo
            </span>
          )}
        </div>

        {job.error && <div className="mt-2 text-xs text-red-600 bg-red-50 rounded p-2">{job.error}</div>}
      </div>

      {/* Expanded results */}
      {expanded && (
        <div className="border-t border-gray-100 max-h-[500px] overflow-y-auto">
          {job.results.map((r, i) => {
            const isExp    = expandedUrl === r.url;
            const hasForms = r.formResults && r.formResults.length > 0;
            return (
              <div key={i} className={`border-b border-gray-50 last:border-0 ${
                r.status === "success" ? "bg-green-50" : r.status === "failed" ? "bg-red-50" : ""
              }`}>
                <div className="px-4 py-2 flex items-start gap-2 text-xs">
                  <span className={`mt-0.5 shrink-0 ${
                    r.status === "success" ? "text-green-500" : r.status === "failed" ? "text-red-500" :
                    r.status === "pending" ? "text-gray-300" : "text-gray-400"
                  }`}>
                    {r.status === "success" ? "✓" : r.status === "failed" ? "✗" : r.status === "pending" ? "○" : "−"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-mono truncate text-gray-700">{r.url}</p>
                      {hasForms && (
                        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          (r.formsSubmitted ?? 0) > 0 ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"
                        }`}>
                          {r.formsSubmitted ?? 0}/{r.formResults?.length ?? 0} form
                        </span>
                      )}
                      {hasForms && (
                        <button onClick={() => setExpandedUrl(isExp ? null : r.url)}
                          className="shrink-0 text-[10px] text-blue-500 hover:underline">
                          {isExp ? "Ẩn" : "Xem form"}
                        </button>
                      )}
                    </div>
                    {r.message && <p className="text-gray-400 mt-0.5 break-words">{r.message}</p>}
                    {r.timestamp && <p className="text-gray-300 mt-0.5">{new Date(r.timestamp).toLocaleTimeString("vi-VN")}</p>}
                  </div>
                </div>
                {/* Per-form breakdown */}
                {isExp && hasForms && (
                  <div className="px-8 pb-2 space-y-1">
                    {r.formResults!.map((f, fi) => (
                      <div key={fi} className={`flex items-start gap-2 text-[11px] rounded px-2 py-1 ${
                        f.success ? "bg-green-100 text-green-800" : "bg-red-100 text-red-700"
                      }`}>
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
