#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""采集：页面滚动抓包（默认）与接口直连（备用），详情入库并计算优先级。"""

from __future__ import annotations

import argparse
import random
import sqlite3
from pathlib import Path

from browser.auth import make_client_factory, print_recovery
from browser.cdp_client import CdpClient, CdpError
from browser.page_collect import PageCollectError, PageCollector
from core import console
from core.config import DETAIL_URL, EXIT_ABORTED
from core.errors import AbortError
from core.utils import build_url, check_response, now_iso, now_ms
from storage import job_store
from workflow.expectations import choose_expect, expect_city_from_text, load_list_params, make_expect_task
from workflow.queue_runner import QueueRunner, run_queue, runner_exit_code, runner_summary
from workflow.sending import InlineSender


def build_detail_payload(job: dict, data: dict) -> tuple[dict, dict]:
    """把详情响应转换为入库字段；返回 (payload, jobInfo)。"""
    job_info = data.get("jobInfo") or {}
    boss_info = data.get("bossInfo") or {}
    brand_info = data.get("brandComInfo") or {}
    score, tags = job_store.score_priority(
        {
            "job_name": job_info.get("jobName") or job.get("jobName"),
            "position_name": job_info.get("positionName"),
            "labels": job.get("jobLabels") or [],
            "skills": job_info.get("showSkills") or job.get("skills") or [],
        }
    )
    payload = {
        "fetched_at": now_iso(),
        "detail_security_id": data.get("securityId"),
        "detail_lid": data.get("lid"),
        "session_id": data.get("sessionId"),
        "position_name": job_info.get("positionName"),
        "location_name": job_info.get("locationName"),
        "address": job_info.get("address"),
        "post_description": job_info.get("postDescription"),
        "invalid_status": bool(job_info.get("invalidStatus")),
        "job_name": job_info.get("jobName"),
        "salary_desc": job_info.get("salaryDesc"),
        "job_experience": job_info.get("experienceName"),
        "job_degree": job_info.get("degreeName"),
        "boss_name": boss_info.get("name"),
        "boss_title": boss_info.get("title"),
        "boss_online": 1 if boss_info.get("bossOnline") else 0,
        "boss_active_desc": boss_info.get("activeTimeDesc"),
        "brand_name": brand_info.get("brandName"),
        "brand_industry": brand_info.get("industryName"),
        "brand_scale": brand_info.get("scaleName"),
        "brand_stage": brand_info.get("stageName"),
        "priority_score": score,
        "priority_tags": tags,
    }
    return payload, job_info


def make_list_task(
    runner: QueueRunner,
    get_client,
    params_file: Path,
    pages: int,
    page_delay: tuple[float, float],
    detail_limit: int,
    db_path: Path,
    expect_state: dict,
):
    """列表任务：按求职期望分页抓取、按岗位 id 去重覆写，然后追加详情任务。"""

    def task() -> dict:
        list_url, base_query = load_list_params(params_file)
        expect = expect_state.get("expect") or {}
        jobs_by_id: dict[str, dict] = {}
        pages_done = 0
        for page in range(1, pages + 1):
            query = dict(base_query)
            query["page"] = page
            query["_"] = now_ms()
            if expect.get("encryptId"):
                # 与页面一致：选中具体期望时 city 留空，用 encryptExpectId 指定
                query["city"] = ""
                query["encryptExpectId"] = expect["encryptId"]
            resp = check_response(
                f"列表接口(page={page})",
                get_client().fetch_json(build_url(list_url, query), "GET"),
            )
            zp_data = resp.get("zpData") or {}
            jobs = zp_data.get("jobList") or []
            for job in jobs:
                job_id = job.get("encryptJobId")
                if job_id:
                    jobs_by_id[job_id] = job  # 重复岗位直接覆写
            pages_done = page
            print(f"    第 {page} 页：{len(jobs)} 条，累计去重 {len(jobs_by_id)} 条")
            if not jobs or not zp_data.get("hasMore"):
                break
            if page < pages:
                delay = random.uniform(*page_delay)
                print(f"    等待 {delay:.1f}s 后请求下一页")
                if not runner.wait(delay):
                    raise AbortError("stopped", "收到终止信号，列表分页停止")

        if not jobs_by_id:
            raise AbortError("empty_list", "列表接口没有返回职位")

        selected = list(jobs_by_id.values())
        if detail_limit > 0:
            selected = selected[:detail_limit]
        with job_store.connect(db_path) as conn:
            job_store.upsert_list_jobs(conn, selected)

        for job in selected:
            runner.enqueue(f"详情#{job.get('jobName')}", make_detail_task(job, get_client, db_path))

        return {"pages": pages_done, "unique": len(jobs_by_id), "planned_details": len(selected)}

    return task


def make_detail_task(job: dict, get_client, db_path: Path):
    """详情任务：补全岗位信息、计算优先级并写入 SQLite。"""

    def task() -> dict:
        job_id = job.get("encryptJobId")
        url = build_url(
            DETAIL_URL,
            {
                "securityId": job.get("securityId"),
                "lid": job.get("lid"),
                "_": now_ms(),
            },
        )
        try:
            resp = check_response("详情接口", get_client().fetch_json(url, "GET"))
        except AbortError as error:
            with job_store.connect(db_path) as conn:
                job_store.mark_detail_failed(conn, job_id, str(error))
            raise

        data = resp.get("zpData") or {}
        job_info = data.get("jobInfo") or {}
        if not job_info:
            with job_store.connect(db_path) as conn:
                job_store.mark_detail_failed(conn, job_id, "详情缺少 jobInfo")
            raise AbortError("empty_detail", f"详情缺少 jobInfo：{job.get('jobName')}")
        if job_info.get("encryptId") != job_id:
            message = f"详情与列表职位不一致：{job_info.get('encryptId')} != {job_id}"
            with job_store.connect(db_path) as conn:
                job_store.mark_detail_failed(conn, job_id, message)
            raise AbortError("job_mismatch", message)
        if not data.get("securityId") or not data.get("lid"):
            with job_store.connect(db_path) as conn:
                job_store.mark_detail_failed(conn, job_id, "详情缺少 securityId/lid")
            raise AbortError("empty_detail", f"详情缺少 securityId/lid：{job.get('jobName')}")

        payload, _ = build_detail_payload(job, data)
        score = payload["priority_score"]
        tags = payload["priority_tags"]

        with job_store.connect(db_path) as conn:
            job_store.save_detail(conn, job_id, payload)

        if job_info.get("invalidStatus"):
            return {"jobName": job.get("jobName"), "invalid": True}
        return {
            "jobName": job_info.get("jobName") or job.get("jobName"),
            "brandName": job.get("brandName"),
            "salaryDesc": job_info.get("salaryDesc") or job.get("salaryDesc"),
            "priority": score,
            "tags": tags,
        }

    return task


def run_collect_page(args: argparse.Namespace, token: str | None, zp_token: str | None) -> tuple[int, dict]:
    """页面模式：滚动列表、点击卡片，只抓浏览器自己发出的请求。"""
    print("\n[阶段] 页面滚动采集（浏览器内抓包）")
    list_target = args.list_target or args.detail_limit
    print(f"目标岗位：详情 {args.detail_limit} 条、列表 {list_target} 条，滚动次数上限：{args.max_scrolls}")
    print(f"滚动间隔：{args.scroll_min_delay:g}~{args.scroll_max_delay:g}s，"
          f"点击间隔：{args.detail_min_delay:g}~{args.detail_max_delay:g}s")
    print(f"数据库：{args.db}\n")

    client = CdpClient(cdp_url=args.cdp_url, page_match=args.page_match, timeout=args.timeout)
    sender: InlineSender | None = None
    try:
        client.connect()
        print(f"[浏览器] 已连接：{client.page_url}")
        console.step(2, "确认职位页与岗位列表")
        collector = PageCollector(client, input_mode=args.input_mode)
        collector.wait_ready()
        if args.input_mode == "os":
            print("采集中脚本会随机滚动、切换标签页/应用，请不要手动操作鼠标和窗口\n")
        tabs = collector.expect_tabs()
        chosen_city = args.expect_city
        if tabs:
            index = choose_expect(args, tabs)
            chosen_city = expect_city_from_text(tabs[index - 1]) or args.expect_city
            selected = collector.select_expect(index, chosen_city)
            if selected:
                console.step(4, f"开始采集（列表 {list_target} 条、详情 {args.detail_limit} 条）")
                collector.scroll_to_top()
                print(f"列表已渲染：{collector.wait_for_cards()} 张卡片")
                ok, cities = collector.verify_city(chosen_city)
                if not ok:
                    raise PageCollectError(
                        f"期望「{selected}」返回的岗位城市不是「{chosen_city}」：{cities}"
                    )
                collector.reset_list(chosen_city)
            else:
                raise PageCollectError(
                    f"未能切换到期望「{tabs[index - 1]}」，请确认页面后重试"
                )
        else:
            console.step(3, "页面未识别到求职期望标签，使用当前列表")
            console.step(4, "开始采集")

        saved = 0
        failed = 0
        saved_ids: set[str] = set()

        with job_store.connect(args.db) as conn:
            known = {
                row[0]
                for row in conn.execute(
                    "SELECT encrypt_job_id FROM jobs WHERE detail_status='ok'"
                )
            }
            if known:
                print(f"已有详情 {len(known)} 条，采集时跳过这些岗位")

            if args.stage == "all":
                sender = InlineSender(args, token, zp_token, conn, log=print)
                print(
                    f"[内联] 已开启：优先级 >= {args.inline_min_priority}，"
                    f"预热 {args.inline_warmup} 个详情，随机跳过 {args.inline_skip_rate:.0%}"
                )

            def persist(job_id: str, job: dict, data: dict, allow_send: bool) -> None:
                nonlocal saved, failed
                job_info = data.get("jobInfo") or {}
                if not job_id or not job_info:
                    if job_id:
                        job_store.mark_detail_failed(conn, job_id, "详情缺少 jobInfo")
                    failed += 1
                    return
                if job_info.get("encryptId") != job_id:
                    job_store.mark_detail_failed(conn, job_id, "详情岗位 id 与列表不一致")
                    failed += 1
                    return
                payload, _ = build_detail_payload(job, data)
                job_store.save_detail(conn, job_id, payload)
                saved += 1
                saved_ids.add(job_id)
                if sender and allow_send:
                    sender.consider(job, data, payload)

            def on_detail(job: dict, data: dict) -> None:
                persist(str(job.get("encryptJobId") or ""), job, data, allow_send=True)

            def on_tick() -> None:
                if sender:
                    sender.tick()

            jobs, details = collector.collect_interleaved(
                target=list_target,
                detail_limit=args.detail_limit,
                max_scrolls=args.max_scrolls,
                delay=(args.scroll_min_delay, args.scroll_max_delay),
                detail_delay=(args.detail_min_delay, args.detail_max_delay),
                skip_ids=known,
                city=chosen_city or None,
                on_detail=on_detail,
                on_tick=on_tick,
            )
            job_by_id = {job.get("encryptJobId"): job for job in jobs}
            console.info(f"抓取完成：列表 {len(jobs)} 条、详情 {len(details)} 条，开始整理入库")
            job_store.upsert_list_jobs(conn, jobs)
            for job_id, data in details.items():
                if job_id not in saved_ids:
                    persist(str(job_id), job_by_id.get(job_id) or {}, data, allow_send=False)
            if sender:
                sender.finish()
                info = sender.summary()
                if info["dry_run"]:
                    console.info(
                        f"内联干跑：本应发送 {info['sent']} 条，"
                        f"随机跳过 {info['skipped']} 条，待发 {info['pending']} 条"
                    )
                else:
                    console.info(
                        f"内联发送：成功 {info['sent']} 条，失败 {info['failed']} 条，"
                        f"随机跳过 {info['skipped']} 条，待发 {info['pending']} 条"
                    )
            exported = job_store.export_json(conn, args.export_json, args.pool_limit)

        console.info(f"入库完成：详情成功 {saved} 条，失败 {failed} 条")
        console.info(
            f"数据库共 {exported['total_in_db']} 条，导出 {exported['exported']} 条"
            f" -> {args.export_json}"
        )
        return 0, {
            "mode": "page",
            "expectTabs": tabs,
            "collected": len(jobs),
            "details_ok": saved,
            "details_failed": failed,
            "jobs_in_db": exported["total_in_db"],
            "exported": str(args.export_json),
            "inline": sender.summary() if sender else None,
        }
    except AbortError as error:
        console.error(f"内联发送终止：{error}")
        return EXIT_ABORTED, {
            "mode": "page",
            "error": str(error),
            "inline": sender.summary() if sender else None,
        }
    except CdpError as error:
        console.error(f"浏览器连接/发送失败：{error}")
        print_recovery(args, "collect", "auth_missing" in str(error))
        return EXIT_ABORTED, {
            "mode": "page",
            "error": str(error),
            "inline": sender.summary() if sender else None,
        }
    except PageCollectError as error:
        console.error(f"页面采集失败：{error}")
        return EXIT_ABORTED, {
            "mode": "page",
            "error": str(error),
            "inline": sender.summary() if sender else None,
        }
    except sqlite3.OperationalError as error:
        console.error(f"数据库写入失败：{error}")
        console.info("可能还有另一个脚本在运行；请先退出那个终端，或检查 data/run.lock")
        return EXIT_ABORTED, {"mode": "page", "error": str(error)}
    finally:
        if sender:
            sender.close()
        client.close()
        print("[浏览器] 已断开")


def run_collect(args: argparse.Namespace, token: str | None, zp_token: str | None) -> tuple[int, dict]:
    """采集入口：默认页面模式，api 模式保留为备用。"""
    if args.collect_mode == "page":
        return run_collect_page(args, token, zp_token)

    params_file = Path(args.list_params)
    if not params_file.is_file():
        raise SystemExit(f"找不到列表参数文件：{params_file}")

    print("== 阶段 1/2：求职期望 → 列表 → 详情 → 整理入库 ==")
    print(f"列表参数：{params_file}")
    print(f"列表页数上限：{args.list_pages}，详情上限：{args.detail_limit}")
    print(f"页间隔：{args.list_page_min_delay:g}~{args.list_page_max_delay:g}s，"
          f"详情间隔：{args.detail_min_delay:g}~{args.detail_max_delay:g}s")
    print(f"数据库：{args.db}\n")

    get_client, cleanup = make_client_factory(args, token, zp_token)
    runner = QueueRunner(args.detail_min_delay, args.detail_max_delay, cleanup=cleanup)
    expect_state: dict = {}
    runner.enqueue(
        "求职期望",
        make_expect_task(
            get_client,
            expect_state,
            Path(args.expect_file),
            args.expect_index,
            params_file,
        ),
    )
    runner.enqueue(
        "列表接口",
        make_list_task(
            runner,
            get_client,
            params_file,
            args.list_pages,
            (args.list_page_min_delay, args.list_page_max_delay),
            args.detail_limit,
            Path(args.db),
            expect_state,
        ),
    )
    run_queue(runner)

    if runner.abort and runner.abort.get("kind") in ("token_missing", "browser_error"):
        print_recovery(args, "collect", runner.abort.get("kind") == "token_missing")

    with job_store.connect(args.db) as conn:
        exported = job_store.export_json(conn, args.export_json, args.pool_limit)
    print(f"\n整理完成：数据库共 {exported['total_in_db']} 条，导出 {exported['exported']} 条 -> {args.export_json}")

    summary = runner_summary(runner)
    summary["db"] = str(args.db)
    summary["exported"] = str(args.export_json)
    summary["jobs_in_db"] = exported["total_in_db"]
    summary["expect"] = expect_state.get("expect")
    return runner_exit_code(runner), summary
