#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""启动带调试端口的 Chrome，并自动进入第二步。

流程：
  - 如果调试端口已经在监听，直接复用；
  - 否则启动 Chrome 并打开 BOSS 职位页；
  - Chrome 就绪后自动执行 run_job_queue.py，默认 --stage all（浏览采集 + 页面内沟通）；
  - 只想采集时加 --stage collect；未登录时由 run_job_queue.py 在终端提示登录。

用法:
  python start_chrome.py                  # 启动/复用 Chrome，然后浏览采集 + 主动沟通
  python start_chrome.py --stage collect  # 只浏览采集，不主动沟通
  python start_chrome.py --no-run         # 只启动 Chrome，不自动执行第二步
  python start_chrome.py --port 9222 --profile .chrome-profile
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_PROFILE = BASE_DIR / ".chrome-profile"
DEFAULT_URL = "https://www.zhipin.com/web/geek/jobs"


def find_chrome_exe() -> str:
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        rf"C:\Users\{os.environ.get('USERNAME', '')}\AppData\Local\Google\Chrome\Application\chrome.exe",
    ]
    for path in candidates:
        if Path(path).is_file():
            return path
    return shutil.which("chrome.exe") or "chrome.exe"


def cdp_version(cdp_url: str, timeout: float = 2) -> dict | None:
    """读取 /json/version；端口未就绪时返回 None。"""
    try:
        with urllib.request.urlopen(f"{cdp_url.rstrip('/')}/json/version", timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 - 连接失败即视为未就绪
        return None


def launch_chrome(chrome: str, port: int, profile: Path, url: str) -> None:
    args = [
        chrome,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        url,
    ]
    print("启动命令：")
    print("  " + " ".join(f'"{item}"' if " " in item else item for item in args))
    kwargs: dict = {}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        **kwargs,
    )


def run_second_step(port: int, extra_args: list[str]) -> int:
    """自动执行第二步；未登录会在第二步里提示登录。"""
    args = list(extra_args)
    if not any(item == "--stage" or item.startswith("--stage=") for item in args):
        args = ["--stage", "all", *args]
    command = [
        sys.executable,
        str(BASE_DIR / "run_job_queue.py"),
        "--cdp-url",
        f"http://127.0.0.1:{port}",
        *args,
    ]
    print("\n[第二步] 自动执行：")
    print("  " + " ".join(f'"{item}"' if " " in item else item for item in command))
    print()
    sys.stdout.flush()
    return subprocess.call(command, cwd=str(BASE_DIR))


def main() -> int:
    parser = argparse.ArgumentParser(description="启动 Chrome 并自动进入采集/穿插发送流程")
    parser.add_argument("--port", type=int, default=9222, help="调试端口，默认 9222")
    parser.add_argument("--profile", default=str(DEFAULT_PROFILE), help="Chrome 独立用户目录")
    parser.add_argument("--url", default=DEFAULT_URL, help="打开并用于采集的职位页")
    parser.add_argument("--wait", type=float, default=30, help="等待调试端口就绪的秒数")
    parser.add_argument("--no-run", action="store_true", help="只启动 Chrome，不自动执行第二步")
    args, extra = parser.parse_known_args()

    cdp_url = f"http://127.0.0.1:{args.port}"
    version = cdp_version(cdp_url)
    if version:
        print(f"[复用] 调试端口已在监听：{cdp_url}（{version.get('Browser')}）")
        if args.no_run:
            print("已跳过第二步；需要时执行：python run_job_queue.py")
            return 0
        return run_second_step(args.port, extra)

    chrome = find_chrome_exe()
    if not Path(chrome).is_file():
        print(f"[错误] 找不到 Chrome 可执行文件：{chrome}", file=sys.stderr)
        return 1

    profile = Path(args.profile).resolve()
    profile.mkdir(parents=True, exist_ok=True)
    launch_chrome(chrome, args.port, profile, args.url)

    deadline = time.monotonic() + args.wait
    while time.monotonic() < deadline:
        version = cdp_version(cdp_url)
        if version:
            print(f"\n[就绪] {cdp_url}（{version.get('Browser')}）")
            print(f"[页面] {args.url}")
            if args.no_run:
                print("\n已跳过第二步；需要时执行：python run_job_queue.py")
                return 0
            time.sleep(1.5)  # 给页面一点加载时间
            return run_second_step(args.port, extra)
        time.sleep(0.5)

    print(f"[错误] {args.wait:g}s 内调试端口未就绪：{cdp_url}", file=sys.stderr)
    print("如果该 profile 已有 Chrome 在运行（没有调试端口），请先完全退出它再重试。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
