import { chromium, Browser, BrowserContext, Page } from "playwright";
import { pino } from "pino";
import fs from "fs";
import path from "path";

const logger = pino({ level: "info" });

const SCREENSHOT_DIR = "/tmp/fb-screenshots";
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

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
  screenshot?: string;
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

function parseCookies(raw: string): Array<{
  name: string; value: string; domain: string; path: string; secure: boolean;
}> {
  return raw
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf("=");
      const name = idx > -1 ? pair.slice(0, idx).trim() : pair.trim();
      const rawVal = idx > -1 ? pair.slice(idx + 1).trim() : "";
      let value = rawVal;
      try { value = decodeURIComponent(rawVal); } catch { value = rawVal; }
      return { name, value, domain: ".facebook.com", path: "/", secure: true };
    });
}

async function saveDebugScreenshot(page: Page, label: string): Promise<string> {
  const file = path.join(SCREENSHOT_DIR, `${Date.now()}-${label.replace(/\W+/g, "_")}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

async function clickMoreButton(page: Page): Promise<boolean> {
  // Strategy 1: profile-specific "More" button — appears next to Message/Add Friend
  // Facebook profile action buttons row contains aria-label="More" as the last action button.
  // To avoid hitting wrong buttons, evaluate the DOM and find the correct one.
  const found = await page.evaluate(() => {
    // Look for aria-label="More" buttons that are NOT inside feed/timeline items
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="More"], [aria-label="Thêm"]')
    );
    // Prefer the one closest to the profile cover (top of page = smaller offsetTop)
    const sorted = candidates
      .filter((el) => {
        // Must be visible and not inside a post/comment feed item
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < 600;
      })
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    if (sorted.length > 0) {
      (sorted[0] as HTMLElement).click();
      return true;
    }
    return false;
  });

  if (found) {
    await page.waitForTimeout(1500);
    return true;
  }

  // Strategy 2: look for the "..." dots button using SVG path patterns
  const svgMoreBtn = page.locator(
    'div[role="button"]:has(i[style*="background-image"]), div[role="button"]:has(svg)'
  )
    .filter({ hasNot: page.locator('img') }) // exclude buttons with photos
    .nth(3); // usually the 4th icon button is "..."

  if (await svgMoreBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    const rect = await svgMoreBtn.boundingBox().catch(() => null);
    if (rect && rect.y < 500) {
      await svgMoreBtn.click();
      await page.waitForTimeout(1500);
      return true;
    }
  }

  // Strategy 3: any aria-haspopup="menu" button near the top of the profile
  const menuBtn = page.locator('div[role="button"][aria-haspopup="menu"]').first();
  if (await menuBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    const rect = await menuBtn.boundingBox().catch(() => null);
    if (rect && rect.y < 500) {
      await menuBtn.click();
      await page.waitForTimeout(1500);
      return true;
    }
  }

  return false;
}

async function clickReportMenuItem(page: Page): Promise<boolean> {
  // Facebook 2024: the menu item is "Find support or report profile"
  // Some versions show just "Report profile" or "Report"
  const candidates = [
    // Most common in 2024 English Facebook
    '[role="menuitem"]:has-text("Find support or report")',
    '[role="menuitem"]:has-text("Report profile")',
    '[role="menuitem"]:has-text("Report")',
    // Vietnamese
    '[role="menuitem"]:has-text("Tìm sự hỗ trợ hoặc báo cáo")',
    '[role="menuitem"]:has-text("Báo cáo trang cá nhân")',
    '[role="menuitem"]:has-text("Báo cáo")',
    // Generic — any menu item with report/báo cáo text
    '[role="menuitem"] span:text-matches("report", "i")',
    '[role="menuitem"] span:text-matches("báo cáo", "i")',
    // Fallback: any li/div with report text in a menu/dialog context
    '[role="menu"] [role="menuitem"]',
  ];

  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      const text = await el.innerText().catch(() => "");
      logger.info({ sel, text: text.trim() }, "Found report menu item");
      await el.click();
      await page.waitForTimeout(2000);
      return true;
    }
  }

  // Last resort: JS-based search for any visible element containing "report" text
  const clicked = await page.evaluate(() => {
    const walk = (el: Element): boolean => {
      if (
        el.getAttribute("role") === "menuitem" &&
        /report|báo cáo/i.test(el.textContent ?? "")
      ) {
        (el as HTMLElement).click();
        return true;
      }
      return Array.from(el.children).some(walk);
    };
    return walk(document.body);
  });

  if (clicked) await page.waitForTimeout(2000);
  return clicked;
}

async function selectReportReason(page: Page, reason: ReportReason): Promise<boolean> {
  // Facebook 2024 report dialog reason texts (first screen asks "What's going on?")
  const reasonMap: Record<ReportReason, string[]> = {
    fake: [
      "It's a fake account",
      "Fake account",
      "It\u2019s a fake account",
      "This is a fake account",
      "Pretending to be someone",
      "It\u2019s pretending to be someone",
      "T\u00e0i kho\u1ea3n gi\u1ea3",
    ],
    impersonating: [
      "It\u2019s pretending to be me",
      "It\u2019s pretending to be someone",
      "Pretending to be someone",
      "Impersonating someone",
      "M\u1ea1o danh ai \u0111\u00f3",
    ],
    spam: [
      "It\u2019s posting content that shouldn\u2019t be on Facebook",
      "Spam",
      "Posting spam",
      "It\u2019s spam",
      "Spam t\u00e0i kho\u1ea3n",
      "Something else",
    ],
    pretending: [
      "It\u2019s pretending to be someone",
      "It\u2019s pretending to be someone else",
      "Pretending to be someone",
      "Gi\u1ea3 v\u1edd l\u00e0 ng\u01b0\u1eddi kh\u00e1c",
    ],
  };

  const labels = reasonMap[reason];

  // Wait for dialog to appear
  await page.waitForSelector('[role="dialog"], [data-testid="dialog"]', { timeout: 5000 }).catch(() => {});

  for (const label of labels) {
    // Try exact text first, then partial
    for (const loc of [
      page.locator(`[role="radio"]:has-text("${label}")`).first(),
      page.locator(`label:has-text("${label}")`).first(),
      page.locator(`text="${label}"`).first(),
    ]) {
      if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
        await loc.click();
        await page.waitForTimeout(800);
        return true;
      }
    }
  }

  // Fallback: click any visible radio in the dialog
  const radios = page.locator('[role="dialog"] [role="radio"], [role="dialog"] input[type="radio"]');
  const count = await radios.count().catch(() => 0);
  if (count > 0) {
    await radios.first().click();
    await page.waitForTimeout(800);
    return true;
  }

  return false;
}

async function submitReport(page: Page): Promise<void> {
  // Click through up to 5 "Next"/"Submit" steps (Facebook has multi-step report dialogs)
  for (let step = 0; step < 5; step++) {
    const btnSel = [
      '[role="dialog"] div[role="button"]:has-text("Next")',
      '[role="dialog"] div[role="button"]:has-text("Submit")',
      '[role="dialog"] div[role="button"]:has-text("Send")',
      '[role="dialog"] div[role="button"]:has-text("Continue")',
      '[role="dialog"] div[role="button"]:has-text("Tiếp theo")',
      '[role="dialog"] div[role="button"]:has-text("Gửi")',
      // Outside dialog (some FB versions)
      'div[role="button"]:has-text("Next")',
      'div[role="button"]:has-text("Submit")',
    ].join(", ");

    const btn = page.locator(btnSel).first();
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(1800);
    } else {
      break;
    }
  }

  // Close the dialog
  const closeSelectors = [
    '[role="dialog"] [aria-label="Close"]',
    '[role="dialog"] div[role="button"]:has-text("Done")',
    '[role="dialog"] div[role="button"]:has-text("Xong")',
    '[aria-label="Close"]',
    'div[role="button"]:has-text("Done")',
  ].join(", ");

  const closeBtn = page.locator(closeSelectors).first();
  if (await closeBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await closeBtn.click();
    await page.waitForTimeout(800);
  }
}

async function reportProfile(
  page: Page,
  url: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  try {
    logger.info({ url }, "Navigating to profile");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    // --- Step 1: Click More (three-dot) button ---
    const moreBtnClicked = await clickMoreButton(page);
    if (!moreBtnClicked) {
      const shot = await saveDebugScreenshot(page, "no-more-btn");
      logger.warn({ url, shot }, "Could not find More button");
      return { success: false, message: "Could not find profile options button (...)", screenshot: shot };
    }

    // --- Step 2: Click "Find support or report profile" ---
    const reportClicked = await clickReportMenuItem(page);
    if (!reportClicked) {
      const shot = await saveDebugScreenshot(page, "no-report-menuitem");
      logger.warn({ url, shot }, "Could not find Report menu item");
      return { success: false, message: "Could not find 'Report profile' in menu", screenshot: shot };
    }

    // --- Step 3: Select reason ---
    const reasonSelected = await selectReportReason(page, reason);
    if (!reasonSelected) {
      const shot = await saveDebugScreenshot(page, "no-reason");
      logger.warn({ url, shot }, "Could not select reason");
      return { success: false, message: "Could not select report reason in dialog", screenshot: shot };
    }

    // --- Step 4: Submit ---
    await submitReport(page);

    logger.info({ url }, "Report submitted successfully");
    return { success: true, message: "Report submitted successfully" };
  } catch (err: any) {
    const shot = await saveDebugScreenshot(page, "exception").catch(() => undefined);
    return { success: false, message: String(err?.message ?? err), screenshot: shot };
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
          "--window-size=1280,900",
        ],
      });

      const cookies = parseCookies(options.cookies);
      logger.info({ count: cookies.length, names: cookies.map((c) => c.name) }, "Parsed cookies");

      ctx = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        locale: "en-US",
        viewport: { width: 1280, height: 900 },
        extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
      });

      await ctx.addCookies(cookies);

      const page = await ctx.newPage();

      // Spoof webdriver detection
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        // @ts-ignore
        window.chrome = { runtime: {} };
      });

      // Navigate to Facebook and verify login
      await page.goto("https://www.facebook.com", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);

      const currentUrl = page.url();
      const isRedirectedToLogin = currentUrl.includes("/login") || currentUrl.includes("checkpoint");

      let isLoggedIn = !isRedirectedToLogin;

      if (!isLoggedIn) {
        // Check for profile link in nav
        for (const sel of [
          '[aria-label="Your profile"]',
          '[data-testid="blue_bar_profile_link"]',
          'a[href*="/me/"]',
        ]) {
          if (await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
            isLoggedIn = true;
            break;
          }
        }
      }

      if (!isLoggedIn) {
        const shot = await saveDebugScreenshot(page, "login-failed");
        logger.error({ shot, currentUrl }, "Login failed");
        for (const result of job.results) {
          result.status = "failed";
          result.message = "Facebook login failed — invalid or expired cookies";
          result.screenshot = shot;
          result.timestamp = new Date().toISOString();
        }
        job.status = "failed";
        job.error = "Invalid or expired Facebook cookies";
        job.finishedAt = new Date().toISOString();
        countResults(job);
        return;
      }

      logger.info({ jobId: job.jobId }, "Login OK — starting reports");

      for (let i = 0; i < job.results.length; i++) {
        const result = job.results[i];
        logger.info({ url: result.url, idx: i + 1, total: job.total }, "Reporting");

        const { success, message, screenshot } = await reportProfile(page, result.url, options.reason);
        result.status = success ? "success" : "failed";
        result.message = message;
        if (screenshot) result.screenshot = screenshot;
        result.timestamp = new Date().toISOString();
        job.done = i + 1;
        countResults(job);

        logger.info({ url: result.url, success, message }, "Done");

        if (i < job.results.length - 1) {
          const delay = 5000 + Math.random() * 4000;
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
