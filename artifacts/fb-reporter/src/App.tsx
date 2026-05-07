import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Toaster, toast } from "sonner";
import {
  startReportJob,
  startReportFromFile,
  getAllJobs,
  deleteJob,
  type ReportJob,
  type ReportReason,
} from "./lib/api";
import { JobCard } from "./components/JobCard";
import { ReportForm } from "./components/ReportForm";

export default function App() {
  const qc = useQueryClient();
  const [activeTab, setActiveTab] = useState<"manual" | "file">("manual");

  const { data: jobs = [] } = useQuery({
    queryKey: ["jobs"],
    queryFn: getAllJobs,
    refetchInterval: 3000,
  });

  const reportMutation = useMutation({
    mutationFn: async (payload: {
      cookies: string;
      profileUrls: string[];
      reason: ReportReason;
    }) => startReportJob(payload),
    onSuccess: ({ jobId, total }) => {
      toast.success(`Đã bắt đầu report ${total} tài khoản`, { description: `Job ID: ${jobId}` });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err: Error) => toast.error("Lỗi", { description: err.message }),
  });

  const fileMutation = useMutation({
    mutationFn: async (payload: { cookies: string; reason: ReportReason; file: File }) =>
      startReportFromFile(payload.cookies, payload.reason, payload.file),
    onSuccess: ({ jobId, total }) => {
      toast.success(`Đã bắt đầu report ${total} tài khoản từ file`, { description: `Job ID: ${jobId}` });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err: Error) => toast.error("Lỗi upload file", { description: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteJob,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const running = jobs.filter((j) => j.status === "running");
  const finished = jobs.filter((j) => j.status !== "running");

  return (
    <div className="min-h-screen bg-gray-50">
      <Toaster position="top-right" richColors />

      <header className="bg-blue-700 text-white shadow-md">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="w-9 h-9 bg-white rounded-full flex items-center justify-center">
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-blue-700">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold">FB Fake Account Reporter</h1>
            <p className="text-blue-200 text-xs">Tự động report tài khoản giả mạo trên Facebook</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="flex border-b border-gray-200">
            <button
              className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === "manual" ? "bg-blue-50 text-blue-700 border-b-2 border-blue-700" : "text-gray-500 hover:text-gray-700"}`}
              onClick={() => setActiveTab("manual")}
            >
              Nhập tay / Danh sách URL
            </button>
            <button
              className={`flex-1 py-3 text-sm font-medium transition-colors ${activeTab === "file" ? "bg-blue-50 text-blue-700 border-b-2 border-blue-700" : "text-gray-500 hover:text-gray-700"}`}
              onClick={() => setActiveTab("file")}
            >
              Upload file (.txt / .csv)
            </button>
          </div>

          <div className="p-6">
            <ReportForm
              mode={activeTab}
              loading={reportMutation.isPending || fileMutation.isPending}
              onSubmitManual={(cookies, profileUrls, reason) =>
                reportMutation.mutate({ cookies, profileUrls, reason })
              }
              onSubmitFile={(cookies, reason, file) =>
                fileMutation.mutate({ cookies, reason, file })
              }
            />
          </div>
        </div>

        {running.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
              Đang chạy ({running.length})
            </h2>
            <div className="space-y-3">
              {running.map((job) => (
                <JobCard key={job.jobId} job={job} onDelete={(id) => deleteMutation.mutate(id)} />
              ))}
            </div>
          </section>
        )}

        {finished.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
              Hoàn thành ({finished.length})
            </h2>
            <div className="space-y-3">
              {finished.map((job) => (
                <JobCard key={job.jobId} job={job} onDelete={(id) => deleteMutation.mutate(id)} />
              ))}
            </div>
          </section>
        )}

        {jobs.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <svg className="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <p className="text-sm">Chưa có job nào. Nhập cookies và URL để bắt đầu.</p>
          </div>
        )}
      </main>
    </div>
  );
}
