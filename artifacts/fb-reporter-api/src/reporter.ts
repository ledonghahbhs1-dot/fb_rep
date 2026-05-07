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
  reportedCount: number;
  failedCount: number;
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

function parseCookies(raw: string): Array<{ name: string; value: string; domain: string; path: string; secure: boolean }> {
  return raw
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      const name = idx > -1 ? pair.slice(0, idx).trim() : pair.trim();
      const value = idx > -1 ? decodeURIComponent(pair.slice(idx + 1).trim()) : "";
      return { name, value, domain: ".facebook.com", path: "/", secure: true };
    });
}

async function reportProfile(
  page: Page,
  url: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string }> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Try to find the "More" / "..." button on the profile
    // Facebook uses different selectors depending on version/language
    const moreBtnSelectors = [
      '[aria-label="More"]',
      '[aria-label="Thêm"]',
      '[data-testid="profileMoreMenuButton"]',
      'div[role="button"]:has([d*="M12 3c-1.2"])',  // three-dot SVG path
      'div[role="button"][aria-haspopup="menu"]',
      // Mobile/responsive version
      '[aria-label="See options"]',
    ];

    let moreBtnClicked = false;
    for (const sel of moreBtnSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await btn.click();
        moreBtnClicked = true;
        await page.waitForTimeout(1200);
        break;
      }
    }

    if (!moreBtnClicked) {
      // Try clicking any visible 3-dot / options button near the profile cover
      const fallbackBtn = page.locator('[role="button"]:has(svg)').filter({ hasText: "" }).nth(2);
      if (await fallbackBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await fallbackBtn.click();
        moreBtnClicked = true;
        await page.waitForTimeout(1200);
      }
    }

    if (!moreBtnClicked) {
      return { success: false, message: "Could not find profile options button (More/...)" };
    }

    // Find and click the Report option in the dropdown menu
    const reportSelectors = [
      '[role="menuitem"]:has-text("Report")',
      '[role="menuitem"]:has-text("Báo cáo")',
      'a:has-text("Report profile")',
      'div:has-text("Report profile"):not([role="none"])',
      'span:text-is("Report profile")',
      'span:text-is("Report")',
    ];

    let reportClicked = false;
    for (const sel of reportSelectors) {
      const item = page.locator(sel).first();
      if (await item.isVisible({ timeout: 2000 }).catch(() => false)) {
        await item.click();
        reportClicked = true;
        await page.waitForTimeout(2000);
        break;
      }
    }

    if (!reportClicked) {
      return { success: false, message: "Could not find Report option in menu" };
    }

    // Map reason to possible label texts Facebook shows in the report dialog
    const reasonLabels: Record<ReportReason, string[]> = {
      fake: [
        "Fake account",
        "It\u2019s pretending to be someone",
        "This is a fake account",
        "Pretending to be someone",
        "T\u00e0i kho\u1ea3n gi\u1ea3",
      ],
      impersonating: [
        "It\u2019s pretending to be me",
        "Impersonating someone",
        "Pretending to be someone",
        "M\u1ea1o danh ai \u0111\u00f3",
      ],
      spam: ["Spam", "Posting spam", "It\u2019s spam", "Spam t\u00e0i kho\u1ea3n"],
      pretending: [
        "It\u2019s pretending to be someone else",
        "Pretending to be someone",
        "Gi\u1ea3 v\u1edd l\u00e0 ng\u01b0\u1eddi kh\u00e1c",
      ],
    };

    const labels = reasonLabels[reason];
    let reasonClicked = false;

    for (const label of labels) {
      const opt = page.locator(`text="${label}"`).first();
      if (await opt.isVisible({ timeout: 2000 }).catch(() => false)) {
        await opt.click();
        reasonClicked = true;
        await page.waitForTimeout(1000);
        break;
      }
    }

    // Fallback: click the first radio/option available
    if (!reasonClicked) {
      const firstOption = page.locator('[role="radio"], [type="radio"], [role="option"]').first();
      if (await firstOption.isVisible({ timeout: 2000 }).catch(() => false)) {
        await firstOption.click();
        reasonClicked = true;
        await page.waitForTimeout(1000);
      }
    }

    if (!reasonClicked) {
      return { success: false, message: "Could not select report reason in dialog" };
    }

    // Click Next / Submit button (may need multiple Next clicks)
    for (let step = 0; step < 4; step++) {
      const nextBtn = page.locator([
        'div[role="button"]:has-text("Next")',
        'button:has-text("Next")',
        'div[role="button"]:has-text("Submit")',
        'button:has-text("Submit")',
        'div[role="button"]:has-text("Tiếp")',
        'div[role="button"]:has-text("Gửi")',
      ].join(", ")).first();

      if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(1500);
      } else {
        break;
      }
    }

    // Click Done / Close to finish
    const doneBtn = page.locator([
      'div[role="button"]:has-text("Done")',
      'button:has-text("Done")',
      'div[role="button"]:has-text("Close")',
      'button:has-text("Close")',
      'div[role="button"]:has-text("Xong")',
      '[aria-label="Close"]',
    ].join(", ")).first();

    if (await doneBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await doneBtn.click();
    }

    return { success: true, message: "Report submitted successfully" };
  } catch (err: any) {
    return { success: false, message: String(err?.message ?? err) };
  }
}

function countResults(job: ReportJob): void {
  job.reportedCount = job.results.filter((r) => r.status === "success").length;
  job.failedCount = job.results.filter((r) => r.status === "failed").length;
}

export class ReportEngine {
  private jobs = new Map<string, ReportJob>();

  startJob(jobId: string, options: ReportJobOptions): void {
    const job: ReportJob = {
      jobId,
      status: "running",
      total: options.profileUrls.length,
      done: 0,
      reportedCount: 0,
      failedCount: 0,
      results: options.profileUrls.map((url) => ({ url, status: "pending" })),
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, job);
    this.runJob(job, options).catch((err) => {
      job.status = "failed";
      job.error = String(err);
      job.finishedAt = new Date().toISOString();
      countResults(job);
    });
  }

  private async runJob(job: ReportJob, options: ReportJobOptions): Promise<void> {
    let browser: Browser | undefined;
    let ctx: BrowserContext | undefined;

    try {
      browser = await chromium.launch({
        headless: true,
        executablePath: CHROMIUM_PATH,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled",
        ],
      });

      const cookies = parseCookies(options.cookies);
      ctx = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        locale: "en-US",
        extraHTTPHeaders: {
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
      await ctx.addCookies(cookies);

      const page = await ctx.newPage();

      // Hide webdriver flag
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      });

      await page.goto("https://www.facebook.com", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);

      // Check login by looking for elements that only appear when logged in
      const loginSelectors = [
        '[aria-label="Your profile"]',
        '[data-testid="blue_bar_profile_link"]',
        'a[href*="/me/"]',
        '[aria-label="Facebook"]', // top nav only shown when logged in with full nav
        'div[role="navigation"] a[href*="profile"]',
      ];

      let isLoggedIn = false;
      for (const sel of loginSelectors) {
        if (await page.locator(sel).first().isVisible({ timeout: 3000 }).catch(() => false)) {
          isLoggedIn = true;
          break;
        }
      }

      // Secondary check: URL should not be /login
      if (!isLoggedIn) {
        const currentUrl = page.url();
        isLoggedIn = !currentUrl.includes("/login") && !currentUrl.includes("checkpoint");
      }

      if (!isLoggedIn) {
        for (const result of job.results) {
          result.status = "failed";
          result.message = "Facebook login failed — invalid or expired cookies";
          result.timestamp = new Date().toISOString();
        }
        job.status = "failed";
        job.error = "Invalid or expired Facebook cookies";
        job.finishedAt = new Date().toISOString();
        countResults(job);
        return;
      }

      logger.info({ jobId: job.jobId }, "Login verified, starting reports");

      for (let i = 0; i < job.results.length; i++) {
        const result = job.results[i];
        logger.info({ url: result.url, jobId: job.jobId, idx: i + 1 }, "Reporting profile");

        const { success, message } = await reportProfile(page, result.url, options.reason);
        result.status = success ? "success" : "failed";
        result.message = message;
        result.timestamp = new Date().toISOString();
        job.done = i + 1;
        countResults(job);

        logger.info({ url: result.url, success, message }, "Report result");

        // Delay between reports to avoid rate limiting
        if (i < job.results.length - 1) {
          const delay = 4000 + Math.random() * 3000;
          await page.waitForTimeout(delay);
        }
      }

      job.status = "completed";
      job.finishedAt = new Date().toISOString();
      countResults(job);
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
