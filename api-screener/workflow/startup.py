#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""启动面板：展示今日浏览/沟通概况，窗口或额度不足时让用户决定。"""

from __future__ import annotations

import argparse

from core.config import EXIT_STOPPED, SEND_LIMIT_MAX
from core.utils import format_wait
from storage import job_store


def startup_gate(args: argparse.Namespace) -> int:
    """启动时展示今日概况；窗口/额度不足时由用户决定是否继续。"""
    with job_store.connect(args.db) as conn:
        stats = job_store.today_stats(conn)
        window = job_store.window_stats(conn, args.cooldown_hours, SEND_LIMIT_MAX)

    print("\n[今日概况]")
    print(f"  采集：列表 {stats['collected']} 条，详情成功 {stats['details_ok']} 条")
    print(f"  沟通：{stats['sent']}/{args.daily_limit}，失败 {stats['failed']}")
    if window["sent"] >= window["limit"]:
        print(
            f"  2 小时窗口：{window['sent']}/{window['limit']}，"
            f"下一个额度约 {format_wait(window['next_slot_seconds'])}后释放"
        )
    else:
        print(
            f"  2 小时窗口：{window['sent']}/{window['limit']}，"
            f"还可沟通 {window['remaining']} 个"
        )

    if args.stage != "all":
        return 0
    if args.dry_run:
        print("  [干跑] 只模拟沟通决策，不点击「立即沟通」，窗口限制不生效")
        return 0
    if stats["sent"] >= args.daily_limit:
        print(f"  [提示] 今天已经和 {stats['sent']} 个岗位沟通过，达到每日上限；本次只浏览")
        args.stage = "collect"
        return 0
    if window["sent"] < window["limit"]:
        return 0
    if args.force_window:
        print("  [提示] 已指定 --force-window，忽略 2 小时窗口，风险自负")
        return 0

    print("  1. 只浏览，不沟通（默认）")
    print("  2. 继续沟通（忽略 2 小时窗口，风险自负）")
    print("  3. 退出")
    try:
        answer = input("  请选择 [1]：").strip().lower()
    except (EOFError, KeyboardInterrupt):
        answer = ""
    answer = answer or "1"
    if answer in ("2", "y", "yes"):
        args.force_window = True
        print("  [提示] 已选择继续沟通，忽略 2 小时窗口，风险自负")
        return 0
    if answer in ("3", "q", "quit"):
        return EXIT_STOPPED
    print("  [提示] 本次只浏览，不沟通")
    args.stage = "collect"
    return 0
