import { chromium, Browser, BrowserContext, Page } from "playwright";
import { pino } from "pino";
import fs from "fs";
import path from "path";

const logger = pino({ level: "info" });
const SCREENSHOT_DIR = "/tmp/fb-screenshots";
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ─── Types ───────────────────────────────────────────────────────────────────
export type ReportReason   = "fake" | "impersonating" | "spam" | "pretending";
export type AccountStatus  = "active" | "removed" | "restricted" | "unknown";

export interface ReportJobOptions {
  cookies:     string;
  profileUrls: string[];
  reason:      ReportReason;
  continuous?: boolean;   // loop indefinitely until stopped
}

export interface FormResult {
  formId:  string;
  label:   string;
  success: boolean;
  message: string;
}

export interface ReportResult {
  url:            string;
  status:         "pending" | "success" | "failed" | "skipped";
  message?:       string;
  screenshot?:    string;
  timestamp?:     string;
  formResults?:   FormResult[];
  formsSubmitted?: number;
  formsFailed?:   number;
}

export interface ReportJob {
  jobId:         string;
  status:        "running" | "completed" | "failed" | "stopped";
  total:         number;
  done:          number;
  reportedCount: number;
  failedCount:   number;
  results:       ReportResult[];
  startedAt:     string;
  finishedAt?:   string;
  error?:        string;
  // Continuous mode
  continuous?:      boolean;
  round?:           number;
  totalRounds?:     number;
  totalReported?:   number;
  totalFailed?:     number;
}

export interface StatusCheckOptions {
  cookies?:    string;
  profileUrls: string[];
}

export interface StatusCheckResult {
  url:       string;
  status:    AccountStatus;
  message:   string;
  timestamp: string;
}

export interface StatusCheckJob {
  jobId:      string;
  status:     "running" | "completed" | "failed";
  total:      number;
  done:       number;
  results:    StatusCheckResult[];
  startedAt:  string;
  finishedAt?: string;
  error?:     string;
}

// ─── Config ──────────────────────────────────────────────────────────────────
const CHROMIUM_PATH: string | undefined =
  process.env.CHROMIUM_PATH ??
  (process.env.REPL_ID
    ? "/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome"
    : undefined);

interface HelpForm { id: string; label: string; reasons: ReportReason[]; }
const ALL_HELP_FORMS: HelpForm[] = [
  { id: "295309487309948",   label: "Báo cáo tài khoản giả mạo",         reasons: ["fake", "impersonating", "pretending"] },
  { id: "1758255661104383",  label: "Báo cáo mạo danh người khác",        reasons: ["impersonating", "pretending", "fake"] },
  { id: "274459462613911",   label: "Báo cáo vi phạm điều khoản / spam",  reasons: ["spam", "fake", "impersonating", "pretending"] },
  { id: "485974059259751",   label: "Báo cáo trang cá nhân",              reasons: ["fake", "impersonating", "pretending", "spam"] },
  { id: "144059062408922",   label: "Báo cáo tài khoản",                  reasons: ["fake", "impersonating", "pretending", "spam"] },
  { id: "228813257197480",   label: "Báo cáo nội dung vi phạm",           reasons: ["fake", "impersonating", "pretending", "spam"] },
];

const REASON_CREP: Record<ReportReason, string> = { fake: "0", impersonating: "1", spam: "2", pretending: "0" };
const REASON_RADIO_TEXTS: Record<ReportReason, string[]> = {
  fake:          ["Fake account", "It\u2019s a fake account", "T\u00e0i kho\u1ea3n gi\u1ea3"],
  impersonating: ["Pretending to be me", "It\u2019s pretending to be me", "Impersonat", "M\u1ea1o danh"],
  spam:          ["Spam", "It\u2019s spam", "Spam t\u00e0i kho\u1ea3n"],
  pretending:    ["Pretending to be someone", "It\u2019s pretending to be", "Gi\u1ea3 v\u1edd"],
};

const REMOVED_KEYWORDS = [
  "this content isn't available", "page you requested cannot be displayed",
  "this page isn't available", "sorry, this page isn't available",
  "content not found", "trang bạn yêu cầu không tồn tại",
  "không tìm thấy trang", "this account doesn't exist", "tài khoản này không tồn tại",
];
const RESTRICTED_KEYWORDS = [
  "temporarily blocked", "account is restricted", "your account has been restricted",
  "tài khoản bị hạn chế", "this account is restricted",
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function parseCookies(raw: string) {
  return raw.split(";").map(p => p.trim()).filter(Boolean).map(pair => {
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

async function launchBrowser(withCookies?: string) {
  const browser = await chromium.launch({
    headless: true, executablePath: CHROMIUM_PATH,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
           "--disable-blink-features=AutomationControlled","--window-size=1280,900"],
  });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "en-US", viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });
  if (withCookies) await ctx.addCookies(parseCookies(withCookies));
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    // @ts-ignore
    window.chrome = { runtime: {} };
  });
  return { browser, ctx, page };
}

// ─── Account Status Check ────────────────────────────────────────────────────
async function checkProfileStatus(page: Page, url: string): Promise<{ status: AccountStatus; message: string }> {
  const username = extractUsername(url);
  const mbasicUrl = `https://mbasic.facebook.com/${username}`;

  try {
    await page.goto(mbasicUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1500);
  } catch {
    return { status: "unknown", message: "Timeout khi truy cập trang" };
  }

  const currentUrl = page.url();
  const bodyText   = await page.locator("body").innerText().catch(() => "");
  const bodyLower  = bodyText.toLowerCase();
  const titleText  = await page.title().catch(() => "");

  // Redirected to login — we just check without auth
  if (currentUrl.includes("/login") || currentUrl.includes("checkpoint")) {
    // Try without any indication from URL itself, fall back to www
    try {
      await page.goto(`https://www.facebook.com/${username}`, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(2000);
      const wwwBody  = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
      const wwwTitle = await page.title().catch(() => "");
      if (REMOVED_KEYWORDS.some(k => wwwBody.includes(k.toLowerCase()))) {
        return { status: "removed", message: "Tài khoản đã bị xóa hoặc vô hiệu hóa" };
      }
      if (RESTRICTED_KEYWORDS.some(k => wwwBody.includes(k.toLowerCase()))) {
        return { status: "restricted", message: "Tài khoản đang bị hạn chế" };
      }
      const hasProfile = await page.locator('[data-pagelet="ProfileTimeline"], [data-pagelet="ProfileActions"]').count();
      if (hasProfile > 0) return { status: "active", message: "Tài khoản vẫn còn hoạt động" };
      if (wwwTitle && wwwTitle !== "Facebook" && !wwwTitle.toLowerCase().includes("error")) {
        return { status: "active", message: `Tài khoản vẫn còn hoạt động (${wwwTitle})` };
      }
      return { status: "unknown", message: "Cần đăng nhập để kiểm tra chính xác hơn" };
    } catch {
      return { status: "unknown", message: "Không thể kiểm tra — vui lòng cung cấp cookie" };
    }
  }

  if (REMOVED_KEYWORDS.some(k => bodyLower.includes(k.toLowerCase()))) {
    return { status: "removed", message: "Tài khoản đã bị xóa hoặc vô hiệu hóa" };
  }
  if (RESTRICTED_KEYWORDS.some(k => bodyLower.includes(k.toLowerCase()))) {
    return { status: "restricted", message: "Tài khoản đang bị hạn chế" };
  }

  // Check for a real profile: mbasic shows name and profile sections
  const hasTimeline = await page.locator('a[href*="timeline"], a[href*="friends"], a[href*="photos"]').count().catch(() => 0);
  const hasName     = await page.locator('h1, h2, strong').first().innerText().catch(() => "");

  if (hasTimeline > 0 || (hasName && hasName.length > 2)) {
    return { status: "active", message: `Tài khoản vẫn còn hoạt động${hasName ? ` (${hasName})` : ""}` };
  }
  if (bodyText.length > 300) {
    return { status: "active", message: "Tài khoản vẫn còn hoạt động" };
  }

  return { status: "unknown", message: "Không xác định được trạng thái" };
}

// ─── Strategy A: all official help-contact forms ─────────────────────────────
async function submitOneHelpForm(page: Page, form: HelpForm, profileUrl: string, reason: ReportReason): Promise<{ success: boolean; message: string; screenshot?: string }> {
  const formUrl = `https://www.facebook.com/help/contact/${form.id}`;
  await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  if (page.url().includes("login") || page.url().includes("checkpoint"))
    return { success: false, message: "Cookie không hợp lệ — chuyển hướng login" };

  const heading = await page.locator("h1, h2, [role='heading']").first().innerText().catch(() => "");
  const urlSels = ['input[placeholder*="link" i]','input[placeholder*="url" i]','input[placeholder*="profile" i]',
                   'input[placeholder*="account" i]','input[placeholder*="http" i]','input[name*="url" i]',
                   'input[name*="link" i]','input[type="url"]','input[type="text"]','textarea'];

  let filled = false;
  for (const sel of urlSels) {
    const inputs = page.locator(sel);
    const count  = await inputs.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i);
      if (await input.isVisible({ timeout: 600 }).catch(() => false)) {
        await input.click(); await input.fill(profileUrl); filled = true; break;
      }
    }
    if (filled) break;
  }
  if (!filled) {
    const shot = await dbgShot(page, `form_${form.id}_no_input`);
    return { success: false, message: `Không tìm thấy ô nhập URL (heading: "${heading}")`, screenshot: shot };
  }

  await page.waitForTimeout(400);
  const extra = page.locator('input[type="text"]:visible, textarea:visible');
  const ec = await extra.count().catch(() => 0);
  for (let i = 1; i < ec; i++) {
    const f = extra.nth(i);
    if (!await f.inputValue().catch(() => "")) await f.fill("Tài khoản giả mạo, vi phạm điều khoản Facebook.");
  }

  const radios = page.locator('input[type="radio"]:visible');
  if (await radios.count().catch(() => 0) > 0) {
    let picked = false;
    for (const text of REASON_RADIO_TEXTS[reason]) {
      const label = page.locator(`label:has-text("${text}")`).first();
      if (await label.isVisible({ timeout: 700 }).catch(() => false)) { await label.click(); picked = true; break; }
    }
    if (!picked) await radios.first().click();
    await page.waitForTimeout(400);
  }

  const submitSels = ['button[type="submit"]','input[type="submit"]',
    'div[role="button"]:has-text("Submit")','div[role="button"]:has-text("Send")',
    'button:has-text("Submit")','button:has-text("Send")','button:has-text("Gửi")'];
  let submitted = false;
  for (const sel of submitSels) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1200 }).catch(() => false)) { await btn.click(); submitted = true; break; }
  }
  if (!submitted) {
    const shot = await dbgShot(page, `form_${form.id}_no_submit`);
    return { success: false, message: "Không tìm thấy nút Submit", screenshot: shot };
  }

  await page.waitForTimeout(3000);
  const afterText = await page.locator("body").innerText().catch(() => "");
  const afterUrl  = page.url();
  const okWords   = ["thank","received","submitted","review","cảm ơn","đã nhận","đã gửi","we'll review","chúng tôi sẽ xem xét"];
  if (okWords.some(w => afterText.toLowerCase().includes(w)) || afterUrl.includes("thank") || afterUrl.includes("submitted"))
    return { success: true, message: `Gửi thành công form #${form.id}` };

  const shot = await dbgShot(page, `form_${form.id}_no_confirm`);
  return { success: false, message: `Không có xác nhận sau submit (url: ${afterUrl})`, screenshot: shot };
}

async function strategyAllHelpForms(page: Page, profileUrl: string, reason: ReportReason): Promise<{ success: boolean; message: string; screenshot?: string; formResults: FormResult[] }> {
  const forms = ALL_HELP_FORMS.filter(f => f.reasons.includes(reason));
  const formResults: FormResult[] = [];
  let lastShot: string | undefined;
  for (const form of forms) {
    const r = await submitOneHelpForm(page, form, profileUrl, reason);
    formResults.push({ formId: form.id, label: form.label, success: r.success, message: r.message });
    if (!r.success && r.screenshot) lastShot = r.screenshot;
    await page.waitForTimeout(1500);
  }
  const ok = formResults.filter(r => r.success).length;
  const labels = formResults.map(r => `[${r.success ? "✓" : "✗"}] ${r.label}`).join(", ");
  if (ok > 0) return { success: true, message: `Đã gửi ${ok}/${forms.length} form: ${labels}`, formResults };
  return { success: false, message: `Tất cả ${forms.length} form thất bại: ${labels}`, screenshot: lastShot, formResults };
}

async function strategyMbasic(page: Page, profileUrl: string, reason: ReportReason): Promise<{ success: boolean; message: string; screenshot?: string }> {
  const username = extractUsername(profileUrl);
  await page.goto(`https://mbasic.facebook.com/${username}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);
  if (page.url().includes("login") || page.url().includes("checkpoint"))
    return { success: false, message: "[B] mbasic: chuyển hướng login" };

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1000);
  const userId = await extractUserId(page);

  const reportHref = await page.evaluate((): string | null => {
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a"))) {
      const href = a.getAttribute("href") ?? "", text = (a.textContent ?? "").trim().toLowerCase();
      if ((text === "report" || text === "báo cáo" || /^report/.test(text)) && href.length > 1) return a.href;
    }
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>("a"))) {
      const href = a.href ?? "";
      if (href.includes("/report/") && (href.includes("ctype") || href.includes("content_id"))) return href;
    }
    return null;
  });

  let reportUrl = reportHref;
  if (!reportUrl && userId) {
    reportUrl = `https://mbasic.facebook.com/report/?ctype=1&crep=${REASON_CREP[reason]}&content_id=${userId}&source=profile_actions&from_untrusted=1`;
  }
  if (!reportUrl) {
    const shot = await dbgShot(page, "B_no_url");
    return { success: false, message: `[B] Không tìm được report URL (userId=${userId})`, screenshot: shot };
  }

  await page.goto(reportUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);

  let selected = false;
  for (const text of REASON_RADIO_TEXTS[reason]) {
    const label = page.locator("label").filter({ hasText: new RegExp(text, "i") }).first();
    if (await label.isVisible({ timeout: 1000 }).catch(() => false)) { await label.click(); selected = true; break; }
  }
  if (!selected) {
    const first = page.locator('input[type="radio"]').first();
    if (await first.isVisible({ timeout: 1500 }).catch(() => false)) { await first.click(); selected = true; }
  }
  if (!selected) {
    const shot = await dbgShot(page, "B_no_radio");
    return { success: false, message: "[B] Không tìm thấy radio button", screenshot: shot };
  }

  await page.waitForTimeout(400);
  const submit = page.locator('input[type="submit"], button[type="submit"]').first();
  if (!await submit.isVisible({ timeout: 2000 }).catch(() => false)) {
    const shot = await dbgShot(page, "B_no_submit");
    return { success: false, message: "[B] Không tìm thấy Submit", screenshot: shot };
  }
  await submit.click(); await page.waitForTimeout(2000);
  for (let s = 0; s < 3; s++) {
    const more = page.locator('input[type="submit"], button[type="submit"]').first();
    if (await more.isVisible({ timeout: 1000 }).catch(() => false)) { await more.click(); await page.waitForTimeout(1400); }
    else break;
  }
  return { success: true, message: "[B] Đã báo cáo qua mbasic" };
}

async function reportProfile(page: Page, url: string, reason: ReportReason): Promise<{ success: boolean; message: string; screenshot?: string; formResults?: FormResult[] }> {
  const a = await strategyAllHelpForms(page, url, reason);
  if (a.success) return a;
  const b = await strategyMbasic(page, url, reason);
  if (b.success) return { ...b, formResults: a.formResults };
  return { success: false, message: `A: ${a.message} | B: ${b.message}`, screenshot: b.screenshot ?? a.screenshot, formResults: a.formResults };
}

function countResults(job: ReportJob) {
  job.reportedCount = job.results.filter(r => r.status === "success").length;
  job.failedCount   = job.results.filter(r => r.status === "failed").length;
}

// ─── ReportEngine ─────────────────────────────────────────────────────────────
export class ReportEngine {
  private jobs     = new Map<string, ReportJob>();
  private stopFlags = new Set<string>();

  startJob(jobId: string, options: ReportJobOptions): void {
    const job: ReportJob = {
      jobId, status: "running",
      total: options.profileUrls.length, done: 0,
      reportedCount: 0, failedCount: 0,
      results:    options.profileUrls.map(url => ({ url, status: "pending" })),
      startedAt:  new Date().toISOString(),
      continuous: options.continuous ?? false,
      round:      1,
      totalRounds:   0,
      totalReported: 0,
      totalFailed:   0,
    };
    this.jobs.set(jobId, job);
    this.runJob(job, options).catch(err => {
      job.status = "failed"; job.error = String(err);
      job.finishedAt = new Date().toISOString(); countResults(job);
    });
  }

  stopJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "running") return false;
    this.stopFlags.add(jobId);
    return true;
  }

  private async runJob(job: ReportJob, options: ReportJobOptions): Promise<void> {
    let browser: Browser | undefined, ctx: BrowserContext | undefined;
    try {
      browser = await chromium.launch({
        headless: true, executablePath: CHROMIUM_PATH,
        args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
               "--disable-blink-features=AutomationControlled","--window-size=1280,900"],
      });
      const cookies = parseCookies(options.cookies);
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

      // verify login
      await page.goto("https://www.facebook.com", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2500);
      if (page.url().includes("/login") || page.url().includes("checkpoint")) {
        const shot = await dbgShot(page, "login_failed");
        const msg = "Cookie Facebook không hợp lệ hoặc đã hết hạn";
        for (const r of job.results) { r.status = "failed"; r.message = msg; r.screenshot = shot; r.timestamp = new Date().toISOString(); }
        job.status = "failed"; job.error = msg; job.finishedAt = new Date().toISOString(); countResults(job); return;
      }

      let keepRunning = true;
      while (keepRunning) {
        // reset this round
        job.done = 0;
        job.results = options.profileUrls.map(url => ({ url, status: "pending" as const }));

        for (let i = 0; i < options.profileUrls.length; i++) {
          const result = job.results[i];
          const { success, message, screenshot, formResults } = await reportProfile(page, result.url, options.reason);
          result.status    = success ? "success" : "failed";
          result.message   = message;
          if (screenshot) result.screenshot = screenshot;
          result.timestamp = new Date().toISOString();
          if (formResults) {
            result.formResults    = formResults;
            result.formsSubmitted = formResults.filter(f => f.success).length;
            result.formsFailed    = formResults.filter(f => !f.success).length;
          }
          job.done = i + 1;
          countResults(job);
          job.totalReported = (job.totalReported ?? 0) + (success ? 1 : 0);
          job.totalFailed   = (job.totalFailed   ?? 0) + (success ? 0 : 1);

          if (i < options.profileUrls.length - 1) {
            await page.waitForTimeout(5000 + Math.random() * 4000);
          }
        }

        job.totalRounds = (job.totalRounds ?? 0) + 1;

        // Stop?
        if (!options.continuous || this.stopFlags.has(job.jobId)) {
          keepRunning = false;
        } else {
          // Next round — brief pause between rounds
          job.round = (job.round ?? 1) + 1;
          logger.info({ jobId: job.jobId, round: job.round }, "Starting next round");
          await page.waitForTimeout(8000 + Math.random() * 5000);
        }
      }

      this.stopFlags.delete(job.jobId);
      job.status     = options.continuous && job.status === "running" ? "stopped" : "completed";
      job.finishedAt = new Date().toISOString();
      countResults(job);
    } finally {
      await ctx?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }

  getJob(jobId: string)    { return this.jobs.get(jobId); }
  getAllJobs()              { return [...this.jobs.values()].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()); }
  removeJob(jobId: string) { this.jobs.delete(jobId); this.stopFlags.delete(jobId); }
}

// ─── StatusCheckEngine ────────────────────────────────────────────────────────
export class StatusCheckEngine {
  private jobs = new Map<string, StatusCheckJob>();

  startJob(jobId: string, options: StatusCheckOptions): void {
    const job: StatusCheckJob = {
      jobId, status: "running",
      total: options.profileUrls.length, done: 0,
      results:   options.profileUrls.map(url => ({ url, status: "unknown" as AccountStatus, message: "Đang kiểm tra...", timestamp: "" })),
      startedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, job);
    this.runJob(job, options).catch(err => {
      job.status = "failed"; job.error = String(err); job.finishedAt = new Date().toISOString();
    });
  }

  private async runJob(job: StatusCheckJob, options: StatusCheckOptions): Promise<void> {
    let browser: Browser | undefined, ctx: BrowserContext | undefined;
    try {
      const { browser: b, ctx: c, page } = await launchBrowser(options.cookies);
      browser = b; ctx = c;

      for (let i = 0; i < options.profileUrls.length; i++) {
        const result = job.results[i];
        const { status, message } = await checkProfileStatus(page, result.url);
        result.status    = status;
        result.message   = message;
        result.timestamp = new Date().toISOString();
        job.done = i + 1;
        logger.info({ url: result.url, status, message }, "Status check result");
        if (i < options.profileUrls.length - 1) await page.waitForTimeout(2000);
      }

      job.status = "completed"; job.finishedAt = new Date().toISOString();
    } finally {
      await ctx?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }

  getJob(jobId: string)    { return this.jobs.get(jobId); }
  getAllJobs()              { return [...this.jobs.values()].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()); }
  removeJob(jobId: string) { this.jobs.delete(jobId); }
}
