import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Toaster, toast } from "sonner";
import {
  startReportJob, startReportFromFile, getAllJobs, deleteJob,
  type ReportJob, type ReportReason,
} from "./lib/api";
import { JobCard }       from "./components/JobCard";
import { ReportForm }    from "./components/ReportForm";
import { StatusChecker } from "./components/StatusChecker";

type MainTab = "manual" | "file" | "status";

export default function App() {
  const qc = useQueryClient();
  const [mainTab,   setMainTab]   = useState<MainTab>("manual");
  const [inputMode, setInputMode] = useState<"manual" | "file">("manual");

  const { data: jobs = [] } = useQuery({
    queryKey: ["jobs"],
    queryFn:  getAllJobs,
    refetchInterval: 3000,
  });

  const reportMutation = useMutation({
    mutationFn: async (payload: { cookies: string; profileUrls: string[]; reason: ReportReason; continuous: boolean }) =>
      startReportJob(payload),
    onSuccess: ({ jobId, total }, vars) => {
      const mode = vars.continuous ? "liên tục" : "một lần";
      toast.success(`Đã bắt đầu report ${total} tài khoản (${mode})`, { description: `Job ID: ${jobId}` });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err: Error) => toast.error("Lỗi", { description: err.message }),
  });

  const fileMutation = useMutation({
    mutationFn: async (payload: { cookies: string; reason: ReportReason; file: File; continuous: boolean }) =>
      startReportFromFile(payload.cookies, payload.reason, payload.file, payload.continuous),
    onSuccess: ({ jobId, total }, vars) => {
      const mode = vars.continuous ? "liên tục" : "một lần";
      toast.success(`Đã bắt đầu report ${total} tài khoản từ file (${mode})`, { description: `Job ID: ${jobId}` });
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (err: Error) => toast.error("Lỗi upload file", { description: err.message }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteJob,
    onSuccess:  () => qc.invalidateQueries({ queryKey: ["jobs"] }),
  });

  const running  = jobs.filter(j => j.status === "running");
  const finished = jobs.filter(j => j.status !== "running");

  const mainTabs: { key: MainTab; label: string; icon: React.ReactNode }[] = [
    {
      key: "manual",
      label: "Report",
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
      ),
    },
    {
      key: "status",
      label: "Kiểm tra trạng thái",
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-gray-50">
      <Toaster position="top-right" richColors />

      {/* Header */}
      <header className="bg-blue-700 text-white shadow-md">
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="w-9 h-9 bg-white rounded-full flex items-center justify-center shrink-0">
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-blue-700">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold">FB Fake Account Reporter</h1>
            <p className="text-blue-200 text-xs">Tự động report tài khoản giả mạo trên Facebook</p>
          </div>
          {running.length > 0 && (
            <div className="ml-auto flex items-center gap-2 bg-blue-600 rounded-full px-3 py-1">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-xs font-medium">{running.length} job đang chạy</span>
            </div>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Main tab bar */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="flex border-b border-gray-200">
            {mainTabs.map(tab => (
              <button
                key={tab.key}
                onClick={() => setMainTab(tab.key)}
                className={`flex-1 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2
                  ${mainTab === tab.key ? "bg-blue-50 text-blue-700 border-b-2 border-blue-700" : "text-gray-500 hover:text-gray-700"}`}
              >
                {tab.icon}{tab.label}
              </button>
            ))}
          </div>

          {/* Report tab */}
          {mainTab === "manual" && (
            <div>
              {/* Input mode sub-tabs */}
              <div className="flex border-b border-gray-100 bg-gray-50">
                {(["manual", "file"] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => setInputMode(m)}
                    className={`px-6 py-2 text-xs font-medium transition-colors ${
                      inputMode === m ? "text-blue-700 border-b-2 border-blue-600 bg-white" : "text-gray-400 hover:text-gray-600"
                    }`}
                  >
                    {m === "manual" ? "Nhập tay / Danh sách URL" : "Upload file (.txt / .csv)"}
                  </button>
                ))}
              </div>
              <div className="p-6">
                <ReportForm
                  mode={inputMode}
                  loading={reportMutation.isPending || fileMutation.isPending}
                  onSubmitManual={(cookies, profileUrls, reason, continuous) =>
                    reportMutation.mutate({ cookies, profileUrls, reason, continuous })
                  }
                  onSubmitFile={(cookies, reason, file, continuous) =>
                    fileMutation.mutate({ cookies, reason, file, continuous })
                  }
                />
              </div>
            </div>
          )}

          {/* Status checker tab */}
          {mainTab === "status" && (
            <div className="p-6">
              <StatusChecker />
            </div>
          )}
        </div>

        {/* Running jobs */}
        {running.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
              Đang chạy ({running.length})
            </h2>
            <div className="space-y-3">
              {running.map(job => (
                <JobCard key={job.jobId} job={job} onDelete={id => deleteMutation.mutate(id)} />
              ))}
            </div>
          </section>
        )}

        {/* Finished jobs */}
        {finished.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3">
              Hoàn thành / Đã dừng ({finished.length})
            </h2>
            <div className="space-y-3">
              {finished.map(job => (
                <JobCard key={job.jobId} job={job} onDelete={id => deleteMutation.mutate(id)} />
              ))}
            </div>
          </section>
        )}

        {jobs.length === 0 && mainTab === "manual" && (
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
