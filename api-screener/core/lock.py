#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""单实例锁：同一时间只允许一个 run_job_queue 操作页面和数据库。"""

from __future__ import annotations

import msvcrt
import os

from core.config import RUN_LOCK_FILE
from core.utils import now_iso

_run_lock_handle = None


def acquire_run_lock() -> bool:
    """同一时间只允许一个 run_job_queue，避免两个进程同时操作页面和数据库。"""
    global _run_lock_handle
    RUN_LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    handle = RUN_LOCK_FILE.open("a+", encoding="utf-8")
    handle.seek(0, os.SEEK_END)
    if handle.tell() == 0:
        handle.write(" ")
        handle.flush()
    handle.seek(0)
    try:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        handle.close()
        return False
    handle.seek(0)
    handle.truncate()
    handle.write(f"{os.getpid()} {now_iso()}\n")
    handle.flush()
    _run_lock_handle = handle
    return True


def release_run_lock() -> None:
    global _run_lock_handle
    if not _run_lock_handle:
        return
    try:
        _run_lock_handle.seek(0)
        msvcrt.locking(_run_lock_handle.fileno(), msvcrt.LK_UNLCK, 1)
    except OSError:
        pass
    _run_lock_handle.close()
    _run_lock_handle = None
