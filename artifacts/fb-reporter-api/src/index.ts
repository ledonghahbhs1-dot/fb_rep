import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import multer from "multer";
import { pino } from "pino";
import { z } from "zod";
import { ReportEngine, StatusCheckEngine } from "./reporter.js";

const logger = pino({ level: "info" });
const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(pinoHttp({ logger }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const engine      = new ReportEngine();
const checkEngine = new StatusCheckEngine();

// ─── Validation schemas ───────────────────────────────────────────────────────
const ReportRequestSchema = z.object({
  cookies:     z.string().min(1, "Facebook cookies are required"),
  profileUrls: z.array(z.string().url()).min(1, "At least one profile URL is required"),
  reason:      z.enum(["fake", "impersonating", "spam", "pretending"]).default("fake"),
  continuous:  z.boolean().optional().default(false),
});

const CheckStatusSchema = z.object({
  cookies:     z.string().optional(),
  profileUrls: z.array(z.string().url()).min(1, "At least one profile URL is required"),
});

// ─── Report routes ────────────────────────────────────────────────────────────
app.post("/api/report", async (req, res) => {
  const parsed = ReportRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }
  const { cookies, profileUrls, reason, continuous } = parsed.data;
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  engine.startJob(jobId, { cookies, profileUrls, reason, continuous });
  res.json({ jobId, message: "Report job started", total: profileUrls.length, continuous });
});

app.post("/api/report/upload", upload.single("file"), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: "No file uploaded" }); return; }
  const cookies    = req.body.cookies as string;
  const reason     = (req.body.reason as string) || "fake";
  const continuous = req.body.continuous === "true";
  if (!cookies) { res.status(400).json({ error: "cookies field is required" }); return; }

  const content     = req.file.buffer.toString("utf-8");
  const profileUrls = content.split(/[\r\n,;]+/).map(u => u.trim()).filter(u => u.startsWith("http"));
  if (profileUrls.length === 0) { res.status(400).json({ error: "No valid URLs found in file" }); return; }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  engine.startJob(jobId, { cookies, profileUrls, reason: reason as any, continuous });
  res.json({ jobId, message: "Report job started from file", total: profileUrls.length, continuous });
});

// Stop a continuous job
app.post("/api/report/:jobId/stop", (req, res) => {
  const ok = engine.stopJob(req.params.jobId);
  if (!ok) { res.status(404).json({ error: "Job not found or not running" }); return; }
  res.json({ message: "Stop signal sent — job will stop after current round" });
});

app.get("/api/report/:jobId", (req, res) => {
  const job = engine.getJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json(job);
});

app.get("/api/jobs", (_req, res) => res.json(engine.getAllJobs()));

app.delete("/api/jobs/:jobId", (req, res) => {
  engine.removeJob(req.params.jobId);
  res.json({ message: "Job removed" });
});

// ─── Status check routes ──────────────────────────────────────────────────────
app.post("/api/check-status", async (req, res) => {
  const parsed = CheckStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }
  const { cookies, profileUrls } = parsed.data;
  const jobId = `chk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  checkEngine.startJob(jobId, { cookies, profileUrls });
  res.json({ jobId, message: "Status check started", total: profileUrls.length });
});

app.get("/api/check-status/jobs", (_req, res) => res.json(checkEngine.getAllJobs()));

app.get("/api/check-status/:jobId", (req, res) => {
  const job = checkEngine.getJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Check job not found" }); return; }
  res.json(job);
});

app.delete("/api/check-status/:jobId", (req, res) => {
  checkEngine.removeJob(req.params.jobId);
  res.json({ message: "Check job removed" });
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.REPORTER_API_PORT ?? 3001);
app.listen(PORT, "0.0.0.0", () => logger.info({ port: PORT }, "FB Reporter API running"));
