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
from typing import Optional

API_BASE = "http://localhost:4000/api"


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
        dict với jobId và total
    """
    resp = requests.post(
        f"{base_url}/report",
        json={"cookies": cookies, "profileUrls": profile_urls, "reason": reason},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.json()


def start_report_from_file(
    cookies: str,
    file_path: str,
    reason: str = "fake",
    base_url: str = API_BASE,
) -> dict:
    """Bắt đầu job report từ file .txt hoặc .csv.

    Args:
        cookies: Facebook cookies
        file_path: Đường dẫn tới file chứa danh sách URL (mỗi dòng một URL)
        reason: Lý do report
        base_url: URL của API server

    Returns:
        dict với jobId và total
    """
    with open(file_path, "rb") as f:
        resp = requests.post(
            f"{base_url}/report/upload",
            data={"cookies": cookies, "reason": reason},
            files={"file": (file_path, f, "text/plain")},
            timeout=15,
        )
    resp.raise_for_status()
    return resp.json()


def get_job(job_id: str, base_url: str = API_BASE) -> dict:
    """Lấy trạng thái job.

    Args:
        job_id: ID của job
        base_url: URL của API server

    Returns:
        dict với thông tin chi tiết job
    """
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
    """Chờ cho đến khi job hoàn thành và in tiến độ.

    Args:
        job_id: ID của job
        base_url: URL của API server
        poll_interval: Số giây giữa mỗi lần poll
        verbose: In tiến độ ra màn hình

    Returns:
        Thông tin job cuối cùng
    """
    while True:
        job = get_job(job_id, base_url)
        if verbose:
            pct = int(job["done"] / max(job["total"], 1) * 100)
            success = sum(1 for r in job["results"] if r["status"] == "success")
            failed = sum(1 for r in job["results"] if r["status"] == "failed")
            bar = "█" * (pct // 5) + "░" * (20 - pct // 5)
            print(
                f"\r[{bar}] {pct}% | {job['done']}/{job['total']} | "
                f"✓{success} ✗{failed} | {job['status']}     ",
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
    print(f"\n{'=' * 60}")
    print(f"Job: {job['jobId']}")
    print(f"Trạng thái: {job['status']}")
    print(f"Tổng: {job['total']} | Xong: {job['done']}")
    print(f"{'=' * 60}")
    for r in job["results"]:
        icon = {"success": "✓", "failed": "✗", "pending": "○", "skipped": "−"}.get(
            r["status"], "?"
        )
        msg = f" — {r['message']}" if r.get("message") else ""
        print(f"  {icon} {r['url']}{msg}")
    if job.get("error"):
        print(f"\nLỗi: {job['error']}")
    print(f"{'=' * 60}\n")


if __name__ == "__main__":
    print("FB Fake Account Reporter — Python Client")
    print("=========================================\n")

    FB_COOKIES = input("Nhập Facebook cookies (c_user=...; xs=...): ").strip()
    if not FB_COOKIES:
        print("Cookies không được để trống.")
        sys.exit(1)

    print("\nChọn lý do report:")
    print("  1. fake         — Tài khoản giả mạo")
    print("  2. impersonating — Mạo danh người khác")
    print("  3. spam         — Spam")
    print("  4. pretending   — Giả vờ là người khác")
    reason_map = {"1": "fake", "2": "impersonating", "3": "spam", "4": "pretending"}
    reason_choice = input("Chọn (1-4, mặc định 1): ").strip() or "1"
    reason = reason_map.get(reason_choice, "fake")

    print("\nChọn cách nhập danh sách tài khoản:")
    print("  1. Nhập URL thủ công")
    print("  2. Upload từ file .txt / .csv")
    mode = input("Chọn (1 hoặc 2): ").strip()

    if mode == "2":
        file_path = input("Đường dẫn file: ").strip()
        print(f"\nĐang gửi file {file_path}...")
        result = start_report_from_file(FB_COOKIES, file_path, reason)
    else:
        print("\nNhập URL các tài khoản cần report (mỗi dòng 1 URL, dòng trống để kết thúc):")
        urls = []
        while True:
            line = input().strip()
            if not line:
                break
            if line.startswith("http"):
                urls.append(line)
        if not urls:
            print("Không có URL hợp lệ.")
            sys.exit(1)
        print(f"\nĐang bắt đầu report {len(urls)} tài khoản...")
        result = start_report(FB_COOKIES, urls, reason)

    job_id = result["jobId"]
    print(f"Job ID: {job_id} | Tổng: {result['total']} tài khoản\n")
    print("Đang theo dõi tiến độ...")

    final_job = wait_for_job(job_id)
    print_results(final_job)
