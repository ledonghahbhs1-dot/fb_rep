import { useState, useRef } from "react";
import type { ReportReason } from "../lib/api";

interface Props {
  mode: "manual" | "file";
  loading: boolean;
  onSubmitManual: (cookies: string, profileUrls: string[], reason: ReportReason) => void;
  onSubmitFile: (cookies: string, reason: ReportReason, file: File) => void;
}

const REASON_OPTIONS: { value: ReportReason; label: string }[] = [
  { value: "fake", label: "Tài khoản giả mạo" },
  { value: "impersonating", label: "Mạo danh người khác" },
  { value: "spam", label: "Spam" },
  { value: "pretending", label: "Giả vờ là người khác" },
];

export function ReportForm({ mode, loading, onSubmitManual, onSubmitFile }: Props) {
  const [cookies, setCookies] = useState("");
  const [urlsText, setUrlsText] = useState("");
  const [reason, setReason] = useState<ReportReason>("fake");
  const [file, setFile] = useState<File | null>(null);
  const [showCookies, setShowCookies] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const urls = urlsText
      .split(/[\n,;]+/)
      .map((u) => u.trim())
      .filter((u) => u.startsWith("http"));
    if (!cookies.trim()) return alert("Vui lòng nhập Facebook cookies");
    if (urls.length === 0) return alert("Vui lòng nhập ít nhất 1 URL hợp lệ");
    onSubmitManual(cookies, urls, reason);
  };

  const handleFileSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cookies.trim()) return alert("Vui lòng nhập Facebook cookies");
    if (!file) return alert("Vui lòng chọn file");
    onSubmitFile(cookies, reason, file);
  };

  return (
    <form onSubmit={mode === "manual" ? handleManualSubmit : handleFileSubmit} className="space-y-5">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Facebook Cookies <span className="text-red-500">*</span>
        </label>
        <div className="relative">
          <textarea
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 pr-20"
            rows={3}
            placeholder="Dán cookie từ trình duyệt vào đây (ví dụ: c_user=...; xs=...)"
            value={showCookies ? cookies : cookies ? "•".repeat(Math.min(cookies.length, 60)) : ""}
            onChange={(e) => {
              if (showCookies) setCookies(e.target.value);
            }}
            onFocus={() => setShowCookies(true)}
            onBlur={() => setShowCookies(false)}
            required
          />
          <button
            type="button"
            className="absolute right-2 top-2 text-xs text-blue-600 hover:underline"
            onClick={() => setShowCookies((v) => !v)}
          >
            {showCookies ? "Ẩn" : "Hiện"}
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          Lấy cookie từ Facebook bằng cách mở DevTools → Application → Cookies → facebook.com → Copy tất cả
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Lý do report</label>
        <select
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={reason}
          onChange={(e) => setReason(e.target.value as ReportReason)}
        >
          {REASON_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {mode === "manual" && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            URL tài khoản cần report <span className="text-red-500">*</span>
          </label>
          <textarea
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            rows={6}
            placeholder={"https://www.facebook.com/profile.php?id=...\nhttps://www.facebook.com/username\nhttps://www.facebook.com/..."}
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            required
          />
          <p className="text-xs text-gray-400 mt-1">
            Mỗi URL một dòng, hoặc phân cách bằng dấu phẩy/chấm phẩy
          </p>
          {urlsText && (
            <p className="text-xs text-blue-600 mt-1">
              {urlsText.split(/[\n,;]+/).filter((u) => u.trim().startsWith("http")).length} URL hợp lệ
            </p>
          )}
        </div>
      )}

      {mode === "file" && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            File danh sách URL <span className="text-red-500">*</span>
          </label>
          <div
            className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center cursor-pointer hover:border-blue-400 transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            {file ? (
              <div className="space-y-1">
                <p className="text-sm font-medium text-gray-700">{file.name}</p>
                <p className="text-xs text-gray-400">{(file.size / 1024).toFixed(1)} KB</p>
                <button
                  type="button"
                  className="text-xs text-red-500 hover:underline"
                  onClick={(e) => { e.stopPropagation(); setFile(null); if (fileRef.current) fileRef.current.value = ""; }}
                >
                  Xóa file
                </button>
              </div>
            ) : (
              <div className="space-y-1">
                <svg className="w-8 h-8 mx-auto text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p className="text-sm text-gray-500">Kéo thả hoặc click để chọn file</p>
                <p className="text-xs text-gray-400">.txt hoặc .csv — mỗi dòng một URL</p>
              </div>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed text-white font-medium py-2.5 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
      >
        {loading && (
          <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        {loading ? "Đang khởi động..." : "Bắt đầu Report"}
      </button>
    </form>
  );
}
