import express from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import multer from "multer";
import { pino } from "pino";
import { z } from "zod";
import { ReportEngine } from "./reporter.js";

const logger = pino({ level: "info" });
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(pinoHttp({ logger }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const engine = new ReportEngine();

const ReportRequestSchema = z.object({
  cookies: z.string().min(1, "Facebook cookies are required"),
  profileUrls: z.array(z.string().url()).min(1, "At least one profile URL is required"),
  reason: z.enum(["fake", "impersonating", "spam", "pretending"]).default("fake"),
});

app.post("/api/report", async (req, res) => {
  const parsed = ReportRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation failed", details: parsed.error.flatten() });
    return;
  }
  const { cookies, profileUrls, reason } = parsed.data;
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  engine.startJob(jobId, { cookies, profileUrls, reason });
  res.json({ jobId, message: "Report job started", total: profileUrls.length });
});

app.post("/api/report/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file uploaded" });
    return;
  }
  const cookies = req.body.cookies as string;
  const reason = (req.body.reason as string) || "fake";
  if (!cookies) {
    res.status(400).json({ error: "cookies field is required" });
    return;
  }
  const content = req.file.buffer.toString("utf-8");
  const profileUrls = content
    .split(/[\r\n,;]+/)
    .map((u) => u.trim())
    .filter((u) => u.startsWith("http"));

  if (profileUrls.length === 0) {
    res.status(400).json({ error: "No valid URLs found in file" });
    return;
  }

  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  engine.startJob(jobId, { cookies, profileUrls, reason: reason as any });
  res.json({ jobId, message: "Report job started from file", total: profileUrls.length });
});

app.get("/api/report/:jobId", (req, res) => {
  const job = engine.getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

app.get("/api/jobs", (_req, res) => {
  res.json(engine.getAllJobs());
});

app.delete("/api/jobs/:jobId", (req, res) => {
  engine.removeJob(req.params.jobId);
  res.json({ message: "Job removed" });
});

const PORT = Number(process.env.REPORTER_API_PORT ?? 3001);
app.listen(PORT, "0.0.0.0", () => {
  logger.info({ port: PORT }, "FB Reporter API running");
});
