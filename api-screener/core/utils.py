#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通用工具：时间、URL、接口响应校验与工作时间判断。"""

from __future__ import annotations

import argparse
import time
from datetime import datetime
from urllib.parse import quote

from core.config import LIMIT_KEYWORDS, LOGIN_KEYWORDS, RISK_KEYWORDS
from core.errors import AbortError


def now_ms() -> int:
    return int(time.time() * 1000)


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def clean(payload: dict) -> dict:
    return {key: value for key, value in payload.items() if key not in ("_raw", "_stderr")}


def check_response(name: str, resp: dict) -> dict:
    """code=0 视为正常；登录失效/沟通上限/风控/其他非零码均视为异常并终止。"""
    if "code" not in resp:
        raise AbortError(
            "invalid_response",
            f"{name} 未返回 JSON",
            {"body": str(resp.get("_raw") or "")[:500]},
        )
    code = resp.get("code")
    message = str(resp.get("message") or "")
    if code in (0, "0"):
        return resp
    if any(keyword in message for keyword in LOGIN_KEYWORDS):
        raise AbortError("login_invalid", f"{name} 登录失效：code={code} message={message}", clean(resp))
    if any(keyword in message for keyword in LIMIT_KEYWORDS):
        raise AbortError("limit_reached", f"{name} 触发限制：code={code} message={message}", clean(resp))
    if any(keyword in message for keyword in RISK_KEYWORDS) or code == 37:
        raise AbortError(
            "environment_abnormal",
            f"{name} 被风控拦截（环境异常/需安全验证）：code={code} message={message}",
            clean(resp),
        )
    raise AbortError("api_error", f"{name} 返回异常：code={code} message={message}", clean(resp))


def build_url(base: str, params: dict) -> str:
    query = "&".join(f"{name}={quote(str(value), safe=':/')}" for name, value in params.items())
    return f"{base}?{query}"


def parse_work_time(text: str):
    """把 HH:MM 解析为 time。"""
    try:
        return datetime.strptime(str(text), "%H:%M").time()
    except (TypeError, ValueError):
        raise SystemExit(f"时间格式应为 HH:MM：{text}")


def parse_work_days(text: str) -> set[int]:
    """把 1,2,3,4,5 解析为星期集合（1=周一，7=周日）。"""
    try:
        days = {int(part.strip()) for part in str(text).split(",") if part.strip()}
    except ValueError:
        raise SystemExit(f"工作日格式应为 1,2,3,4,5：{text}")
    if not days or any(day < 1 or day > 7 for day in days):
        raise SystemExit(f"工作日取值应在 1~7（周一至周日）：{text}")
    return days


def check_work_window(args: argparse.Namespace, moment: datetime | None = None) -> tuple[bool, str]:
    """非工作日、非工作时间一律不允许发送；--ignore-work-hours 可临时放开。"""
    if getattr(args, "ignore_work_hours", False):
        return True, ""
    moment = moment or datetime.now().astimezone()
    if moment.isoweekday() not in args.work_days:
        return False, f"今天（周{moment.isoweekday()}）不是允许发送的工作日"
    if not (args.work_start <= moment.time() < args.work_end):
        return False, (
            f"当前 {moment:%H:%M} 不在工作时间 "
            f"{args.work_start.strftime('%H:%M')}-{args.work_end.strftime('%H:%M')}"
        )
    return True, ""


def format_wait(seconds: float) -> str:
    """把秒数格式化成“X 小时 Y 分钟”。"""
    minutes = max(0, int(seconds)) // 60 + (1 if int(seconds) % 60 else 0)
    if minutes >= 60:
        return f"{minutes // 60} 小时 {minutes % 60} 分钟"
    return f"{minutes} 分钟"
