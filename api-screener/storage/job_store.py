#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""岗位与发送记录的 SQLite 存储。

表结构:
  jobs       岗位主表，encryptJobId 为主键；列表重复出现时覆写列表字段，详情单独合并，
             沟通状态不会被覆写。

附带:
  - 发送日志追加到 send_log.jsonl（成功只记一条，失败保留异常信息）
  - 整理结果导出为 jobs.json（只保留 boss/岗位/详情/优先级/发送状态等关键字段）
"""

from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterable

from core import console
from core.config import BASE_DIR, PRIORITY_KEYWORDS_FILE

DB_FILE = BASE_DIR / "data" / "zhipin" / "zhipin.db"
EXPORT_FILE = BASE_DIR / "data" / "zhipin" / "jobs.json"
SEND_LOG_FILE = BASE_DIR / "data" / "zhipin" / "send_log.jsonl"

# 内置默认关键词：params/priority_keywords.json 缺失或无效时使用
DEFAULT_PRIORITY_KEYWORDS = (
    ("ai", 3),
    ("人工智能", 3),
    ("大模型", 3),
    ("llm", 3),
    ("aigc", 2),
    ("agent", 2),
    ("python", 3),
    ("nodejs", 2),
    ("node", 2),
    ("typescript", 2),
    ("ts", 2),
    ("javascript", 2),
    ("js", 2),
)

# 按文件修改时间缓存，运行期间改配置也能生效
_PRIORITY_CACHE: tuple[float, tuple[tuple[str, int], ...]] | None = None


def load_priority_keywords() -> tuple[tuple[str, int], ...]:
    """读取用户自定义的优先级关键词；文件缺失或无效时回退默认值。"""
    global _PRIORITY_CACHE
    try:
        mtime = PRIORITY_KEYWORDS_FILE.stat().st_mtime
    except OSError:
        return DEFAULT_PRIORITY_KEYWORDS
    if _PRIORITY_CACHE is not None and _PRIORITY_CACHE[0] == mtime:
        return _PRIORITY_CACHE[1]

    try:
        data = json.loads(PRIORITY_KEYWORDS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        console.error(f"优先级关键词配置读取失败，改用默认值：{exc}")
        _PRIORITY_CACHE = (mtime, DEFAULT_PRIORITY_KEYWORDS)
        return DEFAULT_PRIORITY_KEYWORDS

    items = data.get("keywords") if isinstance(data, dict) else None
    keywords: list[tuple[str, int]] = []
    seen: set[str] = set()
    for item in items or []:
        if isinstance(item, dict):
            keyword, weight = item.get("keyword"), item.get("weight")
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            keyword, weight = item
        else:
            continue
        if not isinstance(keyword, str) or not keyword.strip():
            continue
        try:
            weight = int(weight)
        except (TypeError, ValueError):
            continue
        if weight <= 0:
            continue
        normalized = keyword.strip().lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        keywords.append((keyword.strip(), weight))

    if not keywords:
        console.error(f"优先级关键词为空或格式不正确，改用默认值：{PRIORITY_KEYWORDS_FILE}")
        _PRIORITY_CACHE = (mtime, DEFAULT_PRIORITY_KEYWORDS)
        return DEFAULT_PRIORITY_KEYWORDS

    result = tuple(keywords)
    _PRIORITY_CACHE = (mtime, result)
    return result

# boss 活跃度白名单：只给今日活跃或 3 日内活跃的 boss 发消息
ACTIVE_DESC_KEYWORDS = (
    "刚刚",
    "今日",
    "今天",
    "在线",
    "1日内",
    "2日内",
    "3日内",
    "一日内",
    "两日内",
    "三日内",
    "昨日",
    "昨天",
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    encrypt_job_id TEXT PRIMARY KEY,
    job_name TEXT,
    brand_name TEXT,
    salary_desc TEXT,
    city_name TEXT,
    area_district TEXT,
    business_district TEXT,
    job_experience TEXT,
    job_degree TEXT,
    job_labels TEXT,
    skills TEXT,
    encrypt_boss_id TEXT,
    boss_name TEXT,
    boss_title TEXT,
    boss_cert INTEGER,
    boss_online INTEGER,
    list_security_id TEXT,
    list_lid TEXT,
    expect_id INTEGER,
    list_seen_at TEXT,
    detail_status TEXT DEFAULT 'pending',
    detail_error TEXT,
    detail_fetched_at TEXT,
    detail_security_id TEXT,
    detail_lid TEXT,
    session_id TEXT,
    position_name TEXT,
    location_name TEXT,
    address TEXT,
    post_description TEXT,
    invalid_status INTEGER DEFAULT 0,
    boss_active_desc TEXT,
    brand_industry TEXT,
    brand_scale TEXT,
    brand_stage TEXT,
    priority_score INTEGER DEFAULT 0,
    priority_tags TEXT,
    send_status TEXT,
    sent_at TEXT,
    send_error TEXT,
    created_at TEXT,
    updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_priority ON jobs(priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_send ON jobs(send_status);
"""


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


@contextmanager
def connect(db_path: str | Path = DB_FILE):
    """打开数据库并在退出时提交、关闭（sqlite 的 with 不会自动关连接）。"""
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        conn.executescript(SCHEMA)
        yield conn
        conn.commit()
    except BaseException:
        # 采集中途被终止时（包括 Ctrl+C / SystemExit），已经写入的详情/发送记录不能丢
        try:
            conn.commit()
        except sqlite3.Error:
            pass
        raise
    finally:
        conn.close()


def _loads(value: Any, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default


UPSERT_LIST_SQL = """
INSERT INTO jobs (
    encrypt_job_id, job_name, brand_name, salary_desc, city_name, area_district,
    business_district, job_experience, job_degree, job_labels, skills,
    encrypt_boss_id, boss_name, boss_title, boss_cert, boss_online,
    list_security_id, list_lid, expect_id, list_seen_at, created_at, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(encrypt_job_id) DO UPDATE SET
    job_name = excluded.job_name,
    brand_name = excluded.brand_name,
    salary_desc = excluded.salary_desc,
    city_name = excluded.city_name,
    area_district = excluded.area_district,
    business_district = excluded.business_district,
    job_experience = excluded.job_experience,
    job_degree = excluded.job_degree,
    job_labels = excluded.job_labels,
    skills = excluded.skills,
    encrypt_boss_id = excluded.encrypt_boss_id,
    boss_name = excluded.boss_name,
    boss_title = excluded.boss_title,
    boss_cert = excluded.boss_cert,
    boss_online = excluded.boss_online,
    list_security_id = excluded.list_security_id,
    list_lid = excluded.list_lid,
    expect_id = excluded.expect_id,
    list_seen_at = excluded.list_seen_at,
    updated_at = excluded.updated_at
"""


def upsert_list_jobs(conn: sqlite3.Connection, jobs: Iterable[dict], seen_at: str | None = None) -> int:
    """写入/覆写列表字段；重复岗位按 encryptJobId 覆盖，不影响详情和发送状态。"""
    seen_at = seen_at or now_iso()
    count = 0
    for job in jobs:
        job_id = job.get("encryptJobId")
        if not job_id:
            continue
        conn.execute(
            UPSERT_LIST_SQL,
            (
                job_id,
                job.get("jobName"),
                job.get("brandName"),
                job.get("salaryDesc"),
                job.get("cityName"),
                job.get("areaDistrict"),
                job.get("businessDistrict"),
                job.get("jobExperience"),
                job.get("jobDegree"),
                json.dumps(job.get("jobLabels") or [], ensure_ascii=False),
                json.dumps(job.get("skills") or [], ensure_ascii=False),
                job.get("encryptBossId"),
                job.get("bossName"),
                job.get("bossTitle"),
                job.get("bossCert"),
                1 if job.get("bossOnline") else 0,
                job.get("securityId"),
                job.get("lid"),
                job.get("expectId"),
                seen_at,
                seen_at,
                seen_at,
            ),
        )
        count += 1
    return count


SAVE_DETAIL_SQL = """
UPDATE jobs SET
    detail_status = 'ok',
    detail_error = NULL,
    detail_fetched_at = :fetched_at,
    detail_security_id = :detail_security_id,
    detail_lid = :detail_lid,
    session_id = :session_id,
    position_name = :position_name,
    location_name = :location_name,
    address = :address,
    post_description = :post_description,
    invalid_status = :invalid_status,
    job_name = COALESCE(:job_name, job_name),
    salary_desc = COALESCE(:salary_desc, salary_desc),
    job_experience = COALESCE(:job_experience, job_experience),
    job_degree = COALESCE(:job_degree, job_degree),
    boss_name = COALESCE(:boss_name, boss_name),
    boss_title = COALESCE(:boss_title, boss_title),
    boss_online = COALESCE(:boss_online, boss_online),
    boss_active_desc = :boss_active_desc,
    brand_name = COALESCE(:brand_name, brand_name),
    brand_industry = :brand_industry,
    brand_scale = :brand_scale,
    brand_stage = :brand_stage,
    priority_score = :priority_score,
    priority_tags = :priority_tags,
    updated_at = :updated_at
WHERE encrypt_job_id = :encrypt_job_id
"""

# 列表 payload 可能晚于详情到达；详情先到时直接插入，避免 UPDATE 0 行被静默丢弃
INSERT_DETAIL_SQL = """
INSERT INTO jobs (
    encrypt_job_id, job_name, salary_desc, job_experience, job_degree,
    boss_name, boss_title, boss_online, boss_active_desc, brand_name,
    brand_industry, brand_scale, brand_stage, detail_status, detail_fetched_at,
    detail_security_id, detail_lid, session_id, position_name, location_name,
    address, post_description, invalid_status, priority_score, priority_tags,
    created_at, updated_at
) VALUES (
    :encrypt_job_id, :job_name, :salary_desc, :job_experience, :job_degree,
    :boss_name, :boss_title, :boss_online, :boss_active_desc, :brand_name,
    :brand_industry, :brand_scale, :brand_stage, 'ok', :fetched_at,
    :detail_security_id, :detail_lid, :session_id, :position_name, :location_name,
    :address, :post_description, :invalid_status, :priority_score, :priority_tags,
    :updated_at, :updated_at
)
"""


def save_detail(conn: sqlite3.Connection, job_id: str, payload: dict) -> None:
    """合并详情字段；payload 中缺失的键补 None，发送状态保持不变。"""
    params = {
        "encrypt_job_id": job_id,
        "fetched_at": payload.get("fetched_at") or now_iso(),
        "detail_security_id": payload.get("detail_security_id"),
        "detail_lid": payload.get("detail_lid"),
        "session_id": payload.get("session_id"),
        "position_name": payload.get("position_name"),
        "location_name": payload.get("location_name"),
        "address": payload.get("address"),
        "post_description": payload.get("post_description"),
        "invalid_status": 1 if payload.get("invalid_status") else 0,
        "job_name": payload.get("job_name"),
        "salary_desc": payload.get("salary_desc"),
        "job_experience": payload.get("job_experience"),
        "job_degree": payload.get("job_degree"),
        "boss_name": payload.get("boss_name"),
        "boss_title": payload.get("boss_title"),
        "boss_online": payload.get("boss_online"),
        "boss_active_desc": payload.get("boss_active_desc"),
        "brand_name": payload.get("brand_name"),
        "brand_industry": payload.get("brand_industry"),
        "brand_scale": payload.get("brand_scale"),
        "brand_stage": payload.get("brand_stage"),
        "priority_score": int(payload.get("priority_score") or 0),
        "priority_tags": json.dumps(payload.get("priority_tags") or [], ensure_ascii=False),
        "updated_at": payload.get("updated_at") or now_iso(),
    }
    cursor = conn.execute(SAVE_DETAIL_SQL, params)
    if cursor.rowcount == 0:
        conn.execute(INSERT_DETAIL_SQL, params)


def mark_detail_failed(conn: sqlite3.Connection, job_id: str, error: str) -> None:
    at = now_iso()
    cursor = conn.execute(
        "UPDATE jobs SET detail_status='failed', detail_error=?, detail_fetched_at=?, updated_at=? "
        "WHERE encrypt_job_id=?",
        (str(error)[:500], at, at, job_id),
    )
    if cursor.rowcount == 0:
        conn.execute(
            "INSERT INTO jobs (encrypt_job_id, detail_status, detail_error, detail_fetched_at, "
            "created_at, updated_at) VALUES (?, 'failed', ?, ?, ?, ?)",
            (job_id, str(error)[:500], at, at, at),
        )


def score_priority(fields: dict) -> tuple[int, list[str]]:
    """按岗位名/标签/技能/职位名打分；关键词与权重可在 params/priority_keywords.json 自定义。"""
    parts: list[str] = []
    for value in fields.values():
        if isinstance(value, (list, tuple)):
            parts.extend(str(item) for item in value if item)
        elif value:
            parts.append(str(value))
    text = " ".join(parts).lower()
    score = 0
    matched: list[str] = []
    for keyword, weight in load_priority_keywords():
        if keyword.isascii():
            pattern = rf"(?<![a-z0-9]){re.escape(keyword)}(?![a-z0-9])"
            hit = re.search(pattern, text) is not None
        else:
            hit = keyword in text
        if hit:
            score += weight
            matched.append(keyword)
    return score, matched


def count_sent_today(conn: sqlite3.Connection, day: str | None = None) -> int:
    """统计当天已成功发送的数量（sent_at 前 10 位是本地日期）。"""
    day = day or datetime.now().astimezone().date().isoformat()
    row = conn.execute(
        "SELECT COUNT(*) FROM jobs WHERE send_status='sent' AND substr(sent_at, 1, 10)=?",
        (day,),
    ).fetchone()
    return int(row[0])


def record_sent(conn: sqlite3.Connection, job_id: str, job_name: str | None, at: str | None = None) -> None:
    at = at or now_iso()
    cursor = conn.execute(
        "UPDATE jobs SET send_status='sent', sent_at=?, send_error=NULL, updated_at=? WHERE encrypt_job_id=?",
        (at, at, job_id),
    )
    if cursor.rowcount == 0:
        conn.execute(
            "INSERT INTO jobs (encrypt_job_id, job_name, send_status, sent_at, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (job_id, job_name, "sent", at, at, at),
        )


def record_send_failed(conn: sqlite3.Connection, job_id: str, job_name: str | None, error: str) -> None:
    at = now_iso()
    cursor = conn.execute(
        "UPDATE jobs SET send_status='failed', send_error=?, updated_at=? WHERE encrypt_job_id=?",
        (str(error)[:500], at, job_id),
    )
    if cursor.rowcount == 0:
        conn.execute(
            "INSERT INTO jobs (encrypt_job_id, job_name, send_status, send_error, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (job_id, job_name, "failed", str(error)[:500], at, at),
        )


def append_send_log(
    path: str | Path,
    job_id: str,
    job_name: str | None,
    status: str,
    error: str | None = None,
) -> None:
    """发送调用日志：成功一行，失败额外带上异常信息。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    line = {"time": now_iso(), "job_id": job_id, "job_name": job_name, "status": status}
    if error:
        line["error"] = str(error)[:500]
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(line, ensure_ascii=False) + "\n")


def is_active(boss_online: int | bool | None, active_desc: str | None) -> bool:
    """boss 是否今日/3 日内活跃（与发送候选的 SQL 口径一致）。"""
    if boss_online:
        return True
    text = str(active_desc or "")
    return any(keyword in text for keyword in ACTIVE_DESC_KEYWORDS)


def count_sent_since(conn: sqlite3.Connection, hours: float = 2.0) -> int:
    """滚动窗口内成功发送的数量。"""
    cutoff = (
        datetime.now().astimezone() - timedelta(hours=hours)
    ).isoformat(timespec="seconds")
    row = conn.execute(
        "SELECT COUNT(*) FROM jobs WHERE send_status='sent' AND sent_at >= ?",
        (cutoff,),
    ).fetchone()
    return int(row[0])


def next_window_slot(
    conn: sqlite3.Connection, hours: float = 2.0, limit: int = 30
) -> float:
    """窗口已满时，距离下一个发送额度释放的秒数；未满返回 0。"""
    now = datetime.now().astimezone()
    cutoff = (now - timedelta(hours=hours)).isoformat(timespec="seconds")
    rows = conn.execute(
        "SELECT sent_at FROM jobs WHERE send_status='sent' AND sent_at >= ? "
        "ORDER BY sent_at DESC LIMIT ?",
        (cutoff, int(limit)),
    ).fetchall()
    if len(rows) < int(limit):
        return 0.0
    oldest = datetime.fromisoformat(rows[-1]["sent_at"])
    return max(0.0, (oldest + timedelta(hours=hours) - now).total_seconds())


def window_stats(
    conn: sqlite3.Connection, hours: float = 2.0, limit: int = 30
) -> dict:
    sent = count_sent_since(conn, hours)
    return {
        "hours": hours,
        "limit": int(limit),
        "sent": sent,
        "remaining": max(0, int(limit) - sent),
        "next_slot_seconds": next_window_slot(conn, hours, limit) if sent >= limit else 0.0,
    }


def today_stats(conn: sqlite3.Connection) -> dict:
    """今日采集与发送概况，用于启动面板。"""
    today = datetime.now().astimezone().date().isoformat()

    def count(sql: str, *params: Any) -> int:
        row = conn.execute(sql, params).fetchone()
        return int(row[0]) if row else 0

    return {
        "collected": count(
            "SELECT COUNT(*) FROM jobs WHERE substr(list_seen_at, 1, 10)=?", today
        ),
        "details_ok": count(
            "SELECT COUNT(*) FROM jobs WHERE detail_status='ok' "
            "AND substr(detail_fetched_at, 1, 10)=?",
            today,
        ),
        "sent": count_sent_today(conn, today),
        "failed": count(
            "SELECT COUNT(*) FROM jobs WHERE send_status='failed' "
            "AND substr(updated_at, 1, 10)=?",
            today,
        ),
    }


def row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "encrypt_job_id": row["encrypt_job_id"],
        "job_name": row["job_name"],
        "brand_name": row["brand_name"],
        "salary_desc": row["salary_desc"],
        "city": row["city_name"],
        "area": row["area_district"],
        "business_district": row["business_district"],
        "experience": row["job_experience"],
        "degree": row["job_degree"],
        "labels": _loads(row["job_labels"], []),
        "skills": _loads(row["skills"], []),
        "boss": {
            "name": row["boss_name"],
            "title": row["boss_title"],
            "online": bool(row["boss_online"]),
            "cert": row["boss_cert"],
            "active": row["boss_active_desc"],
        },
        "brand": {
            "industry": row["brand_industry"],
            "scale": row["brand_scale"],
            "stage": row["brand_stage"],
        },
        "detail": {
            "status": row["detail_status"],
            "position_name": row["position_name"],
            "location": row["location_name"],
            "address": row["address"],
            "description": row["post_description"],
            "invalid": bool(row["invalid_status"]),
            "error": row["detail_error"],
        },
        "priority": {
            "score": row["priority_score"],
            "tags": _loads(row["priority_tags"], []),
        },
        "send": {
            "status": row["send_status"],
            "sent_at": row["sent_at"],
            "error": row["send_error"],
        },
        "list_seen_at": row["list_seen_at"],
    }


def export_json(conn: sqlite3.Connection, path: str | Path = EXPORT_FILE, limit: int = 150) -> dict:
    """导出优先级最高的 limit 个岗位，只保留关键字段。"""
    rows = conn.execute(
        "SELECT * FROM jobs ORDER BY priority_score DESC, list_seen_at DESC LIMIT ?",
        (int(limit),),
    ).fetchall()
    total = conn.execute("SELECT COUNT(*) FROM jobs").fetchone()[0]
    data = {
        "generated_at": now_iso(),
        "total_in_db": total,
        "exported": len(rows),
        "jobs": [row_to_dict(row) for row in rows],
    }
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data
