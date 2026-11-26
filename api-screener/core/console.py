#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""终端输出：统一横幅、步骤、进度和结束提示。"""
from __future__ import annotations

import sys


def banner(title: str, lines: list[str]) -> None:
    print("=" * 66)
    print(f"  {title}")
    print("=" * 66)
    for line in lines:
        print(f"  {line}")


def step(index: int, title: str) -> None:
    print(f"\n[步骤 {index}] {title}")


def info(text: str) -> None:
    print(f"  {text}")


def scroll(page: int, added: int, total: int, target: int, details: int, detail_target: int) -> None:
    print(
        f"  继续浏览第 {page} 页，新增 {added} 个岗位"
        f"（累计 {total} 个，已查看 {details} 个详情）"
    )


def expect_list(name: str, count: int | None = None) -> None:
    if count is None:
        print(f"  已取得「{name}」期望岗位列表")
    else:
        print(f"  已取得「{name}」期望岗位列表，共 {count} 个岗位")


def detail_start(index: int, total: int, name: str) -> None:
    print(f"  点击了「{name}」岗位，查看详情信息...")


def detail_ok(index: int, total: int, name: str, active: str, salary: str = "") -> None:
    extra = f"，{salary}" if salary else ""
    print(f"  已了解「{name}」岗位（{active or '活跃未知'}{extra}）")


def detail_skip(index: int, total: int, name: str, reason: str) -> None:
    print(f"  跳过「{name}」岗位：{reason}")


def browse(name: str, note: str = "") -> None:
    print(f"  浏览了「{name}」岗位" + (f"，{note}" if note else ""))


def send_ok(name: str) -> None:
    print(f"  点击了「{name}」岗位，发送了求职信息")


def scroll_action(distance: int) -> None:
    """每次滚动都留一行，便于回看浏览节奏。"""
    distance = int(distance)
    if abs(distance) < 5:
        print("  轻轻滚动了一下，页面位置没有变化")
    elif distance > 0:
        print(f"  向下滚动 {distance}px，看看后面的岗位")
    else:
        print(f"  向上滚动 {abs(distance)}px，回看一下")


def refresh() -> None:
    print("  已经浏览到列表底部，刷新页面继续看")


def _duration_text(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    minutes, sec = divmod(total, 60)
    return f"{minutes} 分 {sec:02d} 秒" if minutes else f"{sec} 秒"


def summary(stats: dict) -> None:
    """一次运行结束后的统一汇总，终端和 queue_result.json 使用同一组数字。"""
    inline = stats.get("inline") or {}
    print("\n" + "-" * 66)
    print("  本次运行汇总")
    print(f"  用时：{_duration_text(stats.get('duration_sec', 0))}")
    print(
        f"  滚动：{stats.get('scrolls', 0)} 次，刷新：{stats.get('refreshes', 0)} 次"
    )
    print(
        f"  岗位：看到 {stats.get('jobs', 0)} 个，详情成功 {stats.get('details_ok', 0)} 个，"
        f"失败 {stats.get('details_failed', 0)} 个"
    )
    if inline:
        print(
            f"  沟通：成功 {inline.get('sent', 0)} 个，失败 {inline.get('failed', 0)} 个，"
            f"随机跳过 {inline.get('skipped', 0)} 个，待下次 {inline.get('pending', 0)} 个"
        )
        if inline.get("dry_run"):
            print("  说明：本次为干跑，没有真实点击「立即沟通」")
    print(
        f"  导出：{stats.get('exported', 0)} 个 -> {stats.get('export_path', '')}"
        f"（库内共 {stats.get('jobs_in_db', 0)} 个）"
    )
    print("-" * 66)


def error(text: str) -> None:
    print(f"[错误] {text}", file=sys.stderr)


EXIT_TEXTS = {
    0: "任务完成",
    1: "任务异常终止（未预期的错误）",
    2: "任务异常终止，请查看上方错误信息",
    3: "任务已手动停止",
    7: "未登录，任务未执行",
}


def finish(code: int) -> None:
    print(f"\n[结束] {EXIT_TEXTS.get(code, '任务结束')}（退出码 {code}）")
