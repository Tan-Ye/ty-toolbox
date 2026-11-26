#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""命令行入口：参数定义、校验与主流程编排。"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from browser.auth import check_login, is_logged_in, load_auth, prompt_login
from browser.cdp_client import CdpFetchClient
from core import console
from core.config import (
    AUTH_FILE,
    DEFAULT_WORK_DAYS,
    DEFAULT_WORK_END,
    DEFAULT_WORK_START,
    EXIT_NOT_LOGGED_IN,
    EXPECT_FILE,
    LIST_PARAMS_FILE,
    RESULT_FILE,
)
from core.utils import now_iso, parse_work_days, parse_work_time
from storage import job_store
from workflow.collecting import run_collect
from workflow.startup import startup_gate


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="浏览器内抓包执行 BOSS 直聘岗位采集与页面内打招呼")
    parser.add_argument("--stage", choices=("all", "collect"), default="all",
                        help="all=浏览采集+页面内沟通，collect=只浏览采集")
    parser.add_argument("--cdp-url", default=os.environ.get("ZP_CDP_URL", "http://127.0.0.1:9222"))
    parser.add_argument("--page-match", default="zhipin.com", help="用来匹配 BOSS 标签页的 URL 片段")
    parser.add_argument("--token", default=None, help="手动指定 token 请求头")
    parser.add_argument("--zp-token", default=None, help="手动指定 zp_token 请求头")
    parser.add_argument("--auth-file", default=str(AUTH_FILE), help="含 token/zp_token 的 JSON 文件")
    parser.add_argument("--list-params", default=str(LIST_PARAMS_FILE), help="列表接口参数 JSON")
    parser.add_argument("--expect-index", type=int, default=0,
                        help="使用第几条求职期望（page 模式=页面标签序号，api 模式=期望列表序号；0=按城市自动选）")
    parser.add_argument("--expect-city", default="杭州",
                        help="自动选择求职期望时匹配的城市关键词，默认 杭州")
    parser.add_argument("--input-mode", choices=("os", "cdp"), default="os",
                        help="滚轮方式：os=Windows 原生鼠标滚轮（默认），cdp=页面滚动")
    parser.add_argument("--expect-file", default=str(EXPECT_FILE), help="求职期望快照 JSON 路径")
    parser.add_argument("--collect-mode", choices=("page", "api"), default="page",
                        help="采集方式：page=滚动页面抓包（默认），api=直接请求接口（易触发风控）")
    parser.add_argument("--max-scrolls", type=int, default=150, help="页面模式下最多滚动次数")
    parser.add_argument("--max-refreshes", type=int, default=2,
                        help="滚到底后最多刷新几次，0=不刷新")
    parser.add_argument("--scroll-min-delay", type=float, default=2.0, help="滚动间隔下限（秒）")
    parser.add_argument("--scroll-max-delay", type=float, default=4.0, help="滚动间隔上限（秒）")
    parser.add_argument("--list-pages", type=int, default=10, help="列表最多抓取几页（每页 15 条）")
    parser.add_argument("--detail-limit", type=int, default=150, help="最多获取多少个岗位详情")
    parser.add_argument("--list-target", type=int, default=0,
                        help="页面模式下列表最多采集多少条（默认等于 --detail-limit）")
    parser.add_argument("--pool-limit", type=int, default=150, help="参与排序的优先级池大小")
    parser.add_argument("--daily-limit", type=int, default=150, help="每天最多沟通多少个岗位（默认 150）")
    parser.add_argument("--inline-min-priority", type=int, default=3,
                        help="主动沟通的最低优先级分数，默认 3")
    parser.add_argument("--inline-warmup", type=int, default=3,
                        help="浏览前 N 个详情不发送，默认 3")
    parser.add_argument("--inline-skip-rate", type=float, default=0.1,
                        help="达标岗位的随机跳过概率，默认 0.1")
    parser.add_argument("--force-window", action="store_true",
                        help="忽略 2 小时发送窗口（风险自负）")
    parser.add_argument("--work-start", default=DEFAULT_WORK_START, help="允许发送的开始时间 HH:MM")
    parser.add_argument("--work-end", default=DEFAULT_WORK_END, help="允许发送的结束时间 HH:MM")
    parser.add_argument("--work-days", default=DEFAULT_WORK_DAYS,
                        help="允许发送的星期，1=周一 ... 7=周日，默认 1,2,3,4,5")
    parser.add_argument("--ignore-work-hours", action="store_true",
                        help="临时忽略工作日/工作时间限制（仅用于当天特批）")
    parser.add_argument("--list-page-min-delay", type=float, default=10, help="列表翻页最小间隔（秒）")
    parser.add_argument("--list-page-max-delay", type=float, default=20, help="列表翻页最大间隔（秒）")
    parser.add_argument("--detail-min-delay", type=float, default=3, help="详情任务最小间隔（秒）")
    parser.add_argument("--detail-max-delay", type=float, default=6, help="详情任务最大间隔（秒）")
    parser.add_argument("--send-min-delay", type=float, default=30, help="两次主动沟通的最小间隔（秒）")
    parser.add_argument("--send-max-delay", type=float, default=60, help="两次主动沟通的最大间隔（秒）")
    parser.add_argument("--cooldown-hours", "--window-hours", dest="cooldown_hours",
                        type=float, default=2, help="发送滚动窗口小时数（默认 2）")
    parser.add_argument("--db", default=str(job_store.DB_FILE), help="SQLite 数据库路径")
    parser.add_argument("--export-json", default=str(job_store.EXPORT_FILE), help="整理结果 JSON 路径")
    parser.add_argument("--send-log", default=str(job_store.SEND_LOG_FILE), help="发送日志 jsonl 路径")
    parser.add_argument("--timeout", type=float, default=30, help="单次请求超时（秒）")
    parser.add_argument("--dry-run", action="store_true",
                        help="干跑：只模拟沟通决策，不点击「立即沟通」")
    parser.add_argument("--diagnose", action="store_true", help="只检查浏览器环境和 token 候选，不发请求")
    parser.add_argument("--out", default=str(RESULT_FILE), help="队列运行结果 JSON")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    for name in (
        "list_page_min_delay",
        "list_page_max_delay",
        "detail_min_delay",
        "detail_max_delay",
        "send_min_delay",
        "send_max_delay",
    ):
        if getattr(args, name) < 0:
            raise SystemExit(f"--{name.replace('_', '-')} 不能小于 0")
    for low, high in (
        ("list_page_min_delay", "list_page_max_delay"),
        ("detail_min_delay", "detail_max_delay"),
        ("send_min_delay", "send_max_delay"),
    ):
        if getattr(args, low) > getattr(args, high):
            raise SystemExit(f"--{low.replace('_', '-')} 不能大于 --{high.replace('_', '-')}")
    if args.detail_limit <= 0:
        raise SystemExit("--detail-limit 必须大于 0")
    if args.list_target < 0:
        raise SystemExit("--list-target 不能小于 0")
    if args.pool_limit <= 0:
        raise SystemExit("--pool-limit 必须大于 0")
    if args.daily_limit <= 0:
        raise SystemExit("--daily-limit 必须大于 0")
    if args.inline_min_priority < 0:
        raise SystemExit("--inline-min-priority 不能小于 0")
    if args.inline_warmup < 0:
        raise SystemExit("--inline-warmup 不能小于 0")
    if not 0 <= args.inline_skip_rate <= 1:
        raise SystemExit("--inline-skip-rate 应在 0~1 之间")
    if args.expect_index < 0:
        raise SystemExit("--expect-index 不能小于 0（0 表示自动选择）")
    if args.max_scrolls <= 0:
        raise SystemExit("--max-scrolls 必须大于 0")
    if args.max_refreshes < 0:
        raise SystemExit("--max-refreshes 不能小于 0")
    if not (0 < args.scroll_min_delay <= args.scroll_max_delay):
        raise SystemExit("滚动间隔应满足 0 < --scroll-min-delay <= --scroll-max-delay")
    args.work_start = parse_work_time(args.work_start)
    args.work_end = parse_work_time(args.work_end)
    args.work_days = parse_work_days(args.work_days)
    if args.work_start >= args.work_end:
        raise SystemExit("--work-start 必须早于 --work-end")
    if args.send_min_delay < 0 or args.send_max_delay < 0:
        raise SystemExit("--send-min-delay/--send-max-delay 不能小于 0")
    if args.send_min_delay > args.send_max_delay:
        raise SystemExit("--send-min-delay 不能大于 --send-max-delay")


def main() -> int:
    args = parse_args()
    validate_args(args)

    console.banner(
        "BOSS 直聘自动采集与沟通",
        [
            f"阶段：{'diagnose' if args.diagnose else args.stage}",
            f"数据库：{args.db}",
            f"开始时间：{now_iso()}",
        ],
    )
    token, zp_token = load_auth(args.token, args.zp_token, args.auth_file)
    if args.diagnose:
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
            probe["loggedIn"] = is_logged_in(probe, token, zp_token)
            print(json.dumps(probe, ensure_ascii=False, indent=2))
            if not probe["loggedIn"]:
                print("[需要登录] 请先在调试 Chrome 中登录 BOSS，再重新执行任务。")
        finally:
            client.close()
        return 0

    gate_code = startup_gate(args)
    if gate_code != 0:
        console.finish(gate_code)
        return gate_code

    console.step(1, "检查浏览器与登录状态")
    if not check_login(args, token, zp_token):
        if not prompt_login(args, token, zp_token):
            console.finish(EXIT_NOT_LOGGED_IN)
            return EXIT_NOT_LOGGED_IN

    result = {"started_at": now_iso(), "dry_run": args.dry_run, "stage": args.stage, "collect": None}
    exit_code, result["collect"] = run_collect(args, token, zp_token)
    if args.dry_run and exit_code == 0:
        print("\n--dry-run：只模拟沟通决策，没有点击「立即沟通」")
    result["finished_at"] = now_iso()
    save_result(args.out, result)
    console.finish(exit_code)
    return exit_code


def save_result(path: str, payload: dict) -> None:
    out_path = Path(path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n结果已保存：{out_path}")
