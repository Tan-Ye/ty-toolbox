#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""全局常量：文件路径、接口地址、发送额度、退出码和风控关键词。"""

from __future__ import annotations

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

LIST_PARAMS_FILE = BASE_DIR / "params" / "list_params.json"
RESULT_FILE = BASE_DIR / "data" / "screen" / "queue_result.json"
AUTH_FILE = BASE_DIR / "data" / "browser_auth.json"
EXPECT_FILE = BASE_DIR / "data" / "zhipin" / "expects.json"
RUN_LOCK_FILE = BASE_DIR / "data" / "run.lock"

EXPECT_URL = "https://www.zhipin.com/wapi/zpgeek/pc/recommend/expect/list.json"
DETAIL_URL = "https://www.zhipin.com/wapi/zpgeek/job/detail.json"
ADD_URL = "https://www.zhipin.com/wapi/zpgeek/friend/add.json"

SEND_LIMIT_MAX = 30

DEFAULT_WORK_START = "09:00"
DEFAULT_WORK_END = "18:00"
DEFAULT_WORK_DAYS = "1,2,3,4,5"

EXIT_ABORTED = 2
EXIT_STOPPED = 3
EXIT_COOLDOWN = 4
EXIT_DAILY_LIMIT = 5
EXIT_OFF_HOURS = 6
EXIT_NOT_LOGGED_IN = 7

LOGIN_KEYWORDS = (
    "请先登录",
    "未登录",
    "登录已失效",
    "登录状态",
    "重新登录",
    "身份验证",
    "账号异常",
    "登录过期",
)
LIMIT_KEYWORDS = (
    "上限",
    "次数已用完",
    "沟通次数",
    "操作太频繁",
    "操作频繁",
    "稍后再试",
    "请求过于频繁",
)
RISK_KEYWORDS = (
    "环境存在异常",
    "环境异常",
    "安全验证",
    "请完成验证",
    "验证码",
)
ABORT_HINTS = {
    "login_invalid": "请在浏览器重新登录 BOSS 后重试",
    "limit_reached": "今日沟通次数已达上限，今天不要再发，改天再跑",
    "environment_abnormal": "浏览器内仍被风控拦截，请刷新页面或稍后再试，不要连续重试",
    "browser_error": "检查 Chrome 调试端口、BOSS 标签页和登录状态",
    "empty_list": "列表接口没有返回职位，确认页面登录状态和推荐列表是否正常",
    "empty_detail": "详情接口没有返回必要字段，检查该职位是否已下线",
    "expect_missing": "求职期望接口没有可用期望，请先在 BOSS 中完善求职期望",
    "not_logged_in": "请先在调试 Chrome 中登录 BOSS，再执行第二步",
    "job_mismatch": "详情与列表岗位不一致，已停止以免发错岗位",
    "stopped": "已按终止信号停止队列",
}
