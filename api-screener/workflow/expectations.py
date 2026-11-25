#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""求职期望：接口版筛选参数、页面标签选择与期望任务。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from browser.page_collect import PageCollectError
from core import console
from core.config import EXPECT_URL
from core.errors import AbortError
from core.utils import build_url, check_response, now_iso, now_ms


def load_list_params(path: Path) -> tuple[str, dict]:
    """读取列表接口 url 和原始 query；page 与 _ 由任务按次覆盖。"""
    data = json.loads(path.read_text(encoding="utf-8"))
    url = data.get("url")
    query = data.get("query")
    if not url or not isinstance(query, dict):
        raise SystemExit(f"{path} 缺少 url 或 query")
    return str(url), dict(query)


def normalize_expect(item: dict) -> dict:
    """只保留求职期望里对列表筛选有用的字段。"""
    return {
        "encryptId": item.get("encryptId"),
        "location": item.get("location"),
        "locationName": item.get("locationName"),
        "subLocation": item.get("subLocation"),
        "subLocationName": item.get("subLocationName"),
        "position": item.get("position"),
        "positionName": item.get("positionName"),
        "salary": item.get("salary"),
        "lowSalary": item.get("lowSalary"),
        "highSalary": item.get("highSalary"),
    }


def pick_expect_index(expects: list[dict], expect_index: int, params_file: Path) -> int:
    """选择要使用的求职期望：显式指定 > 沿用列表参数里的 encryptExpectId > 第一条。"""
    if expect_index > 0:
        if expect_index > len(expects):
            raise AbortError(
                "expect_missing",
                f"--expect-index={expect_index} 超出范围，共 {len(expects)} 条求职期望",
            )
        return expect_index - 1
    current = ""
    try:
        _, query = load_list_params(params_file)
        current = str(query.get("encryptExpectId") or "")
    except SystemExit:
        current = ""
    for index, item in enumerate(expects):
        if current and item.get("encryptId") == current:
            return index
    return 0


def make_expect_task(
    get_client,
    state: dict,
    expect_file: Path,
    expect_index: int,
    params_file: Path,
):
    """求职期望任务：先拿到用户期望的地点/职位/薪资，作为列表筛选条件。"""

    def task() -> dict:
        url = build_url(EXPECT_URL, {"_": now_ms()})
        resp = check_response("求职期望接口", get_client().fetch_json(url, "GET"))
        zp_data = resp.get("zpData") or {}
        expects = [
            normalize_expect(item)
            for item in (zp_data.get("expectList") or [])
            if item.get("encryptId")
        ]
        if not expects:
            raise AbortError("expect_missing", "求职期望接口没有返回可用的期望")

        index = pick_expect_index(expects, expect_index, params_file)
        selected = expects[index]
        state["expect"] = selected

        expect_file.parent.mkdir(parents=True, exist_ok=True)
        expect_file.write_text(
            json.dumps(
                {"fetched_at": now_iso(), "selected_index": index, "expectList": expects},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        print(
            f"    使用期望 {index + 1}/{len(expects)}："
            f"{selected.get('locationName')} / {selected.get('positionName')} / {selected.get('salary')}"
        )
        print(f"    期望已保存：{expect_file}")
        return {
            "count": len(expects),
            "selectedIndex": index,
            "locationName": selected.get("locationName"),
            "positionName": selected.get("positionName"),
            "salary": selected.get("salary"),
        }

    return task


def expect_city_from_text(text: str) -> str:
    """从期望标签末尾的括号里取出城市，例如「全栈工程师(杭州)」→「杭州」。"""
    for left, right in (("(", ")"), ("（", "）")):
        start = text.rfind(left)
        end = text.rfind(right)
        if start != -1 and end > start:
            return text[start + 1:end].strip()
    return ""


def choose_expect(args: argparse.Namespace, tabs: list[str]) -> int:
    """在终端展示求职期望，由用户选择并确认；返回 1 起的序号。"""
    console.step(3, "选择求职期望")
    for index, text in enumerate(tabs, 1):
        console.info(f"{index}. {text}")
    default = 1
    if args.expect_index and 1 <= args.expect_index <= len(tabs):
        default = args.expect_index
    elif args.expect_city:
        for index, text in enumerate(tabs, 1):
            if args.expect_city in text:
                default = index
                break
    while True:
        try:
            raw = input(
                f"请输入期望编号（1-{len(tabs)}，回车默认 {default}，q 退出）："
            ).strip()
        except (EOFError, KeyboardInterrupt):
            raise PageCollectError("用户取消选择求职期望")
        if raw.lower() in ("q", "quit"):
            raise PageCollectError("用户取消选择求职期望")
        if not raw:
            index = default
        elif raw.isdigit() and 1 <= int(raw) <= len(tabs):
            index = int(raw)
        else:
            print("  输入无效，请重新输入。")
            continue
        text = tabs[index - 1]
        try:
            confirm = input(f"确认使用「{text}」并开始采集？[Y/n]：").strip().lower()
        except (EOFError, KeyboardInterrupt):
            raise PageCollectError("用户取消选择求职期望")
        if confirm in ("", "y", "yes"):
            print(f"[确认] 使用期望：{text}\n")
            return index
        print("  已取消，请重新选择。")
