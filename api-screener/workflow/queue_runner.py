#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""顺序任务队列：随机间隔执行，异常立即终止，支持 Ctrl+C 停止。"""

from __future__ import annotations

import random
import signal
import threading
import time
from collections import deque

from browser.cdp_client import CdpError
from core.config import ABORT_HINTS, EXIT_ABORTED, EXIT_STOPPED
from core.errors import AbortError
from core.utils import now_iso


class QueueRunner:
    """顺序队列：任务返回后按随机间隔等待，异常立即终止。"""

    def __init__(self, min_delay: float = 30, max_delay: float = 60, logger=print, cleanup=None):
        self.min_delay = min_delay
        self.max_delay = max_delay
        self.logger = logger
        self.cleanup = cleanup
        self._queue: deque[tuple[str, object]] = deque()
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self.tasks: list[dict] = []
        self.status = "pending"
        self.stop_reason: str | None = None
        self.abort: dict | None = None
        self.started_at: str | None = None
        self.finished_at: str | None = None

    def enqueue(self, name: str, func) -> "QueueRunner":
        self._queue.append((name, func))
        return self

    def start(self) -> bool:
        """启动队列（后台线程）；列表任务会继续向队列追加详情任务。"""
        if self._thread and self._thread.is_alive():
            self.logger("队列已在运行中")
            return False
        self.started_at = now_iso()
        self.status = "running"
        self._thread = threading.Thread(target=self._run, name="zhipin-queue", daemon=True)
        self._thread.start()
        return True

    def stop(self, reason: str = "手动终止") -> None:
        """终止队列：不再开始新任务，当前请求返回后退出。"""
        self.stop_reason = reason
        self._stop_event.set()

    def join(self, timeout: float | None = None) -> str:
        if self._thread:
            self._thread.join(timeout)
        return self.status

    def wait(self, seconds: float) -> bool:
        """可被终止打断的等待；返回 False 表示等待期间收到停止信号。"""
        deadline = time.monotonic() + seconds
        while not self._stop_event.is_set():
            remain = deadline - time.monotonic()
            if remain <= 0:
                return True
            self._stop_event.wait(min(remain, 0.5))
        return False

    def _abort(self, name: str, entry: dict, kind: str, message: str, payload: dict | None = None) -> None:
        entry.update(status="aborted", kind=kind, message=message, response=payload or {}, finished_at=now_iso())
        self.abort = {"kind": kind, "task": name, "message": message, "response": payload or {}}
        self.stop_reason = f"{name} -> {message}"
        self.status = "aborted"
        self._stop_event.set()
        self.logger(f"[终止] {name}：{message}")
        hint = ABORT_HINTS.get(kind)
        if hint:
            self.logger(f"[建议] {hint}")
        remaining = len(self._queue)
        if remaining:
            self.logger(f"[提示] 剩余 {remaining} 个任务不再执行")

    def _run(self) -> None:
        seq = 0
        try:
            while self._queue and not self._stop_event.is_set():
                seq += 1
                name, func = self._queue.popleft()
                entry = {"seq": seq, "task": name, "status": "running", "started_at": now_iso()}
                self.tasks.append(entry)
                self.logger(f"  [任务] {name} 开始")
                started = time.monotonic()
                try:
                    value = func()
                except CdpError as error:
                    kind = "token_missing" if "auth_missing" in str(error) else "browser_error"
                    self._abort(name, entry, kind, str(error))
                    break
                except AbortError as error:
                    self._abort(name, entry, error.kind, str(error), error.payload)
                    break
                except Exception as error:  # noqa: BLE001
                    self._abort(name, entry, "exception", f"{type(error).__name__}: {error}")
                    break
                entry.update(
                    status="ok",
                    elapsed=round(time.monotonic() - started, 2),
                    result=value,
                    finished_at=now_iso(),
                )
                self.logger(f"  [任务] {name} → 完成")
                if self._queue and not self._stop_event.is_set():
                    delay = random.uniform(self.min_delay, self.max_delay)
                    entry["next_delay"] = round(delay, 1)
                    self.logger(f"  [等待] {delay:.1f}s 后执行下一个任务")
                    if not self.wait(delay):
                        break
        finally:
            if self.status != "aborted":
                self.status = "stopped" if self._stop_event.is_set() else "completed"
            for name, _ in self._queue:
                self.tasks.append({"task": name, "status": "skipped"})
            self._queue.clear()
            self.finished_at = now_iso()
            if self.cleanup:
                try:
                    self.cleanup()
                except Exception as error:  # noqa: BLE001
                    self.logger(f"[清理] {type(error).__name__}: {error}")


def run_queue(runner: QueueRunner) -> QueueRunner:
    """启动队列并等待结束，期间支持 Ctrl+C 停止。"""

    def handle_signal(signum, _frame):
        print(f"\n[终止] 收到信号 {signum}，当前任务返回后停止队列")
        runner.stop(f"收到终止信号 {signum}")

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, handle_signal)
        except (ValueError, OSError):
            pass
    runner.start()
    runner.join()
    return runner


def runner_exit_code(runner: QueueRunner) -> int:
    if runner.status == "aborted":
        return EXIT_ABORTED
    if runner.status == "stopped":
        return EXIT_STOPPED
    return 0


def runner_summary(runner: QueueRunner) -> dict:
    return {
        "status": runner.status,
        "stop_reason": runner.stop_reason,
        "abort": runner.abort,
        "finished_at": runner.finished_at,
        "tasks": runner.tasks,
    }
