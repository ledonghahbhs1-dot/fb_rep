import { Router, type IRouter } from "express";
import multer from "multer";
import { ReportEngine } from "../reporter.js";

const router: IRouter = Router();
const upload = multer({ storage: multer.memoryStorage() });
const engine = new ReportEngine();

router.post("/report", async (req, res) => {
  const { cookies, profileUrls, reason } = req.body as {
    cookies?: string;
    profileUrls?: string[];
    reason?: string;
  };

  if (!cookies || typeof cookies !== "string" || !cookies.trim()) {
    res.status(400).json({ error: "cookies field is required" });
    return;
  }
  if (!Array.isArray(profileUrls) || profileUrls.length === 0) {
    res.status(400).json({ error: "profileUrls must be a non-empty array" });
    return;
  }
  const validUrls = profileUrls.filter((u) => typeof u === "string" && u.startsWith("http"));
  if (validUrls.length === 0) {
    res.status(400).json({ error: "No valid URLs in profileUrls" });
    return;
  }
  const validReason = (["fake", "impersonating", "spam", "pretending"] as const).includes(reason as any)
    ? (reason as "fake" | "impersonating" | "spam" | "pretending")
    : "fake";

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  engine.startJob(jobId, { cookies: cookies.trim(), profileUrls: validUrls, reason: validReason });
  res.json({ jobId, message: "Report job started", total: validUrls.length });
});

router.post("/report/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }
  const cookies = req.body.cookies as string;
  if (!cookies?.trim()) {
    res.status(400).json({ error: "cookies field is required" });
    return;
  }
  const reason = (req.body.reason as string) || "fake";
  const content = req.file.buffer.toString("utf-8");
  const profileUrls = content
    .split(/[\r\n,;]+/)
    .map((u) => u.trim())
    .filter((u) => u.startsWith("http"));

  if (profileUrls.length === 0) {
    res.status(400).json({ error: "No valid URLs found in uploaded file" });
    return;
  }

  const validReason = (["fake", "impersonating", "spam", "pretending"] as const).includes(reason as any)
    ? (reason as "fake" | "impersonating" | "spam" | "pretending")
    : "fake";

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  engine.startJob(jobId, { cookies: cookies.trim(), profileUrls, reason: validReason });
  res.json({ jobId, message: "Report job started from file", total: profileUrls.length });
});

router.get("/report/:jobId", (req, res) => {
  const job = engine.getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

router.get("/jobs", (_req, res) => {
  res.json(engine.getAllJobs());
});

router.delete("/jobs/:jobId", (req, res) => {
  engine.removeJob(req.params.jobId);
  res.json({ message: "Job removed" });
});

export default router;
