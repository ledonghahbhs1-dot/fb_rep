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

async function screenshot(page: Page, label: string): Promise<string> {
  const file = path.join(SCREENSHOT_DIR, `${Date.now()}-${label.replace(/\W+/g, "_")}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return file;
}

function extractUsername(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? "";
}

// ─── Strategy 1: mbasic.facebook.com (simple HTML, no JS-heavy UI) ───────────
async function reportViaMbasic(
  page: Page,
  url: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  try {
    const username = extractUsername(url);
    const mbasicUrl = `https://mbasic.facebook.com/${username}`;
    logger.info({ url: mbasicUrl }, "[mbasic] Navigating");

    await page.goto(mbasicUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    // Check we're on the right profile (not redirected to login)
    const currentUrl = page.url();
    if (currentUrl.includes("login") || currentUrl.includes("checkpoint")) {
      return { success: false, message: "mbasic: redirected to login" };
    }

    // Look for any "Report" link on the mbasic profile page
    // mbasic shows a "Report" or "Report this profile" link near the bottom
    const reportLink = page.locator([
      'a[href*="/report/"]',
      'a:has-text("Report")',
      'a:has-text("Báo cáo")',
      'a[href*="report_type"]',
    ].join(", ")).first();

    if (!await reportLink.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Try scrolling to find it
      await page.keyboard.press("End");
      await page.waitForTimeout(1000);
    }

    if (!await reportLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      const shot = await screenshot(page, "mbasic_no_report_link");
      return { success: false, message: "mbasic: no Report link found on profile", screenshot: shot };
    }

    const href = await reportLink.getAttribute("href").catch(() => "");
    logger.info({ href }, "[mbasic] Found report link");
    await reportLink.click();
    await page.waitForTimeout(2000);

    // Now on the report form — select reason radio button
    const reasonTextMap: Record<ReportReason, string[]> = {
      fake: ["fake", "It's a fake account", "Fake account", "pretending to be"],
      impersonating: ["impersonat", "pretending to be me", "Pretending to be"],
      spam: ["spam", "Spam", "shouldn't be on Facebook"],
      pretending: ["pretending to be someone", "Pretending", "fake"],
    };

    const terms = reasonTextMap[reason];
    let radioClicked = false;

    // Try to find and click a radio button matching the reason
    for (const term of terms) {
      const radio = page.locator(`input[type="radio"]`).filter({
        has: page.locator(`..`).filter({ hasText: new RegExp(term, "i") }),
      }).first();

      if (await radio.isVisible({ timeout: 1500 }).catch(() => false)) {
        await radio.click();
        radioClicked = true;
        break;
      }

      // Also try label text approach
      const label = page.locator(`label:has-text("${term}")`).first();
      if (await label.isVisible({ timeout: 1500 }).catch(() => false)) {
        await label.click();
        radioClicked = true;
        break;
      }
    }

    // Fallback: click the first radio available
    if (!radioClicked) {
      const firstRadio = page.locator('input[type="radio"]').first();
      if (await firstRadio.isVisible({ timeout: 2000 }).catch(() => false)) {
        await firstRadio.click();
        radioClicked = true;
      }
    }

    if (!radioClicked) {
      const shot = await screenshot(page, "mbasic_no_radio");
      return { success: false, message: "mbasic: could not select report reason", screenshot: shot };
    }

    // Submit the form
    const submitBtn = page.locator([
      'input[type="submit"]',
      'button[type="submit"]',
      'button:has-text("Continue")',
      'button:has-text("Submit")',
      'input[value="Continue"]',
      'input[value="Submit"]',
      'input[value="Tiếp tục"]',
    ].join(", ")).first();

    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click();
      await page.waitForTimeout(2000);
    }

    // Check for success indicators on the confirmation page
    const currentUrlAfter = page.url();
    if (
      currentUrlAfter.includes("report") ||
      currentUrlAfter !== mbasicUrl
    ) {
      return { success: true, message: "Report submitted via mbasic" };
    }

    return { success: true, message: "Report submitted via mbasic (form submitted)" };

  } catch (err: any) {
    return { success: false, message: `mbasic error: ${err?.message ?? err}` };
  }
}

// ─── Strategy 2: www.facebook.com via 3-dot "More" button ────────────────────
async function reportViaDesktop(
  page: Page,
  url: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  try {
    logger.info({ url }, "[desktop] Navigating");
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    // ── Click More button (the one in profile ACTIONS, NOT in navigation bar) ──
    // Navigation bar is at y ≈ 0-60px. Profile actions row is at y ≈ 300-450px.
    // We skip anything with y < 150 (nav bar region).
    const moreBtnClicked = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>('[aria-label="More"], [aria-label="Thêm"]')
      );
      // Filter: must be visible, NOT in the top navigation bar (y > 150)
      const profileAreaCandidates = candidates.filter((el) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top > 150 &&   // skip navigation bar
          rect.top < 600      // must be in profile header area
        );
      });

      if (profileAreaCandidates.length === 0) return "not_found";

      // Click the one closest to the profile area (first one after nav bar)
      profileAreaCandidates.sort((a, b) =>
        a.getBoundingClientRect().top - b.getBoundingClientRect().top
      );
      profileAreaCandidates[0].click();
      return "clicked";
    });

    if (moreBtnClicked !== "clicked") {
      // Try aria-haspopup="menu" in the profile area
      const menuBtns = page.locator('div[role="button"][aria-haspopup="menu"]');
      const count = await menuBtns.count().catch(() => 0);
      let clicked = false;
      for (let i = 0; i < count; i++) {
        const btn = menuBtns.nth(i);
        const box = await btn.boundingBox().catch(() => null);
        if (box && box.y > 150 && box.y < 600) {
          await btn.click();
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        const shot = await screenshot(page, "desktop_no_more_btn");
        return { success: false, message: "desktop: could not find profile More (...) button", screenshot: shot };
      }
    }

    await page.waitForTimeout(1500);

    // ── Click "Find support or report profile" in the dropdown ──
    // Wait for the dropdown menu to appear
    await page.waitForSelector('[role="menu"], [role="menuitem"]', { timeout: 4000 }).catch(() => {});

    // Log all visible menuitem texts for debugging
    const menuItems = await page.locator('[role="menuitem"]').allInnerTexts().catch(() => [] as string[]);
    logger.info({ menuItems }, "[desktop] Visible menu items");

    const reportMenuClicked = await page.evaluate(() => {
      const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]');
      for (const item of items) {
        const text = item.textContent ?? "";
        if (/report|báo cáo/i.test(text)) {
          item.click();
          return text.trim();
        }
      }
      return null;
    });

    if (!reportMenuClicked) {
      const shot = await screenshot(page, "desktop_no_report_menuitem");
      logger.warn({ menuItems }, "[desktop] Could not find report menu item");
      return {
        success: false,
        message: `desktop: no report option in menu (items: ${menuItems.join(" | ")})`,
        screenshot: shot,
      };
    }

    logger.info({ clicked: reportMenuClicked }, "[desktop] Clicked report menu item");
    await page.waitForTimeout(2000);

    // ── Select reason in dialog ──
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 }).catch(() => {});

    const reasonLabels: Record<ReportReason, string[]> = {
      fake: ["It\u2019s a fake account", "Fake account", "This is a fake account"],
      impersonating: ["It\u2019s pretending to be me", "Pretending to be someone", "Impersonating"],
      spam: ["It\u2019s posting content that shouldn\u2019t be on Facebook", "Spam", "It\u2019s spam"],
      pretending: ["It\u2019s pretending to be someone", "Pretending to be someone else"],
    };

    let reasonClicked = false;
    for (const label of reasonLabels[reason]) {
      for (const loc of [
        page.locator(`[role="radio"]:has-text("${label}")`).first(),
        page.locator(`label:has-text("${label}")`).first(),
      ]) {
        if (await loc.isVisible({ timeout: 1000 }).catch(() => false)) {
          await loc.click();
          reasonClicked = true;
          break;
        }
      }
      if (reasonClicked) break;
    }

    if (!reasonClicked) {
      const anyRadio = page.locator('[role="dialog"] [role="radio"]').first();
      if (await anyRadio.isVisible({ timeout: 2000 }).catch(() => false)) {
        await anyRadio.click();
        reasonClicked = true;
      }
    }

    if (!reasonClicked) {
      const shot = await screenshot(page, "desktop_no_reason");
      return { success: false, message: "desktop: could not select reason in dialog", screenshot: shot };
    }

    await page.waitForTimeout(800);

    // ── Click Next / Submit up to 5 times ──
    for (let step = 0; step < 5; step++) {
      const nextBtn = page.locator([
        '[role="dialog"] div[role="button"]:has-text("Next")',
        '[role="dialog"] div[role="button"]:has-text("Submit")',
        '[role="dialog"] div[role="button"]:has-text("Send")',
        '[role="dialog"] div[role="button"]:has-text("Tiếp")',
        '[role="dialog"] div[role="button"]:has-text("Gửi")',
      ].join(", ")).first();
      if (await nextBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(1500);
      } else break;
    }

    // ── Close dialog ──
    const doneBtn = page.locator([
      '[role="dialog"] div[role="button"]:has-text("Done")',
      '[role="dialog"] [aria-label="Close"]',
      'div[role="button"]:has-text("Done")',
      '[aria-label="Close"]',
    ].join(", ")).first();
    if (await doneBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await doneBtn.click();
    }

    return { success: true, message: "Report submitted via desktop" };

  } catch (err: any) {
    return { success: false, message: `desktop error: ${err?.message ?? err}` };
  }
}

// ─── Main reporter: tries mbasic first, then desktop ─────────────────────────
async function reportProfile(
  page: Page,
  url: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  // Strategy 1: mbasic (simpler, more stable)
  const mbasicResult = await reportViaMbasic(page, url, reason);
  if (mbasicResult.success) return mbasicResult;

  logger.warn({ url, mbasicMsg: mbasicResult.message }, "mbasic failed, trying desktop");

  // Strategy 2: desktop www.facebook.com
  const desktopResult = await reportViaDesktop(page, url, reason);
  if (desktopResult.success) return desktopResult;

  logger.warn({ url, desktopMsg: desktopResult.message }, "desktop also failed");

  return {
    success: false,
    message: `Both strategies failed. mbasic: ${mbasicResult.message} | desktop: ${desktopResult.message}`,
    screenshot: desktopResult.screenshot ?? mbasicResult.screenshot,
  };
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

      // Hide webdriver flag
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        // @ts-ignore
        window.chrome = { runtime: {} };
      });

      // Verify login on www first
      await page.goto("https://www.facebook.com", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2500);

      const currentUrl = page.url();
      const redirectedToLogin = currentUrl.includes("/login") || currentUrl.includes("checkpoint");
      let isLoggedIn = !redirectedToLogin;

      if (!isLoggedIn) {
        for (const sel of ['[aria-label="Your profile"]', '[data-testid="blue_bar_profile_link"]', 'a[href*="/me/"]']) {
          if (await page.locator(sel).first().isVisible({ timeout: 2000 }).catch(() => false)) {
            isLoggedIn = true;
            break;
          }
        }
      }

      if (!isLoggedIn) {
        const shot = await screenshot(page, "login_failed");
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

        const { success, message, screenshot: shot } = await reportProfile(page, result.url, options.reason);
        result.status = success ? "success" : "failed";
        result.message = message;
        if (shot) result.screenshot = shot;
        result.timestamp = new Date().toISOString();
        job.done = i + 1;
        countResults(job);

        logger.info({ url: result.url, success, message }, "Done");

        if (i < job.results.length - 1) {
          await page.waitForTimeout(5000 + Math.random() * 4000);
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
