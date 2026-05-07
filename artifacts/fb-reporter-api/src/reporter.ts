import { chromium, Browser, BrowserContext, Page } from "playwright";
import { pino } from "pino";

const logger = pino({ level: "info" });

export type ReportReason = "fake" | "impersonating" | "spam" | "pretending";

export interface ReportJobOptions {
  cookies: string;
  profileUrls: string[];
  reason: ReportReason;
}

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
  results: ReportResult[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

const CHROMIUM_PATH: string | undefined =
  process.env.CHROMIUM_PATH ??
  (process.env.REPL_ID
    ? "/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome"
    : undefined);

function parseCookies(raw: string): Array<{ name: string; value: string; domain: string; path: string }> {
  return raw
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      const name = idx > -1 ? pair.slice(0, idx).trim() : pair.trim();
      const value = idx > -1 ? pair.slice(idx + 1).trim() : "";
      return { name, value, domain: ".facebook.com", path: "/" };
    });
}

async function reportProfile(
  page: Page,
  url: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string }> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const moreBtn = page.locator('[aria-label="More"], [data-testid="profileMoreMenuButton"]').first();
    if (!(await moreBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      return { success: false, message: "Could not find profile actions button" };
    }
    await moreBtn.click();
    await page.waitForTimeout(1000);

    const reportItem = page.locator('text=Report profile, text=Report, [role="menuitem"]:has-text("Report")').first();
    if (!(await reportItem.isVisible({ timeout: 5000 }).catch(() => false))) {
      return { success: false, message: "Could not find Report option in menu" };
    }
    await reportItem.click();
    await page.waitForTimeout(1500);

    const reasonMap: Record<ReportReason, string[]> = {
      fake: ["Fake account", "It's pretending to be someone", "This is a fake account"],
      impersonating: ["Pretending to be someone", "It's pretending to be me", "Impersonation"],
      spam: ["Spam", "Posting spam"],
      pretending: ["Pretending to be someone", "It's pretending to be someone else"],
    };

    const labels = reasonMap[reason];
    let clicked = false;
    for (const label of labels) {
      const opt = page.locator(`text="${label}"`).first();
      if (await opt.isVisible({ timeout: 3000 }).catch(() => false)) {
        await opt.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      const anyOption = page.locator('[role="radio"], [role="option"]').first();
      if (await anyOption.isVisible({ timeout: 3000 }).catch(() => false)) {
        await anyOption.click();
        clicked = true;
      }
    }

    if (!clicked) {
      return { success: false, message: "Could not select report reason" };
    }

    await page.waitForTimeout(1000);

    const nextBtn = page.locator('div[role="button"]:has-text("Next"), button:has-text("Next"), div[role="button"]:has-text("Submit"), button:has-text("Submit")').first();
    if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await nextBtn.click();
      await page.waitForTimeout(1500);
    }

    const doneBtn = page.locator('div[role="button"]:has-text("Done"), button:has-text("Done"), div[role="button"]:has-text("Close"), button:has-text("Close")').first();
    if (await doneBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await doneBtn.click();
    }

    return { success: true, message: "Report submitted successfully" };
  } catch (err: any) {
    return { success: false, message: String(err?.message ?? err) };
  }
}

export class ReportEngine {
  private jobs = new Map<string, ReportJob>();

  startJob(jobId: string, options: ReportJobOptions): void {
    const job: ReportJob = {
      jobId,
      status: "running",
      total: options.profileUrls.length,
      done: 0,
      results: options.profileUrls.map((url) => ({ url, status: "pending" })),
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, job);
    this.runJob(job, options).catch((err) => {
      job.status = "failed";
      job.error = String(err);
      job.finishedAt = new Date().toISOString();
    });
  }

  private async runJob(job: ReportJob, options: ReportJobOptions): Promise<void> {
    let browser: Browser | undefined;
    let ctx: BrowserContext | undefined;

    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: CHROMIUM_PATH,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      });

      const cookies = parseCookies(options.cookies);
      ctx = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        locale: "en-US",
      });
      await ctx.addCookies(cookies);

      const page = await ctx.newPage();

      await page.goto("https://www.facebook.com", { waitUntil: "domcontentloaded", timeout: 30000 });
      const isLoggedIn = await page.locator('[aria-label="Your profile"], [data-testid="blue_bar_profile_link"]').first().isVisible({ timeout: 8000 }).catch(() => false);

      if (!isLoggedIn) {
        for (const result of job.results) {
          result.status = "failed";
          result.message = "Facebook login failed — invalid or expired cookies";
          result.timestamp = new Date().toISOString();
        }
        job.status = "failed";
        job.error = "Invalid or expired Facebook cookies";
        job.finishedAt = new Date().toISOString();
        return;
      }

      for (let i = 0; i < job.results.length; i++) {
        const result = job.results[i];
        logger.info({ url: result.url, jobId: job.jobId }, "Reporting profile");
        const { success, message } = await reportProfile(page, result.url, options.reason);
        result.status = success ? "success" : "failed";
        result.message = message;
        result.timestamp = new Date().toISOString();
        job.done = i + 1;
        if (i < job.results.length - 1) {
          await page.waitForTimeout(3000 + Math.random() * 2000);
        }
      }

      job.status = "completed";
      job.finishedAt = new Date().toISOString();
    } finally {
      await ctx?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }

  getJob(jobId: string): ReportJob | undefined {
    return this.jobs.get(jobId);
  }

  getAllJobs(): ReportJob[] {
    return Array.from(this.jobs.values()).sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  }

  removeJob(jobId: string): void {
    this.jobs.delete(jobId);
  }
}
