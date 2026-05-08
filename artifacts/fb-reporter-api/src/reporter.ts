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

// ─── Official Facebook Help Contact Form IDs ────────────────────────────────
// Each form ID maps to a specific report type on facebook.com/help/contact/
const HELP_FORM_ID: Record<ReportReason, string> = {
  fake:          "295309487309948", // Report a Fake Account
  impersonating: "295309487309948", // Report a Fake Account (impersonation)
  pretending:    "295309487309948", // Report a Fake Account (pretending to be someone)
  spam:          "274459462613911", // Report Spam (fallback to mbasic if form unavailable)
};

// ─── Helpers ────────────────────────────────────────────────────────────────
function parseCookies(raw: string) {
  return raw.split(";").map((p) => p.trim()).filter(Boolean).map((pair) => {
    const idx = pair.indexOf("=");
    const name  = idx > -1 ? pair.slice(0, idx).trim() : pair.trim();
    const rawVal = idx > -1 ? pair.slice(idx + 1).trim() : "";
    let value = rawVal;
    try { value = decodeURIComponent(rawVal); } catch { value = rawVal; }
    return { name, value, domain: ".facebook.com", path: "/", secure: true };
  });
}

async function dbgShot(page: Page, label: string): Promise<string> {
  const file = path.join(SCREENSHOT_DIR, `${Date.now()}-${label.replace(/\W+/g, "_")}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  logger.info({ file }, "Screenshot saved");
  return file;
}

function extractUsername(url: string): string {
  return url.replace(/\/$/, "").split("/").pop() ?? "";
}

async function extractUserId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    // 1. From any link with content_id= or profile_id=
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a"))) {
      const href = a.getAttribute("href") ?? "";
      const m = href.match(/content_id=(\d{5,})/) ?? href.match(/profile_id=(\d{5,})/) ?? href.match(/[?&]id=(\d{5,})/);
      if (m) return m[1];
    }
    // 2. From form actions
    for (const f of Array.from(document.querySelectorAll<HTMLFormElement>("form"))) {
      const m = (f.action ?? "").match(/profile_id=(\d{5,})/) ?? (f.action ?? "").match(/[?&]id=(\d{5,})/);
      if (m) return m[1];
    }
    // 3. From <meta property="al:ios:url">
    const ios = document.querySelector<HTMLMetaElement>('meta[property="al:ios:url"]');
    const m1 = ios?.content?.match(/profile\/(\d{5,})/);
    if (m1) return m1[1];
    // 4. From inline JSON in <script>
    for (const s of Array.from(document.querySelectorAll("script"))) {
      const t = s.textContent ?? "";
      const m = t.match(/"userID"\s*:\s*"(\d{5,})"/) ?? t.match(/"entity_id"\s*:\s*"(\d{5,})"/) ?? t.match(/"profile_id"\s*:\s*"(\d{5,})"/);
      if (m) return m[1];
    }
    // 5. Numeric path in URL
    const pm = location.pathname.match(/^\/(\d{5,})\/?$/);
    if (pm) return pm[1];
    return null;
  });
}

const REASON_CREP: Record<ReportReason, string> = {
  fake: "0", impersonating: "1", spam: "2", pretending: "0",
};

const REASON_RADIO_TEXTS: Record<ReportReason, string[]> = {
  fake:          ["Fake account", "It\u2019s a fake account", "T\u00e0i kho\u1ea3n gi\u1ea3", "Pretending to be"],
  impersonating: ["Pretending to be me", "It\u2019s pretending to be me", "Impersonat", "M\u1ea1o danh"],
  spam:          ["Spam", "It\u2019s spam", "Spam t\u00e0i kho\u1ea3n", "shouldn\u2019t be on Facebook"],
  pretending:    ["Pretending to be someone", "It\u2019s pretending to be", "Gi\u1ea3 v\u1edd"],
};

// ─── Strategy A: Official Facebook Help Contact Form ────────────────────────
// Uses facebook.com/help/contact/<FORM_ID> — the most reliable official channel.
// The form asks for the fake profile URL and submits to Facebook's trust & safety team.
async function strategyHelpForm(
  page: Page,
  profileUrl: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  const formId  = HELP_FORM_ID[reason];
  const formUrl = `https://www.facebook.com/help/contact/${formId}`;
  logger.info({ formUrl, profileUrl }, "[A] Navigating to official help form");

  await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);

  if (page.url().includes("login") || page.url().includes("checkpoint")) {
    return { success: false, message: "[A] Redirected to login — cookies invalid" };
  }

  // Log the page title/heading to understand what form loaded
  const heading = await page.locator("h1, h2, [role='heading']").first().innerText().catch(() => "");
  logger.info({ heading }, "[A] Form heading");

  // ── Fill in the profile URL field ──
  // Facebook help forms typically have text inputs for "profile link" or "URL"
  const urlInputSelectors = [
    'input[placeholder*="link" i]',
    'input[placeholder*="url" i]',
    'input[placeholder*="profile" i]',
    'input[placeholder*="account" i]',
    'input[placeholder*="http" i]',
    'input[name*="url" i]',
    'input[name*="link" i]',
    'input[type="text"]',
    'input[type="url"]',
    'textarea',
  ];

  let urlFilled = false;
  for (const sel of urlInputSelectors) {
    const inputs = page.locator(sel);
    const count = await inputs.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      if (await input.isVisible({ timeout: 800 }).catch(() => false)) {
        await input.click();
        await input.fill(profileUrl);
        urlFilled = true;
        logger.info({ sel, profileUrl }, "[A] Filled URL input");
        break;
      }
    }
    if (urlFilled) break;
  }

  if (!urlFilled) {
    const shot = await dbgShot(page, "A_no_url_input");
    const allText = await page.locator("body").innerText().catch(() => "").then((t) => t.slice(0, 300));
    return {
      success: false,
      message: `[A] Could not find URL input on form (heading: "${heading}", content: "${allText}")`,
      screenshot: shot,
    };
  }

  await page.waitForTimeout(500);

  // ── Handle any required fields ──
  // Some forms have additional fields like "Who are they impersonating?" or
  // "Your relationship to the impersonated person"
  const additionalFields = page.locator('input[type="text"]:visible, textarea:visible');
  const fieldCount = await additionalFields.count().catch(() => 0);
  if (fieldCount > 1) {
    // Fill secondary text field with a generic message if empty
    for (let i = 1; i < fieldCount; i++) {
      const field = additionalFields.nth(i);
      const val = await field.inputValue().catch(() => "");
      if (!val) {
        await field.fill("This account is fake and impersonating a real person.");
        logger.info({ i }, "[A] Filled secondary text field");
      }
    }
  }

  // ── Select any radio/checkbox options if present ──
  const radios = page.locator('input[type="radio"]:visible');
  const radioCount = await radios.count().catch(() => 0);
  if (radioCount > 0) {
    const texts = REASON_RADIO_TEXTS[reason];
    let picked = false;
    for (const text of texts) {
      const label = page.locator(`label:has-text("${text}")`).first();
      if (await label.isVisible({ timeout: 800 }).catch(() => false)) {
        await label.click();
        picked = true;
        break;
      }
    }
    if (!picked) {
      await radios.first().click(); // fallback: first option
    }
    await page.waitForTimeout(500);
  }

  // ── Submit the form ──
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'div[role="button"]:has-text("Submit")',
    'div[role="button"]:has-text("Send")',
    'div[role="button"]:has-text("Continue")',
    'button:has-text("Submit")',
    'button:has-text("Send")',
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      const btnText = await btn.innerText().catch(() => sel);
      logger.info({ btnText }, "[A] Clicking submit button");
      await btn.click();
      submitted = true;
      break;
    }
  }

  if (!submitted) {
    const shot = await dbgShot(page, "A_no_submit");
    return { success: false, message: "[A] Could not find Submit button on form", screenshot: shot };
  }

  await page.waitForTimeout(3000);

  // ── Check for success confirmation ──
  const afterUrl  = page.url();
  const afterText = await page.locator("body").innerText().catch(() => "");
  const successIndicators = [
    "thank", "received", "submitted", "review", "cảm ơn", "đã nhận", "đã gửi",
  ];
  const isSuccess = successIndicators.some((w) => afterText.toLowerCase().includes(w)) ||
                    afterUrl.includes("thank") || afterUrl.includes("submitted");

  if (isSuccess) {
    logger.info({ afterUrl }, "[A] Form submitted — confirmation detected");
    return { success: true, message: `Report submitted via official FB form (form #${formId})` };
  }

  // If still on same page, might need another click
  const shot = await dbgShot(page, "A_after_submit");
  return {
    success: false,
    message: `[A] Form submitted but no confirmation detected (url: ${afterUrl})`,
    screenshot: shot,
  };
}

// ─── Strategy B: mbasic.facebook.com direct URL ─────────────────────────────
async function strategyMbasic(
  page: Page,
  profileUrl: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  const username = extractUsername(profileUrl);
  const mbasicProfile = `https://mbasic.facebook.com/${username}`;
  logger.info({ url: mbasicProfile }, "[B] mbasic profile");

  await page.goto(mbasicProfile, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  if (page.url().includes("login") || page.url().includes("checkpoint")) {
    return { success: false, message: "[B] mbasic: redirected to login" };
  }

  // Scroll to bottom
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

  const userId = await extractUserId(page);
  logger.info({ userId }, "[B] Extracted user ID");

  // Find report link href or construct from user ID
  const reportHref = await page.evaluate((): string | null => {
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a"))) {
      const href = a.getAttribute("href") ?? "";
      const text = (a.textContent ?? "").trim().toLowerCase();
      if ((text === "report" || text === "báo cáo" || /^report/.test(text)) && href.length > 1) return a.href;
    }
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a"))) {
      const href = a.href ?? "";
      if (href.includes("/report/") && (href.includes("ctype") || href.includes("content_id") || href.includes("crep"))) return href;
    }
    return null;
  });

  let reportUrl = reportHref;
  if (!reportUrl && userId) {
    const crep = REASON_CREP[reason];
    reportUrl = `https://mbasic.facebook.com/report/?ctype=1&crep=${crep}&content_id=${userId}&source=profile_actions&from_untrusted=1`;
    logger.info({ reportUrl }, "[B] Constructed report URL from user ID");
  }

  if (!reportUrl) {
    const shot = await dbgShot(page, "B_no_report_url");
    return { success: false, message: `[B] Could not find/build report URL (userId=${userId})`, screenshot: shot };
  }

  await page.goto(reportUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  // Fill and submit the mbasic form
  const texts = REASON_RADIO_TEXTS[reason];
  let selected = false;
  for (const text of texts) {
    const label = page.locator(`label`).filter({ hasText: new RegExp(text, "i") }).first();
    if (await label.isVisible({ timeout: 1200 }).catch(() => false)) { await label.click(); selected = true; break; }
  }
  if (!selected) {
    const first = page.locator('input[type="radio"]').first();
    if (await first.isVisible({ timeout: 2000 }).catch(() => false)) { await first.click(); selected = true; }
  }
  if (!selected) {
    const shot = await dbgShot(page, "B_no_radio");
    return { success: false, message: "[B] No radio buttons found on mbasic form", screenshot: shot };
  }

  await page.waitForTimeout(400);

  const submit = page.locator('input[type="submit"], button[type="submit"], input[value="Continue"], input[value="Tiếp tục"]').first();
  if (!await submit.isVisible({ timeout: 2000 }).catch(() => false)) {
    const shot = await dbgShot(page, "B_no_submit");
    return { success: false, message: "[B] No submit button on mbasic form", screenshot: shot };
  }
  await submit.click();
  await page.waitForTimeout(2000);

  for (let s = 0; s < 3; s++) {
    const more = page.locator('input[type="submit"], button[type="submit"]').first();
    if (await more.isVisible({ timeout: 1200 }).catch(() => false)) { await more.click(); await page.waitForTimeout(1500); }
    else break;
  }

  return { success: true, message: "Report submitted via mbasic" };
}

// ─── Strategy C: www.facebook.com 3-dot menu ────────────────────────────────
async function strategyDesktop(
  page: Page,
  profileUrl: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  logger.info({ url: profileUrl }, "[C] Desktop strategy");
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  const moreClicked = await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('[aria-label="More"], [aria-label="Thêm"]'))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.y > 150 && r.y < 600; })
      .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
    if (!candidates.length) return false;
    candidates[0].click();
    return true;
  });

  if (!moreClicked) {
    const shot = await dbgShot(page, "C_no_more");
    return { success: false, message: "[C] No More (...) button found in profile area (y 150–600)", screenshot: shot };
  }

  await page.waitForTimeout(1500);
  const menuTexts = await page.locator('[role="menuitem"]').allInnerTexts().catch(() => [] as string[]);
  logger.info({ menuTexts }, "[C] Menu items");

  const menuClicked = await page.evaluate(() => {
    for (const item of Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))) {
      if (/report|báo cáo/i.test(item.textContent ?? "")) { item.click(); return item.textContent?.trim() ?? "clicked"; }
    }
    return null;
  });

  if (!menuClicked) {
    const shot = await dbgShot(page, "C_no_report_item");
    return { success: false, message: `[C] No report item in menu. Items: [${menuTexts.join(" | ")}]`, screenshot: shot };
  }

  await page.waitForTimeout(2000);
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 }).catch(() => {});

  let reasonClicked = false;
  for (const text of REASON_RADIO_TEXTS[reason]) {
    for (const sel of [`[role="radio"]:has-text("${text}")`, `label:has-text("${text}")`]) {
      const el = page.locator(`[role="dialog"] ${sel}`).first();
      if (await el.isVisible({ timeout: 800 }).catch(() => false)) { await el.click(); reasonClicked = true; break; }
    }
    if (reasonClicked) break;
  }
  if (!reasonClicked) {
    const first = page.locator('[role="dialog"] [role="radio"]').first();
    if (await first.isVisible({ timeout: 2000 }).catch(() => false)) { await first.click(); reasonClicked = true; }
  }
  if (!reasonClicked) {
    const shot = await dbgShot(page, "C_no_reason");
    return { success: false, message: "[C] Could not select reason in dialog", screenshot: shot };
  }

  await page.waitForTimeout(800);

  for (let step = 0; step < 6; step++) {
    const btn = page.locator([
      '[role="dialog"] div[role="button"]:has-text("Next")',
      '[role="dialog"] div[role="button"]:has-text("Submit")',
      '[role="dialog"] div[role="button"]:has-text("Send")',
      '[role="dialog"] div[role="button"]:has-text("Continue")',
      '[role="dialog"] div[role="button"]:has-text("Tiếp")',
      '[role="dialog"] div[role="button"]:has-text("Gửi")',
    ].join(", ")).first();
    if (await btn.isVisible({ timeout: 1200 }).catch(() => false)) {
      logger.info({ text: await btn.innerText().catch(() => "?"), step }, "[C] Step button");
      await btn.click(); await page.waitForTimeout(1500);
    } else break;
  }

  const done = page.locator('[role="dialog"] div[role="button"]:has-text("Done"), [aria-label="Close"]').first();
  if (await done.isVisible({ timeout: 3000 }).catch(() => false)) await done.click();

  return { success: true, message: `[C] Report submitted via desktop 3-dot menu ("${menuClicked}")` };
}

// ─── Main dispatcher ─────────────────────────────────────────────────────────
async function reportProfile(
  page: Page, url: string, reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  // A: Official Help Form (most reliable for fake/impersonating)
  const a = await strategyHelpForm(page, url, reason);
  if (a.success) { logger.info({ url }, "Strategy A succeeded"); return a; }
  logger.warn({ url, msg: a.message }, "A failed → trying B");

  // B: mbasic direct URL
  const b = await strategyMbasic(page, url, reason);
  if (b.success) { logger.info({ url }, "Strategy B succeeded"); return b; }
  logger.warn({ url, msg: b.message }, "B failed → trying C");

  // C: desktop 3-dot menu
  const c = await strategyDesktop(page, url, reason);
  if (c.success) { logger.info({ url }, "Strategy C succeeded"); return c; }
  logger.warn({ url, msg: c.message }, "All 3 strategies failed");

  return {
    success: false,
    message: `All strategies failed.\n  A: ${a.message}\n  B: ${b.message}\n  C: ${c.message}`,
    screenshot: c.screenshot ?? b.screenshot ?? a.screenshot,
  };
}

function countResults(job: ReportJob) {
  job.reportedCount = job.results.filter((r) => r.status === "success").length;
  job.failedCount   = job.results.filter((r) => r.status === "failed").length;
}

// ─── ReportEngine ─────────────────────────────────────────────────────────────
export class ReportEngine {
  private jobs = new Map<string, ReportJob>();

  startJob(jobId: string, options: ReportJobOptions): void {
    const job: ReportJob = {
      jobId, status: "running",
      total: options.profileUrls.length, done: 0,
      reportedCount: 0, failedCount: 0,
      results: options.profileUrls.map((url) => ({ url, status: "pending" })),
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, job);
    this.runJob(job, options).catch((err) => {
      job.status = "failed"; job.error = String(err);
      job.finishedAt = new Date().toISOString(); countResults(job);
    });
  }

  private async runJob(job: ReportJob, options: ReportJobOptions): Promise<void> {
    let browser: Browser | undefined;
    let ctx: BrowserContext | undefined;
    try {
      browser = await chromium.launch({
        headless: true, executablePath: CHROMIUM_PATH,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
               "--disable-blink-features=AutomationControlled", "--window-size=1280,900"],
      });

      const cookies = parseCookies(options.cookies);
      logger.info({ names: cookies.map((c) => c.name) }, "Cookies loaded");

      ctx = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        locale: "en-US", viewport: { width: 1280, height: 900 },
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

      if (page.url().includes("/login") || page.url().includes("checkpoint")) {
        const shot = await dbgShot(page, "login_failed");
        const msg = "Invalid or expired Facebook cookies";
        for (const r of job.results) { r.status = "failed"; r.message = msg; r.screenshot = shot; r.timestamp = new Date().toISOString(); }
        job.status = "failed"; job.error = msg; job.finishedAt = new Date().toISOString(); countResults(job);
        return;
      }

      logger.info({ jobId: job.jobId }, "Login OK — starting reports");

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

        if (i < job.results.length - 1) await page.waitForTimeout(5000 + Math.random() * 4000);
      }

      job.status = "completed"; job.finishedAt = new Date().toISOString(); countResults(job);
    } finally {
      await ctx?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }

  getJob(jobId: string)    { return this.jobs.get(jobId); }
  getAllJobs()              { return [...this.jobs.values()].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()); }
  removeJob(jobId: string) { this.jobs.delete(jobId); }
}
