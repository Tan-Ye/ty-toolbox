#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""在已登录的浏览器里真实操作 BOSS 直聘流程（薄入口）。

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
  4. 浏览过程中沟通（--stage all）：
     - 详情达标时在当前页面点击「立即沟通」，出现弹窗后点「留在此页」；
     - 不调用发送接口，全部是页面内真实点击；
     - 任意 2 小时最多沟通 30 个，每天最多 --daily-limit 个（默认 150）；
     - 只和 boss 今日活跃或 3 日内活跃的岗位沟通；成功后记录岗位 id，永不重复；
     - 启动时展示今日采集/沟通概况；窗口或额度不足时由用户决定只浏览、继续沟通或退出。

用法:
  python run_job_queue.py --diagnose                 # 只检查浏览器环境/登录/token，不发请求
  python run_job_queue.py --stage collect            # 只浏览采集，不主动沟通
  python run_job_queue.py --stage collect --dry-run  # 只浏览采集，不主动沟通
  python run_job_queue.py --stage all --dry-run      # 干跑：浏览采集 + 模拟沟通决策
  python run_job_queue.py                            # 浏览采集 + 页面内主动沟通

退出码：0 完成 / 2 异常终止 / 3 手动停止 / 7 未登录（用户放弃登录或终端非交互）

代码结构（详见 agents.md）:
  core/       配置、异常、工具、单实例锁、终端输出
  browser/    CDP 客户端、页面采集、系统输入、登录检查
  workflow/   任务队列、求职期望、采集、页面沟通、启动面板、命令行
  storage/    SQLite 入库、优先级、沟通记录与导出
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
