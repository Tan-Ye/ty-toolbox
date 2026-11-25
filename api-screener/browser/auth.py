#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""登录状态检查、token 读取与 CDP 客户端工厂。"""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.request
from pathlib import Path

from browser.cdp_client import CdpFetchClient
from core.config import AUTH_FILE


def load_auth(
    token: str | None = None,
    zp_token: str | None = None,
    auth_file: str | Path = AUTH_FILE,
) -> tuple[str | None, str | None]:
    token = token or os.environ.get("ZP_HEADER_TOKEN")
    zp_token = zp_token or os.environ.get("ZP_HEADER_ZP_TOKEN")
    auth_path = Path(auth_file)
    if auth_path.is_file():
        data = json.loads(auth_path.read_text(encoding="utf-8"))
        token = token or data.get("token")
        zp_token = zp_token or data.get("zp_token")
        try:
            age_hours = (time.time() - auth_path.stat().st_mtime) / 3600
        except OSError:
            age_hours = 0
        if (data.get("token") or data.get("zp_token")) and age_hours >= 12:
            print(
                f"[提示] {auth_path.name} 已 {age_hours:.0f} 小时未更新，"
                "token 可能已过期；发送失败时请删除该文件。"
            )
    return token, zp_token


def is_logged_in(probe: dict, token: str | None = None, zp_token: str | None = None) -> bool:
    """有 bst 或页面 token 视为已登录；手动指定 token+zp_token 也可继续。"""
    if probe.get("hasBst") or probe.get("tokenCandidates"):
        return True
    return bool(token and zp_token)


def check_login(args: argparse.Namespace, token: str | None, zp_token: str | None) -> tuple[bool, dict]:
    """第二步的前置检查：未登录时不做任何接口请求。"""
    client = CdpFetchClient(
        cdp_url=args.cdp_url,
        page_match=args.page_match,
        token=token,
        zp_token=zp_token,
        timeout=args.timeout,
    )
    try:
        client.connect()
        probe = client.probe()
        print(f"[检查] 浏览器页面：{client.page_url}")
    finally:
        client.close()

    ok = is_logged_in(probe, token, zp_token)
    probe["loggedIn"] = ok
    if ok:
        source = "cookie bst" if probe.get("hasBst") else "页面 token"
        if not (probe.get("hasBst") or probe.get("tokenCandidates")):
            source = "手动指定 token"
        print(f"[检查] 登录状态：已登录（{source}）")
    else:
        print("[检查] 登录状态：未登录（缺少 bst / token）")
        print("[需要登录] 请在调试 Chrome 中打开并登录 https://www.zhipin.com/web/geek/jobs")
        print("           本脚本不会在未登录状态下发起任何请求。")
    return ok, probe


def prompt_login(args: argparse.Namespace, token: str | None, zp_token: str | None) -> bool:
    """未登录时等待用户在终端确认，然后重新做登录预检。"""
    while True:
        print("\n[等待登录] 请先在 Chrome 窗口里完成 BOSS 登录。")
        try:
            answer = input("登录完成后输入 Y 重新检查（输入 q 退出）：").strip().lower()
        except (EOFError, KeyboardInterrupt):
            print("\n[退出] 未完成登录。")
            return False
        if answer in ("q", "quit", "n", "no", "exit"):
            return False
        if answer not in ("", "y", "yes"):
            print("输入无效：请输入 Y/y/yes 继续，或 q 退出。")
            continue
        ok, _probe = check_login(args, token, zp_token)
        if ok:
            print("[登录] 预检通过，继续下一步。")
            return True
        print("[未登录] 仍未检测到登录状态，请确认 Chrome 里已经登录 BOSS。")


def cdp_alive(cdp_url: str, timeout: float = 2.0) -> bool:
    """调试端口还能响应，说明对应的 Chrome 没有被关闭。"""
    try:
        with urllib.request.urlopen(
            f"{cdp_url.rstrip('/')}/json/version", timeout=timeout
        ) as response:
            return bool(json.loads(response.read().decode("utf-8")))
    except Exception:  # noqa: BLE001 - 端口不通按 Chrome 已关闭处理
        return False


def print_recovery(args: argparse.Namespace, stage: str, token_missing: bool = False) -> None:
    """登录 / token / 连接失败时，根据 Chrome 是否还在给出下一步命令。"""
    if cdp_alive(args.cdp_url):
        print("[提示] Chrome 仍在运行：请确认 BOSS 标签页还在，然后重新执行脚本走登录预检：")
        print(f"       python run_job_queue.py --stage {stage}")
    else:
        print("[提示] 调试 Chrome 已关闭：请重新启动脚本，会自动启动 Chrome 并走登录预检：")
        print(f"       python start_chrome.py --stage {stage}")
    if token_missing:
        print("       如果 data/browser_auth.json 里的 token 已过期，请先删除该文件。")


def make_client_factory(args: argparse.Namespace, token: str | None, zp_token: str | None):
    """延迟到队列线程内创建 CDP 客户端（连接有线程亲和性）。"""
    state: dict = {}

    def get_client() -> CdpFetchClient:
        if "client" not in state:
            client = CdpFetchClient(
                cdp_url=args.cdp_url,
                page_match=args.page_match,
                token=token,
                zp_token=zp_token,
                timeout=args.timeout,
            )
            client.connect()
            print(f"[浏览器] 已连接：{client.page_url}")
            state["client"] = client
        return state["client"]

    def cleanup() -> None:
        client = state.pop("client", None)
        if client:
            client.close()
            print("[浏览器] 已断开")

    return get_client, cleanup
