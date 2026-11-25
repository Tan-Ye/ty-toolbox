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
        f"  [滚动] 第 {page} 页：新增 {added} 条，列表 {total}/{target}，"
        f"详情 {details}/{detail_target}"
    )


def detail_start(index: int, total: int, name: str) -> None:
    print(f"  [详情 {index}/{total}] 点击岗位「{name}」查询详情...")


def detail_ok(index: int, total: int, name: str, active: str, salary: str = "") -> None:
    extra = f"，{salary}" if salary else ""
    print(f"  [详情 {index}/{total}] 已获取「{name}」（{active or '活跃未知'}{extra}）")


def detail_skip(index: int, total: int, name: str, reason: str) -> None:
    print(f"  [详情 {index}/{total}] 「{name}」跳过：{reason}")


def error(text: str) -> None:
    print(f"[错误] {text}", file=sys.stderr)


EXIT_TEXTS = {
    0: "任务完成",
    1: "任务异常终止（未预期的错误）",
    2: "任务异常终止，请查看上方错误信息",
    3: "任务已手动停止",
    4: "2 小时发送窗口已满，本次未发送",
    5: "今日发送额度已用完，本次未发送",
    6: "非工作日/非工作时间，本次未发送",
    7: "未登录，任务未执行",
}


def finish(code: int) -> None:
    print(f"\n[结束] {EXIT_TEXTS.get(code, '任务结束')}（退出码 {code}）")
