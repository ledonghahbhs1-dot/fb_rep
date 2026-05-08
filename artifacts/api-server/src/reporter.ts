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

// ─── Cookie parser ─────────────────────────────────────────────────────────────
function parseCookies(raw: string) {
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

async function dbgScreenshot(page: Page, label: string): Promise<string> {
  const file = path.join(SCREENSHOT_DIR, `${Date.now()}-${label.replace(/\W+/g, "_")}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  logger.info({ file }, "Screenshot saved");
  return file;
}

function extractUsername(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? "";
}

// ─── Extract numeric user-ID from any FB page ──────────────────────────────────
async function extractUserId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    // 1. From any href with content_id= or profile_id= or id= (numeric)
    const allLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"));
    for (const a of allLinks) {
      const href = a.getAttribute("href") ?? "";
      const m = href.match(/content_id=(\d{5,})/) ??
                href.match(/profile_id=(\d{5,})/) ??
                href.match(/[?&]id=(\d{5,})/);
      if (m) return m[1];
    }
    // 2. From form actions
    for (const form of Array.from(document.querySelectorAll<HTMLFormElement>("form"))) {
      const m = (form.action ?? "").match(/profile_id=(\d{5,})/) ??
                (form.action ?? "").match(/[?&]id=(\d{5,})/);
      if (m) return m[1];
    }
    // 3. From <meta> al:ios:url content="fb://profile/123456"
    const metaIos = document.querySelector<HTMLMetaElement>('meta[property="al:ios:url"]');
    const m1 = metaIos?.content?.match(/profile\/(\d{5,})/);
    if (m1) return m1[1];
    // 4. From inline JSON blobs in <script>
    const scripts = Array.from(document.querySelectorAll("script"));
    for (const s of scripts) {
      const t = s.textContent ?? "";
      const m = t.match(/"userID"\s*:\s*"(\d{5,})"/) ??
                t.match(/"entity_id"\s*:\s*"(\d{5,})"/) ??
                t.match(/"profile_id"\s*:\s*"(\d{5,})"/);
      if (m) return m[1];
    }
    // 5. From the URL itself if already numeric
    const pm = location.pathname.match(/^\/(\d{5,})\/?$/);
    if (pm) return pm[1];
    return null;
  });
}

// ─── Reason mapping ────────────────────────────────────────────────────────────
// Map our reason codes → mbasic crep param and radio-text fallbacks
const REASON_CREP: Record<ReportReason, string> = {
  fake:          "0",   // fake account
  impersonating: "1",   // impersonation
  spam:          "2",   // spam
  pretending:    "0",   // same as fake
};

const REASON_RADIO_TEXTS: Record<ReportReason, string[]> = {
  fake:          ["Fake account", "It\u2019s a fake account", "T\u00e0i kho\u1ea3n gi\u1ea3", "Pretending to be"],
  impersonating: ["Pretending to be me", "It\u2019s pretending to be me", "Impersonat", "M\u1ea1o danh"],
  spam:          ["Spam", "It\u2019s spam", "Spam t\u00e0i kho\u1ea3n", "shouldn\u2019t be on Facebook"],
  pretending:    ["Pretending to be someone", "It\u2019s pretending to be", "Gi\u1ea3 v\u1edd"],
};

// ─── Submit a simple HTML form page (mbasic-style) ─────────────────────────────
async function submitMbasicForm(page: Page, reason: ReportReason): Promise<{ success: boolean; message: string }> {
  const texts = REASON_RADIO_TEXTS[reason];

  // Try to select a radio button matching the reason
  let selected = false;
  for (const text of texts) {
    // Try label with matching text
    const label = page.locator(`label`).filter({ hasText: new RegExp(text, "i") }).first();
    if (await label.isVisible({ timeout: 1500 }).catch(() => false)) {
      await label.click();
      selected = true;
      break;
    }
    // Try radio whose sibling/parent text matches
    const radio = page.locator(`input[type="radio"]`).filter({
      has: page.locator(`xpath=..`).filter({ hasText: new RegExp(text, "i") }),
    }).first();
    if (await radio.isVisible({ timeout: 1000 }).catch(() => false)) {
      await radio.click();
      selected = true;
      break;
    }
  }

  // Fallback: click first available radio
  if (!selected) {
    const first = page.locator(`input[type="radio"]`).first();
    if (await first.isVisible({ timeout: 2000 }).catch(() => false)) {
      await first.click();
      selected = true;
    }
  }

  if (!selected) {
    const shot = await dbgScreenshot(page, "mbasic_form_no_radio");
    return { success: false, message: `No radio buttons found on report form (screenshot: ${shot})` };
  }

  await page.waitForTimeout(500);

  // Submit
  const submitSel = [
    'input[type="submit"]',
    'button[type="submit"]',
    'input[value="Continue"]',
    'input[value="Tiếp tục"]',
    'input[value="Submit"]',
    'button:has-text("Continue")',
    'button:has-text("Submit")',
  ].join(", ");

  const submit = page.locator(submitSel).first();
  if (!await submit.isVisible({ timeout: 3000 }).catch(() => false)) {
    const shot = await dbgScreenshot(page, "mbasic_form_no_submit");
    return { success: false, message: `No submit button on report form (screenshot: ${shot})` };
  }
  await submit.click();
  await page.waitForTimeout(2000);

  // Handle possible multi-step form (click Continue/Submit up to 3 more times)
  for (let step = 0; step < 3; step++) {
    const more = page.locator(submitSel).first();
    if (await more.isVisible({ timeout: 1500 }).catch(() => false)) {
      await more.click();
      await page.waitForTimeout(1500);
    } else break;
  }

  return { success: true, message: "Report submitted successfully via mbasic form" };
}

// ─── Strategy A: navigate directly to mbasic report URL via extracted link ────
async function strategyDirectUrl(
  page: Page,
  profileUrl: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  const username = extractUsername(profileUrl);
  const mbasicProfile = `https://mbasic.facebook.com/${username}`;

  logger.info({ url: mbasicProfile }, "[A] Loading mbasic profile");
  await page.goto(mbasicProfile, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  if (page.url().includes("login") || page.url().includes("checkpoint")) {
    return { success: false, message: "[A] Cookie invalid / redirected to login" };
  }

  // Scroll to bottom so all links render
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

  // Extract numeric user ID (needed to build direct report URL)
  const userId = await extractUserId(page);
  logger.info({ userId }, "[A] Extracted user ID");

  // Look for a "report" href on the page (mbasic usually has one at the bottom)
  const reportHref = await page.evaluate((): string | null => {
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a"));
    for (const a of links) {
      const href = a.getAttribute("href") ?? "";
      const text = (a.textContent ?? "").trim().toLowerCase();
      if (
        (text === "report" || text === "báo cáo" || /^report/.test(text)) &&
        href.length > 1
      ) {
        return a.href;
      }
    }
    // Any link with /report/ in href that looks like a report action
    for (const a of links) {
      const href = a.href ?? "";
      if (href.includes("/report/") && (href.includes("ctype") || href.includes("content_id") || href.includes("crep"))) {
        return href;
      }
    }
    return null;
  });

  // Build report URL: prefer extracted link, otherwise construct from user ID
  let reportUrl: string | null = reportHref;

  if (!reportUrl && userId) {
    // mbasic direct report URL with user ID
    const crep = REASON_CREP[reason];
    reportUrl = `https://mbasic.facebook.com/report/?ctype=1&crep=${crep}&content_id=${userId}&source=profile_actions&from_untrusted=1`;
    logger.info({ reportUrl, userId }, "[A] Constructed report URL from user ID");
  }

  if (!reportUrl) {
    const shot = await dbgScreenshot(page, "A_no_report_url");
    return { success: false, message: `[A] Could not find or construct report URL (userId=${userId})`, screenshot: shot };
  }

  logger.info({ reportUrl }, "[A] Navigating to report URL");
  await page.goto(reportUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  // Fill and submit the mbasic form
  const result = await submitMbasicForm(page, reason);
  return { ...result, message: result.message };
}

// ─── Strategy B: www.facebook.com with correct More button targeting ──────────
async function strategyDesktop(
  page: Page,
  profileUrl: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  logger.info({ url: profileUrl }, "[B] Desktop strategy");
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  // Get page structure info for debugging
  const pageInfo = await page.evaluate(() => {
    const moreButtons = Array.from(document.querySelectorAll('[aria-label="More"], [aria-label="Thêm"]'));
    return moreButtons.map((el) => {
      const rect = el.getBoundingClientRect();
      return { y: Math.round(rect.y), x: Math.round(rect.x), text: el.textContent?.slice(0, 30) };
    });
  });
  logger.info({ pageInfo }, "[B] Found More buttons");

  // The profile actions "More" button:
  // - NOT in the top navigation bar (y > 150)
  // - NOT below the fold for the header (y < 600)
  // - Profile action buttons are roughly at y 320-430
  const clicked = await page.evaluate(() => {
    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>('[aria-label="More"], [aria-label="Thêm"]')
    ).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.y > 150 && r.y < 600;
    }).sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);

    if (candidates.length === 0) return false;
    candidates[0].click();
    return true;
  });

  if (!clicked) {
    const shot = await dbgScreenshot(page, "B_no_more_btn");
    return { success: false, message: "[B] No More (...) button found in profile area", screenshot: shot };
  }

  await page.waitForTimeout(1500);

  // Log what appeared after click
  const menuTexts = await page.locator('[role="menuitem"]').allInnerTexts().catch(() => [] as string[]);
  logger.info({ menuTexts }, "[B] Menu items after clicking More");

  if (menuTexts.length === 0) {
    const shot = await dbgScreenshot(page, "B_no_menu");
    return { success: false, message: "[B] No menu appeared after clicking More", screenshot: shot };
  }

  // Find report item (case-insensitive)
  const reportItemClicked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    for (const item of items) {
      if (/report|báo cáo/i.test(item.textContent ?? "")) {
        item.click();
        return item.textContent?.trim() ?? "clicked";
      }
    }
    return null;
  });

  if (!reportItemClicked) {
    const shot = await dbgScreenshot(page, "B_no_report_in_menu");
    return {
      success: false,
      message: `[B] Menu has no report item. Items: [${menuTexts.join(" | ")}]`,
      screenshot: shot,
    };
  }

  logger.info({ item: reportItemClicked }, "[B] Clicked report menu item");
  await page.waitForTimeout(2000);

  // ── Select reason in dialog ──
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 }).catch(() => {});

  const dialogTexts = await page.locator('[role="dialog"]').allInnerTexts().catch(() => [] as string[]);
  logger.info({ dialogTexts: dialogTexts.join(" | ").slice(0, 200) }, "[B] Dialog texts");

  let reasonClicked = false;
  for (const text of REASON_RADIO_TEXTS[reason]) {
    for (const sel of [
      `[role="radio"]:has-text("${text}")`,
      `label:has-text("${text}")`,
      `div:has-text("${text}"):not([role="none"])`,
    ]) {
      const el = page.locator(`[role="dialog"] ${sel}`).first();
      if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
        await el.click();
        reasonClicked = true;
        break;
      }
    }
    if (reasonClicked) break;
  }

  if (!reasonClicked) {
    // Fallback: first radio in dialog
    const first = page.locator('[role="dialog"] [role="radio"]').first();
    if (await first.isVisible({ timeout: 2000 }).catch(() => false)) {
      await first.click();
      reasonClicked = true;
    }
  }

  if (!reasonClicked) {
    const shot = await dbgScreenshot(page, "B_no_reason");
    return { success: false, message: "[B] Could not select reason in dialog", screenshot: shot };
  }

  await page.waitForTimeout(800);

  // ── Click through Next/Submit steps ──
  for (let step = 0; step < 6; step++) {
    const btn = page.locator([
      '[role="dialog"] div[role="button"]:has-text("Next")',
      '[role="dialog"] div[role="button"]:has-text("Submit")',
      '[role="dialog"] div[role="button"]:has-text("Send")',
      '[role="dialog"] div[role="button"]:has-text("Continue")',
      '[role="dialog"] div[role="button"]:has-text("Tiếp")',
      '[role="dialog"] div[role="button"]:has-text("Gửi")',
    ].join(", ")).first();

    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      const btnText = await btn.innerText().catch(() => "");
      logger.info({ btnText, step }, "[B] Clicking step button");
      await btn.click();
      await page.waitForTimeout(1500);
    } else break;
  }

  // ── Close dialog ──
  const done = page.locator('[role="dialog"] div[role="button"]:has-text("Done"), [aria-label="Close"]').first();
  if (await done.isVisible({ timeout: 3000 }).catch(() => false)) await done.click();

  return { success: true, message: `Report submitted via desktop (menu: "${reportItemClicked}")` };
}

// ─── Main report dispatcher ────────────────────────────────────────────────────
async function reportProfile(
  page: Page,
  url: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  // Strategy A: direct URL navigation via mbasic (most reliable)
  const resultA = await strategyDirectUrl(page, url, reason);
  if (resultA.success) {
    logger.info({ url }, "Strategy A succeeded");
    return resultA;
  }
  logger.warn({ url, msg: resultA.message }, "Strategy A failed, trying B");

  // Strategy B: desktop www.facebook.com with 3-dot menu
  const resultB = await strategyDesktop(page, url, reason);
  if (resultB.success) {
    logger.info({ url }, "Strategy B succeeded");
    return resultB;
  }
  logger.warn({ url, msg: resultB.message }, "Both strategies failed");

  return {
    success: false,
    message: `A: ${resultA.message} | B: ${resultB.message}`,
    screenshot: resultB.screenshot ?? resultA.screenshot,
  };
}

function countResults(job: ReportJob): void {
  job.reportedCount = job.results.filter((r) => r.status === "success").length;
  job.failedCount   = job.results.filter((r) => r.status === "failed").length;
}

// ─── ReportEngine ──────────────────────────────────────────────────────────────
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
      logger.info({ names: cookies.map((c) => c.name) }, "Cookies loaded");

      ctx = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        locale: "en-US",
        viewport: { width: 1280, height: 900 },
        extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
      });
      await ctx.addCookies(cookies);

      const page = await ctx.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });
        // @ts-ignore
        window.chrome = { runtime: {} };
      });

      // ── Verify login ──
      await page.goto("https://www.facebook.com", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2500);

      const afterUrl = page.url();
      if (afterUrl.includes("/login") || afterUrl.includes("checkpoint")) {
        const shot = await dbgScreenshot(page, "login_failed");
        const msg = "Invalid or expired Facebook cookies (redirected to login)";
        for (const r of job.results) { r.status = "failed"; r.message = msg; r.screenshot = shot; r.timestamp = new Date().toISOString(); }
        job.status = "failed"; job.error = msg; job.finishedAt = new Date().toISOString(); countResults(job);
        return;
      }
      logger.info({ jobId: job.jobId }, "Login OK");

      // ── Process each URL ──
      for (let i = 0; i < job.results.length; i++) {
        const result = job.results[i];
        logger.info({ url: result.url, n: `${i + 1}/${job.total}` }, "Reporting");

        const { success, message, screenshot } = await reportProfile(page, result.url, options.reason);
        result.status    = success ? "success" : "failed";
        result.message   = message;
        if (screenshot) result.screenshot = screenshot;
        result.timestamp = new Date().toISOString();
        job.done = i + 1;
        countResults(job);

        logger.info({ url: result.url, success, message }, "Result");

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

  getJob(jobId: string)   { return this.jobs.get(jobId); }
  getAllJobs()             { return [...this.jobs.values()].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()); }
  removeJob(jobId: string) { this.jobs.delete(jobId); }
}
