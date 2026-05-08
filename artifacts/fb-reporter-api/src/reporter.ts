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

export interface FormResult {
  formId: string;
  label: string;
  success: boolean;
  message: string;
}

export interface ReportResult {
  url: string;
  status: "pending" | "success" | "failed" | "skipped";
  message?: string;
  screenshot?: string;
  timestamp?: string;
  formResults?: FormResult[];
  formsSubmitted?: number;
  formsFailed?: number;
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

// ─── All official Facebook Help Contact Forms ───────────────────────────────
// Each form is an independent report channel. We submit to ALL of them for
// maximum coverage. Facebook's internal routing may differ per form ID.
interface HelpForm {
  id: string;
  label: string;
  reasons: ReportReason[];   // which report reasons this form applies to
}

const ALL_HELP_FORMS: HelpForm[] = [
  {
    id: "295309487309948",
    label: "Báo cáo tài khoản giả mạo",
    reasons: ["fake", "impersonating", "pretending"],
  },
  {
    id: "1758255661104383",
    label: "Báo cáo mạo danh người khác",
    reasons: ["impersonating", "pretending", "fake"],
  },
  {
    id: "274459462613911",
    label: "Báo cáo vi phạm điều khoản / spam",
    reasons: ["spam", "fake", "impersonating", "pretending"],
  },
  {
    id: "485974059259751",
    label: "Báo cáo trang cá nhân",
    reasons: ["fake", "impersonating", "pretending", "spam"],
  },
  {
    id: "144059062408922",
    label: "Báo cáo tài khoản",
    reasons: ["fake", "impersonating", "pretending", "spam"],
  },
  {
    id: "228813257197480",
    label: "Báo cáo nội dung vi phạm",
    reasons: ["fake", "impersonating", "pretending", "spam"],
  },
];

function getFormsForReason(reason: ReportReason): HelpForm[] {
  return ALL_HELP_FORMS.filter((f) => f.reasons.includes(reason));
}

// ─── Cookie parser ──────────────────────────────────────────────────────────
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
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a"))) {
      const href = a.getAttribute("href") ?? "";
      const m = href.match(/content_id=(\d{5,})/) ?? href.match(/profile_id=(\d{5,})/) ?? href.match(/[?&]id=(\d{5,})/);
      if (m) return m[1];
    }
    for (const f of Array.from(document.querySelectorAll<HTMLFormElement>("form"))) {
      const m = (f.action ?? "").match(/profile_id=(\d{5,})/) ?? (f.action ?? "").match(/[?&]id=(\d{5,})/);
      if (m) return m[1];
    }
    const ios = document.querySelector<HTMLMetaElement>('meta[property="al:ios:url"]');
    const m1 = ios?.content?.match(/profile\/(\d{5,})/);
    if (m1) return m1[1];
    for (const s of Array.from(document.querySelectorAll("script"))) {
      const t = s.textContent ?? "";
      const m = t.match(/"userID"\s*:\s*"(\d{5,})"/) ?? t.match(/"entity_id"\s*:\s*"(\d{5,})"/) ?? t.match(/"profile_id"\s*:\s*"(\d{5,})"/);
      if (m) return m[1];
    }
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

// ─── Submit ONE help-contact form for a given profile URL ───────────────────
async function submitOneHelpForm(
  page: Page,
  form: HelpForm,
  profileUrl: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  const formUrl = `https://www.facebook.com/help/contact/${form.id}`;
  logger.info({ formUrl, profileUrl, label: form.label }, "Submitting form");

  await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  if (page.url().includes("login") || page.url().includes("checkpoint")) {
    return { success: false, message: "Chuyển hướng đến trang đăng nhập — cookie không hợp lệ" };
  }

  const heading = await page.locator("h1, h2, [role='heading']").first().innerText().catch(() => "");
  logger.info({ heading, formId: form.id }, "Form heading");

  // ── Fill profile URL field ──
  const urlInputSelectors = [
    'input[placeholder*="link" i]',
    'input[placeholder*="url" i]',
    'input[placeholder*="profile" i]',
    'input[placeholder*="account" i]',
    'input[placeholder*="http" i]',
    'input[name*="url" i]',
    'input[name*="link" i]',
    'input[type="url"]',
    'input[type="text"]',
    'textarea',
  ];

  let urlFilled = false;
  for (const sel of urlInputSelectors) {
    const inputs = page.locator(sel);
    const count = await inputs.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      if (await input.isVisible({ timeout: 600 }).catch(() => false)) {
        await input.click();
        await input.fill(profileUrl);
        urlFilled = true;
        logger.info({ sel, formId: form.id }, "Filled URL input");
        break;
      }
    }
    if (urlFilled) break;
  }

  if (!urlFilled) {
    const shot = await dbgShot(page, `form_${form.id}_no_input`);
    const bodyText = await page.locator("body").innerText().catch(() => "").then((t) => t.slice(0, 200));
    return {
      success: false,
      message: `Không tìm thấy ô nhập URL trên form (heading: "${heading}", body: "${bodyText}")`,
      screenshot: shot,
    };
  }

  await page.waitForTimeout(400);

  // ── Fill any additional text fields ──
  const extraFields = page.locator('input[type="text"]:visible, textarea:visible');
  const extraCount = await extraFields.count().catch(() => 0);
  if (extraCount > 1) {
    for (let i = 1; i < extraCount; i++) {
      const f = extraFields.nth(i);
      const val = await f.inputValue().catch(() => "");
      if (!val) await f.fill("Tài khoản giả mạo, vi phạm điều khoản Facebook.");
    }
  }

  // ── Select radio/checkbox if present ──
  const radios = page.locator('input[type="radio"]:visible');
  const radioCount = await radios.count().catch(() => 0);
  if (radioCount > 0) {
    let picked = false;
    for (const text of REASON_RADIO_TEXTS[reason]) {
      const label = page.locator(`label:has-text("${text}")`).first();
      if (await label.isVisible({ timeout: 700 }).catch(() => false)) {
        await label.click(); picked = true; break;
      }
    }
    if (!picked) await radios.first().click();
    await page.waitForTimeout(400);
  }

  // ── Submit ──
  const submitSels = [
    'button[type="submit"]',
    'input[type="submit"]',
    'div[role="button"]:has-text("Submit")',
    'div[role="button"]:has-text("Send")',
    'div[role="button"]:has-text("Continue")',
    'button:has-text("Submit")',
    'button:has-text("Send")',
    'button:has-text("Gửi")',
  ];

  let submitted = false;
  for (const sel of submitSels) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1200 }).catch(() => false)) {
      logger.info({ sel, formId: form.id }, "Clicking submit");
      await btn.click(); submitted = true; break;
    }
  }

  if (!submitted) {
    const shot = await dbgShot(page, `form_${form.id}_no_submit`);
    return { success: false, message: "Không tìm thấy nút Submit trên form", screenshot: shot };
  }

  await page.waitForTimeout(3000);

  const afterUrl  = page.url();
  const afterText = await page.locator("body").innerText().catch(() => "");
  const okWords   = ["thank", "received", "submitted", "review", "cảm ơn", "đã nhận", "đã gửi", "we'll review", "chúng tôi sẽ xem xét"];
  const isOk      = okWords.some((w) => afterText.toLowerCase().includes(w)) || afterUrl.includes("thank") || afterUrl.includes("submitted");

  if (isOk) {
    return { success: true, message: `Đã gửi thành công qua form ${form.id}` };
  }

  const shot = await dbgShot(page, `form_${form.id}_no_confirm`);
  return {
    success: false,
    message: `Không có xác nhận sau khi submit (url: ${afterUrl})`,
    screenshot: shot,
  };
}

// ─── Strategy A: Submit to ALL help-contact forms ───────────────────────────
async function strategyAllHelpForms(
  page: Page,
  profileUrl: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string; formResults: FormResult[] }> {
  const forms = getFormsForReason(reason);
  logger.info({ count: forms.length, reason }, "[A] Submitting to all help forms");

  const formResults: FormResult[] = [];
  let lastShot: string | undefined;

  for (const form of forms) {
    const r = await submitOneHelpForm(page, form, profileUrl, reason);
    formResults.push({ formId: form.id, label: form.label, success: r.success, message: r.message });
    if (!r.success && r.screenshot) lastShot = r.screenshot;
    // Small delay between forms to avoid rate limiting
    await page.waitForTimeout(1500);
  }

  const successCount = formResults.filter((r) => r.success).length;
  const allLabels    = formResults.map((r) => `[${r.success ? "✓" : "✗"}] ${r.label}`).join(", ");

  if (successCount > 0) {
    return {
      success: true,
      message: `Đã gửi ${successCount}/${forms.length} form: ${allLabels}`,
      formResults,
    };
  }

  return {
    success: false,
    message: `Tất cả ${forms.length} form thất bại: ${allLabels}`,
    screenshot: lastShot,
    formResults,
  };
}

// ─── Strategy B: mbasic direct URL ─────────────────────────────────────────
async function strategyMbasic(
  page: Page,
  profileUrl: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  const username = extractUsername(profileUrl);
  logger.info({ url: `https://mbasic.facebook.com/${username}` }, "[B] mbasic");

  await page.goto(`https://mbasic.facebook.com/${username}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  if (page.url().includes("login") || page.url().includes("checkpoint")) {
    return { success: false, message: "[B] mbasic: chuyển hướng đến login" };
  }

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);

  const userId = await extractUserId(page);
  logger.info({ userId }, "[B] user ID");

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
  }
  if (!reportUrl) {
    const shot = await dbgShot(page, "B_no_url");
    return { success: false, message: `[B] Không tìm được URL report (userId=${userId})`, screenshot: shot };
  }

  await page.goto(reportUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  const texts = REASON_RADIO_TEXTS[reason];
  let selected = false;
  for (const text of texts) {
    const label = page.locator(`label`).filter({ hasText: new RegExp(text, "i") }).first();
    if (await label.isVisible({ timeout: 1000 }).catch(() => false)) { await label.click(); selected = true; break; }
  }
  if (!selected) {
    const first = page.locator('input[type="radio"]').first();
    if (await first.isVisible({ timeout: 1500 }).catch(() => false)) { await first.click(); selected = true; }
  }
  if (!selected) {
    const shot = await dbgShot(page, "B_no_radio");
    return { success: false, message: "[B] Không tìm thấy radio button trên mbasic form", screenshot: shot };
  }

  await page.waitForTimeout(400);
  const submit = page.locator('input[type="submit"], button[type="submit"], input[value="Continue"], input[value="Tiếp tục"]').first();
  if (!await submit.isVisible({ timeout: 2000 }).catch(() => false)) {
    const shot = await dbgShot(page, "B_no_submit");
    return { success: false, message: "[B] Không tìm thấy nút Submit trên mbasic", screenshot: shot };
  }
  await submit.click();
  await page.waitForTimeout(2000);
  for (let s = 0; s < 3; s++) {
    const more = page.locator('input[type="submit"], button[type="submit"]').first();
    if (await more.isVisible({ timeout: 1000 }).catch(() => false)) { await more.click(); await page.waitForTimeout(1400); }
    else break;
  }

  return { success: true, message: "[B] Đã báo cáo qua mbasic" };
}

// ─── Strategy C: Desktop 3-dot menu ────────────────────────────────────────
async function strategyDesktop(
  page: Page,
  profileUrl: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string }> {
  logger.info({ url: profileUrl }, "[C] Desktop");
  await page.goto(profileUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);

  const moreClicked = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll<HTMLElement>('[aria-label="More"], [aria-label="Thêm"]'))
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.y > 150 && r.y < 600; })
      .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y);
    if (!cands.length) return false;
    cands[0].click(); return true;
  });

  if (!moreClicked) {
    const shot = await dbgShot(page, "C_no_more");
    return { success: false, message: "[C] Không tìm thấy nút (...) trên profile", screenshot: shot };
  }

  await page.waitForTimeout(1500);
  const menuTexts = await page.locator('[role="menuitem"]').allInnerTexts().catch(() => [] as string[]);

  const menuClicked = await page.evaluate(() => {
    for (const item of Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))) {
      if (/report|báo cáo/i.test(item.textContent ?? "")) { item.click(); return item.textContent?.trim() ?? "clicked"; }
    }
    return null;
  });

  if (!menuClicked) {
    const shot = await dbgShot(page, "C_no_report_menu");
    return { success: false, message: `[C] Menu không có item báo cáo. Items: [${menuTexts.join(" | ")}]`, screenshot: shot };
  }

  await page.waitForTimeout(2000);
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 }).catch(() => {});

  let reasonClicked = false;
  for (const text of REASON_RADIO_TEXTS[reason]) {
    for (const sel of [`[role="radio"]:has-text("${text}")`, `label:has-text("${text}")`]) {
      const el = page.locator(`[role="dialog"] ${sel}`).first();
      if (await el.isVisible({ timeout: 700 }).catch(() => false)) { await el.click(); reasonClicked = true; break; }
    }
    if (reasonClicked) break;
  }
  if (!reasonClicked) {
    const first = page.locator('[role="dialog"] [role="radio"]').first();
    if (await first.isVisible({ timeout: 1500 }).catch(() => false)) { await first.click(); reasonClicked = true; }
  }
  if (!reasonClicked) {
    const shot = await dbgShot(page, "C_no_reason");
    return { success: false, message: "[C] Không chọn được lý do trong dialog", screenshot: shot };
  }

  await page.waitForTimeout(700);
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
      await btn.click(); await page.waitForTimeout(1400);
    } else break;
  }
  const done = page.locator('[role="dialog"] div[role="button"]:has-text("Done"), [aria-label="Close"]').first();
  if (await done.isVisible({ timeout: 3000 }).catch(() => false)) await done.click();

  return { success: true, message: `[C] Đã báo cáo qua menu desktop ("${menuClicked}")` };
}

// ─── Main dispatcher ────────────────────────────────────────────────────────
async function reportProfile(
  page: Page,
  url: string,
  reason: ReportReason
): Promise<{ success: boolean; message: string; screenshot?: string; formResults?: FormResult[] }> {
  // A: All official help-contact forms (highest priority)
  const a = await strategyAllHelpForms(page, url, reason);
  if (a.success) { logger.info({ url }, "A succeeded"); return a; }
  logger.warn({ url, msg: a.message }, "A failed → B");

  // B: mbasic direct URL
  const b = await strategyMbasic(page, url, reason);
  if (b.success) { logger.info({ url }, "B succeeded"); return { ...b, formResults: a.formResults }; }
  logger.warn({ url, msg: b.message }, "B failed → C");

  // C: Desktop 3-dot menu
  const c = await strategyDesktop(page, url, reason);
  if (c.success) { logger.info({ url }, "C succeeded"); return { ...c, formResults: a.formResults }; }
  logger.warn({ url }, "All strategies failed");

  return {
    success: false,
    message: `A: ${a.message} | B: ${b.message} | C: ${c.message}`,
    screenshot: c.screenshot ?? b.screenshot ?? a.screenshot,
    formResults: a.formResults,
  };
}

function countResults(job: ReportJob) {
  job.reportedCount = job.results.filter((r) => r.status === "success").length;
  job.failedCount   = job.results.filter((r) => r.status === "failed").length;
}

// ─── ReportEngine ────────────────────────────────────────────────────────────
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
        headless: true,
        executablePath: CHROMIUM_PATH,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
               "--disable-blink-features=AutomationControlled", "--window-size=1280,900"],
      });

      const cookies = parseCookies(options.cookies);
      logger.info({ names: cookies.map((c) => c.name) }, "Cookies loaded");

      ctx = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
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

      if (page.url().includes("/login") || page.url().includes("checkpoint")) {
        const shot = await dbgShot(page, "login_failed");
        const msg = "Cookie Facebook không hợp lệ hoặc đã hết hạn";
        for (const r of job.results) { r.status = "failed"; r.message = msg; r.screenshot = shot; r.timestamp = new Date().toISOString(); }
        job.status = "failed"; job.error = msg; job.finishedAt = new Date().toISOString(); countResults(job);
        return;
      }
      logger.info({ jobId: job.jobId }, "Login OK");

      for (let i = 0; i < job.results.length; i++) {
        const result = job.results[i];
        logger.info({ url: result.url, n: `${i + 1}/${job.total}` }, "Reporting");

        const { success, message, screenshot, formResults } = await reportProfile(page, result.url, options.reason);
        result.status    = success ? "success" : "failed";
        result.message   = message;
        if (screenshot) result.screenshot = screenshot;
        result.timestamp = new Date().toISOString();
        if (formResults) {
          result.formResults    = formResults;
          result.formsSubmitted = formResults.filter((f) => f.success).length;
          result.formsFailed    = formResults.filter((f) => !f.success).length;
        }
        job.done = i + 1;
        countResults(job);
        logger.info({ url: result.url, success, formsSubmitted: result.formsSubmitted }, "Result");

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
