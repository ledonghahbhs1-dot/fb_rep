export const API_BASE = "/api";

export type ReportReason  = "fake" | "impersonating" | "spam" | "pretending";
export type AccountStatus = "active" | "removed" | "restricted" | "unknown";

export interface FormResult {
  formId:  string;
  label:   string;
  success: boolean;
  message: string;
}

export interface ReportResult {
  url:             string;
  status:          "pending" | "success" | "failed" | "skipped";
  message?:        string;
  timestamp?:      string;
  formResults?:    FormResult[];
  formsSubmitted?: number;
  formsFailed?:    number;
}

export interface ReportJob {
  jobId:         string;
  status:        "running" | "completed" | "failed" | "stopped";
  total:         number;
  done:          number;
  reportedCount: number;
  failedCount:   number;
  results:       ReportResult[];
  startedAt:     string;
  finishedAt?:   string;
  error?:        string;
  // continuous mode
  continuous?:      boolean;
  round?:           number;
  totalRounds?:     number;
  totalReported?:   number;
  totalFailed?:     number;
}

export interface StatusCheckResult {
  url:       string;
  status:    AccountStatus;
  message:   string;
  timestamp: string;
}

export interface StatusCheckJob {
  jobId:      string;
  status:     "running" | "completed" | "failed";
  total:      number;
  done:       number;
  results:    StatusCheckResult[];
  startedAt:  string;
  finishedAt?: string;
  error?:     string;
}

// ─── Report APIs ──────────────────────────────────────────────────────────────
export async function startReportJob(payload: {
  cookies: string; profileUrls: string[]; reason: ReportReason; continuous?: boolean;
}): Promise<{ jobId: string; total: number }> {
  const res = await fetch(`${API_BASE}/report`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) { const err = await res.json().catch(() => ({ error: "Request failed" })); throw new Error(err.error ?? "Failed to start job"); }
  return res.json();
}

export async function startReportFromFile(cookies: string, reason: ReportReason, file: File, continuous = false): Promise<{ jobId: string; total: number }> {
  const form = new FormData();
  form.append("cookies", cookies);
  form.append("reason", reason);
  form.append("file", file);
  form.append("continuous", String(continuous));
  const res = await fetch(`${API_BASE}/report/upload`, { method: "POST", body: form });
  if (!res.ok) { const err = await res.json().catch(() => ({ error: "Upload failed" })); throw new Error(err.error ?? "Failed to upload file"); }
  return res.json();
}

export async function stopJob(jobId: string): Promise<void> {
  await fetch(`${API_BASE}/report/${jobId}/stop`, { method: "POST" });
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

// ─── Status Check APIs ────────────────────────────────────────────────────────
export async function startStatusCheck(payload: { cookies?: string; profileUrls: string[] }): Promise<{ jobId: string; total: number }> {
  const res = await fetch(`${API_BASE}/check-status`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) { const err = await res.json().catch(() => ({ error: "Request failed" })); throw new Error(err.error ?? "Failed to start check"); }
  return res.json();
}

export async function getStatusCheckJob(jobId: string): Promise<StatusCheckJob> {
  const res = await fetch(`${API_BASE}/check-status/${jobId}`);
  if (!res.ok) throw new Error("Check job not found");
  return res.json();
}

export async function getAllStatusCheckJobs(): Promise<StatusCheckJob[]> {
  const res = await fetch(`${API_BASE}/check-status/jobs`);
  if (!res.ok) throw new Error("Failed to fetch check jobs");
  return res.json();
}

export async function deleteStatusCheckJob(jobId: string): Promise<void> {
  await fetch(`${API_BASE}/check-status/${jobId}`, { method: "DELETE" });
}
