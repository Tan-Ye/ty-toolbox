#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""批量发送与采集过程中的穿插发送。

只负责发送决策和接口调用，不改动滚动、点击、停留、分心等浏览行为。
"""

from __future__ import annotations

import argparse
import random
import time
from collections import deque
from datetime import datetime
from pathlib import Path

from browser.auth import make_client_factory, print_recovery
from browser.cdp_client import CdpError, CdpFetchClient
from core.config import ADD_URL, EXIT_COOLDOWN, EXIT_DAILY_LIMIT, EXIT_OFF_HOURS, SEND_LIMIT_MAX
from core.errors import AbortError
from core.utils import build_url, check_response, check_work_window, format_wait, now_ms
from storage import job_store
from workflow.queue_runner import QueueRunner, run_queue, runner_exit_code, runner_summary


def make_send_task(row: dict, get_client, db_path: Path, send_log: Path):
    """发送任务：成功后记录岗位 id（不再重复发送），失败保留异常信息。"""

    def task() -> dict:
        job_id = row["encrypt_job_id"]
        job_name = row.get("job_name")
        url = build_url(
            ADD_URL,
            {
                "securityId": row.get("detail_security_id"),
                "jobId": job_id,
                "lid": row.get("detail_lid"),
                "_": now_ms(),
            },
        )
        body = f"sessionId={row.get('session_id') or ''}"
        try:
            check_response("发送消息接口", get_client().fetch_json(url, "POST", body))
        except (AbortError, CdpError) as error:
            with job_store.connect(db_path) as conn:
                job_store.record_send_failed(conn, job_id, job_name, str(error))
            job_store.append_send_log(send_log, job_id, job_name, "failed", str(error))
            raise
        with job_store.connect(db_path) as conn:
            job_store.record_sent(conn, job_id, job_name)
        job_store.append_send_log(send_log, job_id, job_name, "sent")
        return {"jobName": job_name, "sent": True}

    return task


class InlineSender:
    """采集过程中按优先级穿插发送。

    只负责决策和发送，不改变滚动、点击、停留、分心等浏览行为；
    发送间隔仍为 30~60 秒，额度受滚动窗口和每日上限约束。
    """

    def __init__(self, args: argparse.Namespace, token: str | None, zp_token: str | None, conn, log=print):
        self.args = args
        self.token = token
        self.zp_token = zp_token
        self.conn = conn
        self.log = log
        self.dry_run = bool(args.dry_run)
        self.client: CdpFetchClient | None = None
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
            self.log("  [内联-干跑] 从 0 已发开始模拟，不写入数据库、不发送请求")

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

    def _get_client(self) -> CdpFetchClient:
        if self.client is None:
            client = CdpFetchClient(
                cdp_url=self.args.cdp_url,
                page_match=self.args.page_match,
                token=self.token,
                zp_token=self.zp_token,
                timeout=self.args.timeout,
            )
            client.connect()
            print(f"[浏览器] 内联发送已连接：{client.page_url}")
            self.client = client
        return self.client

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
        self.log(
            f"  [内联] 发送额度不足（今日 {self.today_sent}/{self.args.daily_limit}，"
            f"窗口 {self.window_sent}/{self.window_limit}），后续岗位留给发送阶段"
        )

    def consider(self, job: dict, data: dict, payload: dict) -> None:
        self.details_seen += 1
        if self.details_seen <= self.args.inline_warmup:
            return
        job_info = data.get("jobInfo") or {}
        if job_info.get("invalidStatus"):
            return
        score = int(payload.get("priority_score") or 0)
        if score < self.args.inline_min_priority:
            return
        if not job_store.is_active(payload.get("boss_online"), payload.get("boss_active_desc")):
            return
        job_id = str(job.get("encryptJobId") or "")
        if not job_id:
            return
        row = self.conn.execute(
            "SELECT send_status FROM jobs WHERE encrypt_job_id=?", (job_id,)
        ).fetchone()
        if row and row["send_status"] == "sent":
            return
        allowed, reason = check_work_window(self.args)
        if not allowed:
            if not self._off_hours_logged:
                self._off_hours_logged = True
                self.log(f"  [内联] {reason}，暂不发送")
            return
        if random.random() < self.args.inline_skip_rate:
            self.skipped += 1
            self.log(f"  [内联] 「{job.get('jobName')}」优先级 {score}，随机跳过")
            return
        if not self._capacity():
            self._capacity_hint()
            return
        self._queue.append((job, data, payload))
        self.queued_total += 1
        self.log(
            f"  [内联] 「{job.get('jobName')}」优先级 {score}，加入待发送"
            f"（队列 {len(self._queue)}）"
        )
        self.flush_due()

    def tick(self) -> None:
        self.flush_due()

    def flush_due(self) -> None:
        while self._queue:
            if not self._capacity():
                self._capacity_hint()
                return
            if time.time() < self.next_send_at:
                return
            job, data, payload = self._queue.popleft()
            self._send(job, data, payload)

    def finish(self) -> None:
        self.flush_due()
        if self._queue:
            self.log(
                f"  [内联] 还有 {len(self._queue)} 个高优先级岗位未到发送间隔，"
                "留给后续发送阶段"
            )
        self.close()

    def close(self) -> None:
        if self.client:
            self.client.close()
            self.client = None

    def _send(self, job: dict, data: dict, payload: dict) -> None:
        job_id = str(job.get("encryptJobId") or "")
        name = job.get("jobName") or (data.get("jobInfo") or {}).get("jobName")
        score = int(payload.get("priority_score") or 0)
        if self.dry_run:
            self.sent += 1
            self.today_sent += 1
            self.window_sent += 1
            self.next_send_at = time.time() + random.uniform(
                self.args.send_min_delay, self.args.send_max_delay
            )
            self.log(f"  [内联-干跑] 本应发送「{name}」（优先级 {score}）")
            return

        url = build_url(
            ADD_URL,
            {
                "securityId": data.get("securityId"),
                "jobId": job_id,
                "lid": data.get("lid"),
                "_": now_ms(),
            },
        )
        body = f"sessionId={data.get('sessionId') or ''}"
        self.log(f"  [内联发送] 向「{name}」发送沟通消息（优先级 {score}）...")
        try:
            check_response("发送消息接口", self._get_client().fetch_json(url, "POST", body))
        except AbortError as error:
            job_store.record_send_failed(self.conn, job_id, name, str(error))
            job_store.append_send_log(
                self.args.send_log, job_id, name, "failed", str(error)
            )
            if error.kind in ("login_invalid", "limit_reached", "environment_abnormal"):
                raise
            self.failed += 1
            self.next_send_at = time.time() + random.uniform(
                self.args.send_min_delay, self.args.send_max_delay
            )
            self.log(f"  [内联发送] 「{name}」失败：{error}")
            return
        except CdpError as error:
            job_store.record_send_failed(self.conn, job_id, name, str(error))
            job_store.append_send_log(
                self.args.send_log, job_id, name, "failed", str(error)
            )
            raise

        job_store.record_sent(self.conn, job_id, name)
        job_store.append_send_log(self.args.send_log, job_id, name, "sent")
        self.sent += 1
        self.today_sent += 1
        self.window_sent += 1
        self.next_send_at = time.time() + random.uniform(
            self.args.send_min_delay, self.args.send_max_delay
        )
        self.log(f"  [内联发送] 「{name}」→ 已发送")

    def summary(self) -> dict:
        return {
            "sent": self.sent,
            "failed": self.failed,
            "skipped": self.skipped,
            "queued_total": self.queued_total,
            "pending": len(self._queue),
            "details_seen": self.details_seen,
            "dry_run": self.dry_run,
        }


def run_send(args: argparse.Namespace, token: str | None, zp_token: str | None) -> tuple[int, dict]:
    print("\n[阶段] 按优先级发送沟通消息")
    allowed, reason = check_work_window(args)
    if not allowed:
        print(f"[跳过] {reason}，不发送消息")
        return EXIT_OFF_HOURS, {"skipped": "off_hours", "message": reason}
    if args.ignore_work_hours:
        print("[提示] 已忽略工作日/工作时间限制")
    else:
        print(
            f"允许发送时间：周{','.join(str(day) for day in sorted(args.work_days))} "
            f"{args.work_start.strftime('%H:%M')}-{args.work_end.strftime('%H:%M')}"
        )

    with job_store.connect(args.db) as conn:
        window = job_store.window_stats(conn, args.cooldown_hours, SEND_LIMIT_MAX)
        window_remaining = (
            SEND_LIMIT_MAX if args.force_window else window["remaining"]
        )
        if args.force_window:
            print("[提示] 已忽略 2 小时窗口限制，风险自负")
        if window_remaining <= 0:
            message = (
                f"2 小时窗口已满：{window['sent']}/{window['limit']}，"
                f"下一个额度约 {format_wait(window['next_slot_seconds'])}后释放"
            )
            print(f"[跳过] {message}")
            return EXIT_COOLDOWN, {
                "skipped": "window",
                "message": message,
                "window_sent": window["sent"],
                "window_limit": window["limit"],
            }

        today_sent = job_store.count_sent_today(conn)
        remaining_today = max(0, args.daily_limit - today_sent)
        if remaining_today <= 0:
            message = f"今日已发送 {today_sent} 条，达到每日上限 {args.daily_limit}，明天再发"
            print(f"[跳过] {message}")
            return EXIT_DAILY_LIMIT, {
                "skipped": "daily_limit",
                "message": message,
                "today_sent": today_sent,
                "daily_limit": args.daily_limit,
            }

        batch_limit = min(args.send_limit, window_remaining, remaining_today)
        rows = job_store.get_send_candidates(conn, args.pool_limit, batch_limit)
        if not rows:
            print("没有可发送的岗位（详情未成功、职位失效、boss 非近期活跃或已全部发送）")
            return 0, {"skipped": "no_candidates", "message": "没有可发送的岗位"}
        run_id = job_store.start_send_run(conn, len(rows))
        candidates = [dict(row) for row in rows]

    print(
        f"今日已发 {today_sent}/{args.daily_limit} 条，"
        f"2 小时窗口 {window['sent']}/{window['limit']}，本批最多 {batch_limit} 个"
    )
    print(f"发送候选：{len(candidates)} 个（优先级池上限 {args.pool_limit}，单批上限 {SEND_LIMIT_MAX}）")
    print(f"发送间隔：{args.send_min_delay:g}~{args.send_max_delay:g}s\n")

    get_client, cleanup = make_client_factory(args, token, zp_token)
    runner = QueueRunner(args.send_min_delay, args.send_max_delay, cleanup=cleanup)

    def guarded_send(row: dict):
        """每条发送前再检查一次工作时间，避免批次跨到下班时间继续发。"""

        def task() -> dict:
            allowed_now, reason_now = check_work_window(args)
            if not allowed_now:
                print(f"[停止] {reason_now}，剩余任务不再发送")
                runner.stop(reason_now)
                return {"jobName": row.get("job_name"), "skipped": "off_hours"}
            return make_send_task(row, get_client, args.db, args.send_log)()

        return task

    total = len(candidates)
    for index, row in enumerate(candidates, 1):
        runner.enqueue(
            f"发送 {index}/{total}「{row.get('job_name')}」", guarded_send(row)
        )
    run_queue(runner)

    if runner.abort and runner.abort.get("kind") in ("token_missing", "browser_error"):
        print_recovery(args, "send", runner.abort.get("kind") == "token_missing")

    sent = sum(
        1
        for item in runner.tasks
        if item.get("status") == "ok"
        and isinstance(item.get("result"), dict)
        and item["result"].get("sent") is True
    )
    with job_store.connect(args.db) as conn:
        run_status = runner.status
        if (
            sent == 0
            and runner.abort
            and runner.abort.get("kind") in ("token_missing", "browser_error")
        ):
            run_status = "auth_failed"
        job_store.finish_send_run(conn, run_id, sent, run_status, runner.stop_reason)

    summary = runner_summary(runner)
    summary["send_run_id"] = run_id
    summary["planned"] = len(candidates)
    summary["sent"] = sent
    summary["today_sent"] = today_sent + sent
    summary["daily_limit"] = args.daily_limit
    print(f"\n[发送] 结束：成功 {sent}/{len(candidates)}，今日累计 {today_sent + sent}/{args.daily_limit}，"
          f"状态 {runner.status}")

    if runner.status == "stopped" and "工作时间" in (runner.stop_reason or ""):
        return EXIT_OFF_HOURS, summary
    return runner_exit_code(runner), summary
