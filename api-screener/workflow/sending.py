"""采集过程中的页面内沟通：点击「立即沟通」→「留在此页」。

只负责发送决策、额度、去重与拟人化日志；所有发送都通过真实页面点击完成，
不再调用发送接口。
"""

from __future__ import annotations

import argparse
import random
import time
from collections import deque
from datetime import datetime

from browser.page_collect import PageCollectError
from core import console
from core.config import SEND_LIMIT_MAX
from core.errors import AbortError
from core.utils import check_work_window
from storage import job_store


class InlineSender:
    """采集过程中按优先级决定是否在当前详情页发起沟通。

    发送间隔 30~60 秒；额度受滚动窗口和每日上限约束。
    """

    def __init__(
        self,
        args: argparse.Namespace,
        conn,
        page_send=None,
        wait_callback=None,
    ):
        self.args = args
        self.conn = conn
        self.page_send = page_send
        self.wait_callback = wait_callback
        self.dry_run = bool(args.dry_run)
        self.details_seen = 0
        self.sent = 0
        self.failed = 0
        self.skipped = 0
        self.queued_total = 0
        self._queue: deque[tuple[dict, dict, dict]] = deque()
        self._capacity_logged = False
        self._off_hours_logged = False
        self.force_window = bool(getattr(args, "force_window", False) or self.dry_run)
        today = job_store.today_stats(conn)
        window = job_store.window_stats(conn, args.cooldown_hours, SEND_LIMIT_MAX)
        self.today_sent = 0 if self.dry_run else today["sent"]
        self.window_sent = 0 if self.dry_run else window["sent"]
        self.window_limit = window["limit"]
        self.next_send_at = 0.0 if self.dry_run else self._initial_next_send_at()
        if self.dry_run:
            console.info("干跑：从 0 已沟通开始模拟，不点击页面、不写发送记录")

    def _initial_next_send_at(self) -> float:
        row = self.conn.execute(
            "SELECT MAX(sent_at) AS last FROM jobs WHERE send_status='sent'"
        ).fetchone()
        if not row or not row["last"]:
            return 0.0
        try:
            last = datetime.fromisoformat(row["last"]).timestamp()
        except ValueError:
            return 0.0
        wait = last + self.args.send_min_delay - time.time()
        return time.time() + wait if wait > 0 else 0.0

    def _capacity(self) -> bool:
        if self.today_sent >= self.args.daily_limit:
            return False
        if not self.force_window and self.window_sent >= self.window_limit:
            return False
        return True

    def _capacity_hint(self) -> None:
        if self._capacity_logged:
            return
        self._capacity_logged = True
        console.info(
            f"今天已经沟通 {self.today_sent}/{self.args.daily_limit} 个"
            f"（2 小时窗口 {self.window_sent}/{self.window_limit}），"
            "先只浏览，不再打招呼"
        )

    def consider(self, job: dict, data: dict, payload: dict) -> None:
        self.details_seen += 1
        job_info = data.get("jobInfo") or {}
        name = job.get("jobName") or job_info.get("jobName") or "未知岗位"

        if self.details_seen <= self.args.inline_warmup:
            console.browse(name, f"先看看（预热 {self.details_seen}/{self.args.inline_warmup}）")
            return
        if job_info.get("invalidStatus"):
            console.browse(name, "岗位已下线")
            return
        score = int(payload.get("priority_score") or 0)
        if score < self.args.inline_min_priority:
            console.browse(name, f"优先级 {score}，暂不沟通")
            return
        if not job_store.is_active(payload.get("boss_online"), payload.get("boss_active_desc")):
            console.browse(name, "boss 最近不活跃，暂不沟通")
            return
        job_id = str(job.get("encryptJobId") or "")
        if not job_id:
            return
        row = self.conn.execute(
            "SELECT send_status FROM jobs WHERE encrypt_job_id=?", (job_id,)
        ).fetchone()
        if row and row["send_status"] == "sent":
            console.browse(name, "之前已经沟通过")
            return
        allowed, reason = check_work_window(self.args)
        if not allowed:
            if not self._off_hours_logged:
                self._off_hours_logged = True
                console.info(f"{reason}，先只浏览，不打招呼")
            return
        if random.random() < self.args.inline_skip_rate:
            self.skipped += 1
            console.browse(name, "这次先跳过")
            return
        if not self._capacity():
            self._capacity_hint()
            return

        self._queue.append((job, data, payload))
        self.queued_total += 1
        console.info(f"准备和「{name}」打个招呼（优先级 {score}）")
        # 页面点击必须在当前详情页完成：没到间隔就留在这一页等，不能翻到别的岗位再点
        self.flush_due(wait=self.page_send is not None)

    def tick(self) -> None:
        self.flush_due()

    def flush_due(self, wait: bool = False) -> None:
        while self._queue:
            if not self._capacity():
                self._capacity_hint()
                return
            delay = self.next_send_at - time.time()
            if delay > 0 and not self.dry_run:
                if not wait:
                    return
                name = self._queue[0][0].get("jobName") or "这个岗位"
                console.info(f"先看看「{name}」的岗位详情，{delay:.0f} 秒后再打招呼")
                self._pause(delay)
            job, data, payload = self._queue.popleft()
            self._send(job, data, payload)

    def finish(self) -> None:
        """收尾：把已入队但还没到间隔的岗位发完，避免留下新的积压。"""
        while self._queue and self._capacity():
            wait = self.next_send_at - time.time()
            if wait > 0 and not self.dry_run:
                console.info(f"稍等 {wait:.0f} 秒，把剩下的 {len(self._queue)} 个岗位沟通完")
                self._pause(wait)
            before = len(self._queue)
            self.flush_due()
            if len(self._queue) >= before:
                break
        if self._queue:
            console.info(f"还有 {len(self._queue)} 个岗位没来得及打招呼，留到下次继续")

    def _pause(self, seconds: float) -> None:
        if self.wait_callback is not None:
            self.wait_callback(seconds)
            return
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            time.sleep(min(1.0, deadline - time.monotonic()))

    def _schedule_next(self) -> None:
        self.next_send_at = time.time() + random.uniform(
            self.args.send_min_delay, self.args.send_max_delay
        )

    def _record_failure(self, job_id: str, name: str, error: str) -> None:
        job_store.record_send_failed(self.conn, job_id, name, error)
        job_store.append_send_log(self.args.send_log, job_id, name, "failed", error)

    def _record_success(self, job_id: str, name: str) -> None:
        job_store.record_sent(self.conn, job_id, name)
        job_store.append_send_log(self.args.send_log, job_id, name, "sent")
        self.sent += 1
        self.today_sent += 1
        self.window_sent += 1
        self._schedule_next()

    def _send(self, job: dict, data: dict, payload: dict) -> None:
        job_id = str(job.get("encryptJobId") or "")
        name = job.get("jobName") or (data.get("jobInfo") or {}).get("jobName") or "未知岗位"
        score = int(payload.get("priority_score") or 0)
        if self.dry_run:
            self.sent += 1
            self.today_sent += 1
            self.window_sent += 1
            self._schedule_next()
            console.info(f"干跑：本来要和「{name}」打个招呼（优先级 {score}）")
            return

        if self.page_send is None:
            raise RuntimeError("页面发送未初始化，不能调用发送接口")
        try:
            result = self.page_send(job, data) or {}
        except AbortError as error:
            self._record_failure(job_id, name, str(error))
            if error.kind in ("login_invalid", "limit_reached", "environment_abnormal"):
                raise
            self.failed += 1
            self._schedule_next()
            console.info(f"和「{name}」打招呼没成功：{error}")
            return
        except PageCollectError as error:
            self._record_failure(job_id, name, str(error))
            self.failed += 1
            self._schedule_next()
            console.info(f"和「{name}」打招呼没成功：{error}")
            return

        self._record_success(job_id, name)
        if result.get("skipped") == "already_chat":
            console.info(f"「{name}」已经在沟通中，记为已沟通")
        else:
            console.send_ok(name)
        if result.get("blocked"):
            raise AbortError(
                "stopped", "问候弹窗未能关闭，已停止后续浏览，避免在遮罩下误点"
            )

    def summary(self) -> dict:
        return {
            "mode": "page",
            "sent": self.sent,
            "failed": self.failed,
            "skipped": self.skipped,
            "queued_total": self.queued_total,
            "pending": len(self._queue),
            "details_seen": self.details_seen,
            "dry_run": self.dry_run,
        }
