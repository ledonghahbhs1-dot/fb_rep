export const API_BASE = "/api";

export type ReportReason = "fake" | "impersonating" | "spam" | "pretending";

export interface ReportResult {
  url: string;
  status: "pending" | "success" | "failed" | "skipped";
  message?: string;
  timestamp?: string;
}

export interface ReportJob {
  jobId: string;
  status: "running" | "completed" | "failed";
  total: number;
  done: number;
  reportedCount: number;
  failedCount: number;
  results: ReportResult[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export async function startReportJob(payload: {
  cookies: string;
  profileUrls: string[];
  reason: ReportReason;
}): Promise<{ jobId: string; total: number }> {
  const res = await fetch(`${API_BASE}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(err.error ?? "Failed to start job");
  }
  return res.json();
}

export async function startReportFromFile(
  cookies: string,
  reason: ReportReason,
  file: File
): Promise<{ jobId: string; total: number }> {
  const form = new FormData();
  form.append("cookies", cookies);
  form.append("reason", reason);
  form.append("file", file);
  const res = await fetch(`${API_BASE}/report/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(err.error ?? "Failed to upload file");
  }
  return res.json();
}

export async function getJob(jobId: string): Promise<ReportJob> {
  const res = await fetch(`${API_BASE}/report/${jobId}`);
  if (!res.ok) throw new Error("Job not found");
  return res.json();
}

export async function getAllJobs(): Promise<ReportJob[]> {
  const res = await fetch(`${API_BASE}/jobs`);
  if (!res.ok) throw new Error("Failed to fetch jobs");
  return res.json();
}

export async function deleteJob(jobId: string): Promise<void> {
  await fetch(`${API_BASE}/jobs/${jobId}`, { method: "DELETE" });
}
