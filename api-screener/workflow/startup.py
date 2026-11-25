#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""启动面板：展示今日采集/发送概况，窗口或额度不足时让用户决定。"""

from __future__ import annotations

import argparse

from core.config import EXIT_COOLDOWN, EXIT_DAILY_LIMIT, EXIT_STOPPED, SEND_LIMIT_MAX
from core.utils import format_wait
from storage import job_store


def startup_gate(args: argparse.Namespace) -> int:
    """启动时展示今日概况；窗口/额度不足时由用户决定是否继续。"""
    with job_store.connect(args.db) as conn:
        stats = job_store.today_stats(conn)
        window = job_store.window_stats(conn, args.cooldown_hours, SEND_LIMIT_MAX)

    print("\n[今日概况]")
    print(f"  采集：列表 {stats['collected']} 条，详情成功 {stats['details_ok']} 条")
    print(f"  发送：{stats['sent']}/{args.daily_limit}，失败 {stats['failed']}")
    if window["sent"] >= window["limit"]:
        print(
            f"  2 小时窗口：{window['sent']}/{window['limit']}，"
            f"下一个额度约 {format_wait(window['next_slot_seconds'])}后释放"
        )
    else:
        print(
            f"  2 小时窗口：{window['sent']}/{window['limit']}，"
            f"还可发送 {window['remaining']} 条"
        )

    if args.stage not in ("all", "send"):
        return 0
    if args.dry_run:
        print("  [干跑] 只记录发送决策，不真正发送，窗口限制不生效")
        return 0
    if stats["sent"] >= args.daily_limit:
        if args.stage == "send":
            print(f"  [跳过] 今日已发送 {stats['sent']} 条，达到每日上限 {args.daily_limit}")
            return EXIT_DAILY_LIMIT
        print(f"  [提示] 今日已发送 {stats['sent']} 条，达到每日上限；本次只采集")
        args.stage = "collect"
        return 0
    if window["sent"] < window["limit"]:
        return 0
    if args.force_window:
        print("  [提示] 已指定 --force-window，忽略 2 小时窗口，风险自负")
        return 0

    if args.stage == "send":
        print("  1. 退出，等窗口释放（默认）")
        print("  2. 继续发送（忽略 2 小时窗口，风险自负）")
        default = "1"
    else:
        print("  1. 只采集，不发送（默认）")
        print("  2. 继续发送（忽略 2 小时窗口，风险自负）")
        print("  3. 退出")
        default = "1"
    try:
        answer = input(f"  请选择 [{default}]：").strip().lower()
    except (EOFError, KeyboardInterrupt):
        answer = ""
    answer = answer or default
    if answer in ("2", "y", "yes"):
        args.force_window = True
        print("  [提示] 已选择继续发送，忽略 2 小时窗口，风险自负")
        return 0
    if args.stage == "send":
        print("  [跳过] 等待窗口释放后再发送")
        return EXIT_COOLDOWN
    if answer in ("3", "q", "quit"):
        return EXIT_STOPPED
    print("  [提示] 本次只采集，不发送")
    args.stage = "collect"
    return 0
