#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""业务异常。"""

from __future__ import annotations


class AbortError(Exception):
    """请求返回错误或非正常结果，队列应立即终止。"""

    def __init__(self, kind: str, message: str, payload: dict | None = None):
        super().__init__(message)
        self.kind = kind
        self.payload = payload or {}
