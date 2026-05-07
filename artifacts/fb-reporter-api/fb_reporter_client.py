"""
FB Fake Account Reporter - Python API Client
============================================
Gọi API để report tài khoản giả mạo Facebook từ Python.

Cài đặt:
    pip install requests

Sử dụng:
    python fb_reporter_client.py
"""

import requests
import time
import sys
from urllib.parse import unquote

# Local (Replit dev):  http://localhost:3001/api
# Railway production:  https://reportfb.up.railway.app/api
API_BASE = "https://reportfb.up.railway.app/api"


def build_cookie_string(c_user: str, xs: str, datr: str = "", fr: str = "", sb: str = "") -> str:
    """Ghép các cookie riêng lẻ thành chuỗi cookie hợp lệ.

    Tự động URL-decode giá trị nếu cần (ví dụ xs thường bị encode %3A → :)
    """
    parts = []
    if c_user:
        parts.append(f"c_user={c_user.strip()}")
    if xs:
        parts.append(f"xs={unquote(xs.strip())}")
    if datr:
        parts.append(f"datr={datr.strip()}")
    if fr:
        parts.append(f"fr={fr.strip()}")
    if sb:
        parts.append(f"sb={sb.strip()}")
    return "; ".join(parts)


def start_report(
    cookies: str,
    profile_urls: list[str],
    reason: str = "fake",
    base_url: str = API_BASE,
) -> dict:
    """Bắt đầu job report tài khoản giả mạo.

    Args:
        cookies: Facebook cookies (chuỗi c_user=...; xs=...)
        profile_urls: Danh sách URL trang cá nhân cần report
        reason: Lý do report - "fake" | "impersonating" | "spam" | "pretending"
        base_url: URL của API server

    Returns:
        dict với jobId, total, message
    """
    resp = requests.post(
        f"{base_url}/report",
        json={"cookies": cookies, "profileUrls": profile_urls, "reason": reason},
        timeout=15,
    )
    if not resp.ok:
        try:
            raise Exception(f"API error {resp.status_code}: {resp.json()}")
        except Exception:
            raise Exception(f"API error {resp.status_code}: {resp.text[:200]}")
    return resp.json()


def start_report_from_file(
    cookies: str,
    file_path: str,
    reason: str = "fake",
    base_url: str = API_BASE,
) -> dict:
    """Bắt đầu job report từ file .txt hoặc .csv."""
    with open(file_path, "rb") as f:
        resp = requests.post(
            f"{base_url}/report/upload",
            data={"cookies": cookies, "reason": reason},
            files={"file": (file_path, f, "text/plain")},
            timeout=15,
        )
    if not resp.ok:
        raise Exception(f"Upload error {resp.status_code}: {resp.text[:200]}")
    return resp.json()


def get_job(job_id: str, base_url: str = API_BASE) -> dict:
    """Lấy trạng thái job."""
    resp = requests.get(f"{base_url}/report/{job_id}", timeout=10)
    resp.raise_for_status()
    return resp.json()


def get_all_jobs(base_url: str = API_BASE) -> list[dict]:
    """Lấy danh sách tất cả jobs."""
    resp = requests.get(f"{base_url}/jobs", timeout=10)
    resp.raise_for_status()
    return resp.json()


def delete_job(job_id: str, base_url: str = API_BASE) -> None:
    """Xóa job khỏi danh sách."""
    requests.delete(f"{base_url}/jobs/{job_id}", timeout=10)


def wait_for_job(
    job_id: str,
    base_url: str = API_BASE,
    poll_interval: float = 3.0,
    verbose: bool = True,
) -> dict:
    """Chờ cho đến khi job hoàn thành và in tiến độ."""
    while True:
        job = get_job(job_id, base_url)
        if verbose:
            pct = int(job["done"] / max(job["total"], 1) * 100)
            reported = job.get("reportedCount", 0)
            failed = job.get("failedCount", 0)
            bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
            print(
                f"\r[{bar}] {pct}% | {job['done']}/{job['total']} | "
                f"✓ reported={reported}  ✗ failed={failed} | {job['status']}     ",
                end="",
                flush=True,
            )
        if job["status"] in ("completed", "failed"):
            if verbose:
                print()
            return job
        time.sleep(poll_interval)


def print_results(job: dict) -> None:
    """In kết quả report ra màn hình."""
    reported = job.get("reportedCount", sum(1 for r in job["results"] if r["status"] == "success"))
    failed = job.get("failedCount", sum(1 for r in job["results"] if r["status"] == "failed"))

    print(f"\n{'=' * 65}")
    print(f"Job ID  : {job['jobId']}")
    print(f"Trạng thái: {job['status'].upper()}")
    print(f"Tổng    : {job['total']}  |  ✓ Đã report: {reported}  |  ✗ Thất bại: {failed}")
    print(f"{'=' * 65}")
    for r in job["results"]:
        icon = {"success": "✓", "failed": "✗", "pending": "○", "skipped": "−"}.get(r["status"], "?")
        msg = f"  → {r['message']}" if r.get("message") else ""
        print(f"  {icon} {r['url']}{msg}")
    if job.get("error"):
        print(f"\n⚠ Lỗi: {job['error']}")
    print(f"{'=' * 65}\n")


def _prompt(label: str, required: bool = True) -> str:
    while True:
        val = input(f"[ + ] Enter {label}: ").strip()
        if val or not required:
            return val
        print("     (Bắt buộc, không được để trống)")


if __name__ == "__main__":
    print("=" * 65)
    print("  FB Fake Account Reporter — Python Client")
    print(f"  API: {API_BASE}")
    print("=" * 65 + "\n")

    print("── Nhập Cookie Facebook ──────────────────────────────────────")
    c_user = _prompt("c_user (Account ID - Required)")
    xs     = _prompt("xs (Session token - Required)")
    datr   = _prompt("datr (Device auth - Required)")
    fr     = _prompt("fr (Ad token - Recommended)", required=False)
    sb     = _prompt("sb (Secure browser - Recommended)", required=False)

    FB_COOKIES = build_cookie_string(c_user, xs, datr, fr, sb)
    print(f"\n✓ Cookie built: {FB_COOKIES[:60]}...\n")

    print("── Lý do report ──────────────────────────────────────────────")
    print("  1. fake          — Tài khoản giả mạo")
    print("  2. impersonating — Mạo danh người khác")
    print("  3. spam          — Spam")
    print("  4. pretending    — Giả vờ là người khác")
    reason_map = {"1": "fake", "2": "impersonating", "3": "spam", "4": "pretending"}
    reason_choice = input("Chọn (1-4, mặc định 1): ").strip() or "1"
    reason = reason_map.get(reason_choice, "fake")

    print("\n── Danh sách tài khoản cần report ───────────────────────────")
    print("  1. Nhập URL thủ công")
    print("  2. Upload từ file .txt / .csv")
    mode = input("Chọn (1 hoặc 2): ").strip()

    try:
        if mode == "2":
            file_path = _prompt("Đường dẫn file")
            print(f"\n⏳ Đang gửi file {file_path}...")
            result = start_report_from_file(FB_COOKIES, file_path, reason)
        else:
            print("\nNhập URL (mỗi dòng 1 URL, dòng trống để kết thúc):")
            urls = []
            while True:
                line = input().strip()
                if not line:
                    break
                if line.startswith("http"):
                    urls.append(line)
                else:
                    print(f"  ⚠ Bỏ qua (không phải URL): {line}")
            if not urls:
                print("Không có URL hợp lệ.")
                sys.exit(1)
            print(f"\n⏳ Đang bắt đầu report {len(urls)} tài khoản...")
            result = start_report(FB_COOKIES, urls, reason)

        job_id = result["jobId"]
        print(f"✅ Report job started:")
        print(f"   Job ID : {job_id}")
        print(f"   Tổng   : {result['total']} tài khoản\n")
        print("Đang theo dõi tiến độ (Ctrl+C để thoát)...")

        final_job = wait_for_job(job_id)
        print_results(final_job)

    except KeyboardInterrupt:
        print("\n\nĐã thoát. Job vẫn đang chạy trên server.")
    except Exception as e:
        print(f"\n❌ Lỗi: {e}")
        sys.exit(1)
