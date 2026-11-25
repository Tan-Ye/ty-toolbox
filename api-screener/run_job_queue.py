#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在已登录的浏览器页面内 fetch 执行 BOSS 直聘流程（薄入口）。

启动方式:
  python start_chrome.py               # 启动/复用 Chrome，就绪后自动执行本脚本（默认 --stage all）
  python start_chrome.py --no-run      # 只启动 Chrome，再手动执行本脚本
  python run_job_queue.py              # 直接执行（Chrome 已就绪时）

流程（--stage all，默认）:
  1. 采集（--collect-mode page，默认）：先确认登录和职位页，再由用户在终端选择求职期望；
     之后交替滚动列表、点击当前视口内的岗位卡片，只抓取浏览器自己发出的
     recommend/list.json 与 job/detail.json 响应，不直接请求接口；
     （api 模式保留为备用，直接请求接口，容易被风控拦截）
  2. 重复岗位按 encryptJobId 覆写，详情只保留 boss/岗位/关键字段，写入 SQLite；
  3. 按关键词（ai/js/ts/node/python 等）计算优先级，导出精简 jobs.json；
  4. 发送阶段：
     - --stage all：采集详情后按优先级穿插发送，更接近人工浏览；
     - --stage send：只批量补发积压岗位，按 30~60s 间隔打招呼；
     - 任意 2 小时最多发送 30 条，每天最多 --daily-limit 条（默认 150，BOSS 每日上限）；
     - 只给 boss 今日活跃或 3 日内活跃的岗位发；成功后记录岗位 id，永不重复发送；
     - 启动时展示今日采集/发送概况；窗口或额度不足时由用户决定只采集、继续发送或退出。

用法:
  python run_job_queue.py --diagnose                 # 只检查浏览器环境/登录/token，不发请求
  python run_job_queue.py --stage collect            # 只抓取期望+列表+详情并整理
  python run_job_queue.py --stage collect --dry-run  # 抓取整理，不发送
  python run_job_queue.py --stage all --dry-run      # 干跑：采集 + 记录发送决策
  python run_job_queue.py --stage send               # 只批量补发积压（受 2 小时窗口限制）
  python run_job_queue.py                            # 采集 + 穿插发送

退出码：0 完成 / 2 异常终止 / 3 手动停止 / 4 发送窗口已满 / 5 当日额度用完 / 6 非工作时间
        / 7 未登录（用户放弃登录或终端非交互）

代码结构（详见 agents.md）:
  core/       配置、异常、工具、单实例锁、终端输出
  browser/    CDP 客户端、页面采集、系统输入、登录检查
  workflow/   任务队列、求职期望、采集、发送、启动面板、命令行
  storage/    SQLite 入库、优先级、发送记录与导出
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

from browser.cdp_client import CdpError  # noqa: E402
from core import console  # noqa: E402
from core.config import EXIT_ABORTED, EXIT_STOPPED  # noqa: E402
from core.lock import acquire_run_lock, release_run_lock  # noqa: E402
from workflow.cli import main  # noqa: E402


if __name__ == "__main__":
    if not any(arg in ("-h", "--help") for arg in sys.argv[1:]):
        if not acquire_run_lock():
            print("[跳过] 已有另一个 run_job_queue 正在运行；请先退出那个终端。")
            raise SystemExit(EXIT_ABORTED)
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        console.finish(EXIT_STOPPED)
        raise SystemExit(EXIT_STOPPED)
    except CdpError as error:
        console.error(str(error))
        console.finish(1)
        raise SystemExit(1)
    except sqlite3.OperationalError as error:
        console.error(f"数据库被占用：{error}")
        console.info("请先退出另一个 run_job_queue / start_chrome 进程，再重新执行。")
        raise SystemExit(EXIT_ABORTED)
    finally:
        release_run_lock()
