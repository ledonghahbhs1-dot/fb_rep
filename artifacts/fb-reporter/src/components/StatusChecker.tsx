import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  startStatusCheck, getStatusCheckJob, getAllStatusCheckJobs, deleteStatusCheckJob,
  type StatusCheckJob, type AccountStatus,
} from "../lib/api";

const STATUS_META: Record<AccountStatus, { label: string; color: string; dot: string }> = {
  active:     { label: "Còn hoạt động",       color: "bg-green-100 text-green-700",  dot: "bg-green-500" },
  removed:    { label: "Đã bị xóa/vô hiệu",   color: "bg-red-100 text-red-700",     dot: "bg-red-500" },
  restricted: { label: "Bị hạn chế",           color: "bg-yellow-100 text-yellow-700", dot: "bg-yellow-500" },
  unknown:    { label: "Không xác định",        color: "bg-gray-100 text-gray-500",  dot: "bg-gray-400" },
};

function StatusCheckJobCard({ job: initial, onDelete }: { job: StatusCheckJob; onDelete: () => void }) {
  const { data: job = initial } = useQuery({
    queryKey:       ["chk-job", initial.jobId],
    queryFn:        () => getStatusCheckJob(initial.jobId),
    refetchInterval: initial.status === "running" ? 2000 : false,
    initialData:    initial,
  });

  const progress = job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;
  const active     = job.results.filter(r => r.status === "active").length;
  const removed    = job.results.filter(r => r.status === "removed").length;
  const restricted = job.results.filter(r => r.status === "restricted").length;
  const unknown    = job.results.filter(r => r.status === "unknown").length;

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
      <div className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                job.status === "running"   ? "bg-blue-100 text-blue-700" :
                job.status === "completed" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
              }`}>
                {job.status === "running" ? `Đang kiểm tra ${job.done}/${job.total}...` :
                 job.status === "completed" ? "Hoàn thành" : "Lỗi"}
              </span>
              <span className="text-xs text-gray-400 font-mono">{job.jobId}</span>
            </div>
            <p className="text-xs text-gray-400 mt-1">{new Date(job.startedAt).toLocaleString("vi-VN")}</p>
          </div>
          {job.status !== "running" && (
            <button onClick={onDelete} className="text-xs text-red-500 hover:underline shrink-0">Xóa</button>
          )}
        </div>

        {/* Progress */}
        <div className="mt-3">
          <div className="w-full bg-gray-100 rounded-full h-2">
            <div className="h-2 rounded-full bg-blue-500 transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
        </div>

        {/* Summary */}
        <div className="flex gap-3 mt-2 text-xs flex-wrap">
          {active     > 0 && <span className="flex items-center gap-1 text-green-700"><span className="w-2 h-2 rounded-full bg-green-500 inline-block" />{active} còn hoạt động</span>}
          {removed    > 0 && <span className="flex items-center gap-1 text-red-600"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" />{removed} đã bị xóa</span>}
          {restricted > 0 && <span className="flex items-center gap-1 text-yellow-600"><span className="w-2 h-2 rounded-full bg-yellow-500 inline-block" />{restricted} bị hạn chế</span>}
          {unknown    > 0 && <span className="flex items-center gap-1 text-gray-500"><span className="w-2 h-2 rounded-full bg-gray-400 inline-block" />{unknown} không rõ</span>}
        </div>

        {job.error && <div className="mt-2 text-xs text-red-600 bg-red-50 rounded p-2">{job.error}</div>}
      </div>

      {/* Results table */}
      {job.results.length > 0 && (
        <div className="border-t border-gray-100 max-h-72 overflow-y-auto">
          {job.results.map((r, i) => {
            const meta = STATUS_META[r.status];
            return (
              <div key={i} className="px-4 py-2 flex items-center gap-3 text-xs border-b border-gray-50 last:border-0 hover:bg-gray-50">
                <span className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} />
                <p className="font-mono text-gray-700 truncate flex-1">{r.url}</p>
                <span className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-medium ${meta.color}`}>
                  {meta.label}
                </span>
                {r.message && r.status !== "unknown" && (
                  <p className="text-gray-400 truncate max-w-[160px]" title={r.message}>{r.message}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function StatusChecker() {
  const qc = useQueryClient();
  const [urlsText,    setUrlsText]    = useState("");
  const [cookies,     setCookies]     = useState("");
  const [showCookies, setShowCookies] = useState(false);

  const { data: jobs = [] } = useQuery({
    queryKey:        ["chk-jobs"],
    queryFn:         getAllStatusCheckJobs,
    refetchInterval: 4000,
  });

  const checkMutation = useMutation({
    mutationFn: startStatusCheck,
    onSuccess: ({ total }) => {
      toast.success(`Đang kiểm tra ${total} tài khoản`);
      qc.invalidateQueries({ queryKey: ["chk-jobs"] });
      setUrlsText("");
    },
    onError: (err: Error) => toast.error("Lỗi", { description: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteStatusCheckJob,
    onSuccess:  () => qc.invalidateQueries({ queryKey: ["chk-jobs"] }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const profileUrls = urlsText.split(/[\n,;]+/).map(u => u.trim()).filter(u => u.startsWith("http"));
    if (profileUrls.length === 0) return alert("Vui lòng nhập ít nhất 1 URL hợp lệ");
    checkMutation.mutate({ cookies: cookies.trim() || undefined, profileUrls });
  };

  const urlCount = urlsText.split(/[\n,;]+/).filter(u => u.trim().startsWith("http")).length;

  return (
    <div className="space-y-6">
      {/* Form */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex items-center gap-2 mb-5">
          <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-gray-800">Kiểm tra trạng thái tài khoản</h3>
            <p className="text-xs text-gray-500">Xem tài khoản đã báo cáo có bị xóa/hạn chế chưa</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Optional cookies */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Facebook Cookies <span className="text-xs text-gray-400">(không bắt buộc, nhưng chính xác hơn)</span>
            </label>
            <div className="relative">
              <textarea
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 pr-20"
                rows={2}
                placeholder="Dán cookie Facebook để kiểm tra chính xác hơn..."
                value={showCookies ? cookies : cookies ? "•".repeat(Math.min(cookies.length, 60)) : ""}
                onChange={e => { if (showCookies) setCookies(e.target.value); }}
                onFocus={() => setShowCookies(true)}
                onBlur={() => setShowCookies(false)}
              />
              <button type="button" className="absolute right-2 top-2 text-xs text-blue-600 hover:underline"
                onClick={() => setShowCookies(v => !v)}>
                {showCookies ? "Ẩn" : "Hiện"}
              </button>
            </div>
          </div>

          {/* URLs */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              URL tài khoản cần kiểm tra <span className="text-red-500">*</span>
            </label>
            <textarea
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
              rows={6}
              placeholder={"https://www.facebook.com/username\nhttps://www.facebook.com/profile.php?id=..."}
              value={urlsText} onChange={e => setUrlsText(e.target.value)} required
            />
            <div className="flex justify-between mt-1">
              <p className="text-xs text-gray-400">Mỗi URL một dòng</p>
              {urlCount > 0 && <p className="text-xs text-blue-600 font-medium">{urlCount} URL</p>}
            </div>
          </div>

          <button
            type="submit" disabled={checkMutation.isPending}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
          >
            {checkMutation.isPending && (
              <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {checkMutation.isPending ? "Đang khởi động..." : "Kiểm tra trạng thái"}
          </button>
        </form>
      </div>

      {/* Check jobs */}
      {jobs.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider">
            Kết quả kiểm tra ({jobs.length})
          </h2>
          {jobs.map(job => (
            <StatusCheckJobCard
              key={job.jobId} job={job}
              onDelete={() => deleteMutation.mutate(job.jobId)}
            />
          ))}
        </section>
      )}

      {jobs.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          <svg className="w-10 h-10 mx-auto mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm">Chưa có kết quả kiểm tra nào.</p>
        </div>
      )}
    </div>
  );
}
