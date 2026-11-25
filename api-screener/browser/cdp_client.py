#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""最小化原生 CDP 客户端（websocket），替代 Playwright。

为什么不用 Playwright：
  BOSS 页面带反调试检测，Playwright 的 page.evaluate 会启用 Runtime 域，
  页面检测到后每十几秒整页重载一次（实测 20 秒 16 次），根本无法采集。
  本模块只调用 Runtime.evaluate（不开启 Runtime 域）和 Network.enable，
  实测页面可以稳定存活 5 分钟以上；鼠标点击/滚轮用 Input.dispatchMouseEvent。

不使用 Page.enable / Debugger.enable / Runtime.enable，避免被页面感知。
"""

from __future__ import annotations

import itertools
import json
import random
import select
import time
import urllib.request
from typing import Callable

import websocket  # websocket-client

LIST_URL_KEY = "/wapi/zpgeek/pc/recommend/job/list.json"
DETAIL_URL_KEY = "/wapi/zpgeek/job/detail.json"

PROBE_JS = r"""(() => {
  const jar = {};
  try {
    for (const part of document.cookie.split(';')) {
      const item = part.trim();
      if (!item) continue;
      const index = item.indexOf('=');
      if (index > 0) jar[item.slice(0, index)] = item.slice(index + 1);
    }
  } catch (error) {}
  const candidates = [];
  for (const storeName of ['localStorage', 'sessionStorage']) {
    try {
      const store = window[storeName];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (/token/i.test(key)) candidates.push(storeName + ':' + key);
      }
    } catch (error) {}
  }
  for (const key of Object.keys(jar)) {
    if (/token/i.test(key) && !/stoken/i.test(key)) candidates.push('cookie:' + key);
  }
  return {
    url: location.href,
    readyState: document.readyState,
    cookieNames: Object.keys(jar),
    hasBst: Boolean(jar['bst']),
    tokenCandidates: candidates,
  };
})()"""

FETCH_JS = r"""async (payload) => {
  const { url, method, body, tokenOverride, zpTokenOverride, requireToken, requireZpToken, timeoutMs } = payload;
  const jar = {};
  try {
    for (const part of document.cookie.split(';')) {
      const item = part.trim();
      if (!item) continue;
      const index = item.indexOf('=');
      if (index > 0) jar[item.slice(0, index)] = item.slice(index + 1);
    }
  } catch (error) {}
  const candidates = [];
  const add = (source, key, value) => {
    if (typeof value === 'string' && value.length >= 8 && value.length <= 128) {
      candidates.push({ source, key, value });
    }
  };
  for (const storeName of ['localStorage', 'sessionStorage']) {
    try {
      const store = window[storeName];
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        if (/token/i.test(key)) add(storeName, key, store.getItem(key));
      }
    } catch (error) {}
  }
  for (const [key, value] of Object.entries(jar)) {
    if (/token/i.test(key) && !/stoken/i.test(key)) add('cookie', key, value);
  }
  const token = tokenOverride
    ? { source: 'override', key: 'token', value: tokenOverride }
    : (candidates.find((item) => item.key.toLowerCase() === 'token')
      || candidates.find((item) => item.value.length === 16)
      || candidates[0]
      || null);
  const zpToken = zpTokenOverride || jar['bst'] || null;
  const missing = [];
  if (requireToken && !token) missing.push('token');
  if (requireZpToken && !zpToken) missing.push('zp_token');
  if (missing.length) return { ok: false, error: 'auth_missing', missing };

  const headers = {
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest',
    traceid: 'F-' + Array.from({ length: 25 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join(''),
  };
  if (token) headers.token = token.value;
  if (zpToken) headers.zp_token = zpToken;
  if (method === 'POST') headers['content-type'] = 'application/x-www-form-urlencoded';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method === 'POST' ? (body || '') : undefined,
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });
    const text = await response.text();
    return { ok: true, status: response.status, text };
  } catch (error) {
    return { ok: false, error: 'fetch_failed', message: String(error) };
  } finally {
    clearTimeout(timer);
  }
}"""


class CdpError(RuntimeError):
    """CDP 连接或命令失败。"""


class CdpClient:
    """一条到 BOSS 标签页的 CDP 连接，支持执行 JS、鼠标点击/滚轮、抓响应体。"""

    def __init__(
        self,
        cdp_url: str = "http://127.0.0.1:9222",
        page_match: str = "zhipin.com",
        timeout: float = 30,
        capture: bool = True,
        log: Callable[[str], None] = print,
    ):
        self.cdp_url = cdp_url.rstrip("/")
        self.page_match = page_match
        self.timeout = timeout
        self.capture = capture
        self.log = log
        self.page_url = ""
        self.target_id = ""
        self._ws = None
        self._ids = itertools.count(1)
        self._pending_bodies: dict[str, tuple[str, str]] = {}
        self._results: dict[int, dict] = {}
        self._mouse = (600.0, 500.0)
        self.list_payloads: list[dict] = []
        self.detail_payloads: list[dict] = []

    # ---------- 连接 ----------

    def connect(self) -> None:
        try:
            with urllib.request.urlopen(self.cdp_url + "/json/list", timeout=self.timeout) as resp:
                targets = json.load(resp)
        except Exception as error:  # noqa: BLE001
            raise CdpError(
                f"连接 Chrome 调试端口失败：{self.cdp_url}\n"
                f"第一步：先运行 python start_chrome.py 启动调试 Chrome，并手动登录 BOSS；\n"
                f"第二步：登录后再运行本命令。\n原始错误：{error}"
            ) from error

        pages = [t for t in targets if t.get("type") == "page"]
        page = next((t for t in pages if self.page_match in (t.get("url") or "")), None)
        if page is None:
            raise CdpError(
                f"没有找到匹配「{self.page_match}」的标签页，当前标签页："
                + json.dumps([t.get("url") for t in pages], ensure_ascii=False)
            )
        try:
            self._ws = websocket.create_connection(
                page["webSocketDebuggerUrl"],
                timeout=self.timeout,
                suppress_origin=True,
                enable_multithread=False,
            )
        except Exception as error:  # noqa: BLE001
            raise CdpError(f"连接标签页失败：{error}") from error
        self.page_url = page.get("url") or ""
        self.target_id = page.get("id") or ""
        if self.capture:
            self.call("Network.enable")

    def close(self) -> None:
        if self._ws is not None:
            try:
                self._ws.close()
            except Exception:  # noqa: BLE001
                pass
            self._ws = None

    # ---------- 标签页切换（模拟人离开当前页） ----------

    def list_pages(self) -> list[dict]:
        """列出可切换的标签页；走 HTTP 接口，不会触发页面脚本。"""
        try:
            with urllib.request.urlopen(self.cdp_url + "/json/list", timeout=5) as resp:
                targets = json.load(resp)
        except Exception:  # noqa: BLE001
            return []
        return [item for item in targets if item.get("type") == "page" and item.get("id")]

    def activate_page(self, target_id: str) -> bool:
        """把指定标签页切到前台（GET /json/activate，不发 Runtime 命令）。"""
        try:
            with urllib.request.urlopen(
                self.cdp_url + f"/json/activate/{target_id}", timeout=5
            ) as resp:
                resp.read()
            return True
        except Exception:  # noqa: BLE001
            return False

    def switch_other_tab(self, seconds: float) -> bool:
        """切到另一个标签页停留一会再切回来；没有其他标签页返回 False。"""
        others = [item for item in self.list_pages() if item.get("id") != self.target_id]
        if not others:
            return False
        other = random.choice(others)
        if not self.activate_page(other["id"]):
            return False
        self.pump(max(0.2, seconds))
        return self.activate_page(self.target_id)

    # ---------- 命令/事件 ----------

    def call(self, method: str, params: dict | None = None, timeout: float | None = None) -> dict:
        if self._ws is None:
            raise CdpError("CDP 尚未连接")
        message_id = next(self._ids)
        self._ws.send(json.dumps({"id": message_id, "method": method, "params": params or {}}))
        deadline = time.time() + (timeout or self.timeout)
        while time.time() < deadline:
            result = self._results.pop(message_id, None)
            if result is not None:
                if "error" in result:
                    raise CdpError(f"{method} 失败：{result['error'].get('message')}")
                return result.get("result") or {}
            message = self._recv_message(max(0.05, deadline - time.time()))
            if message is None:
                break
            self._dispatch(message)
        result = self._results.pop(message_id, None)
        if result is not None:
            if "error" in result:
                raise CdpError(f"{method} 失败：{result['error'].get('message')}")
            return result.get("result") or {}
        raise CdpError(f"{method} 超时")

    def _dispatch(self, message: dict) -> None:
        """命令响应按 id 缓存（嵌套调用时不会丢），事件交给 _on_event。"""
        if "id" in message:
            self._results[message["id"]] = message
        elif "method" in message:
            self._on_event(message)

    def _recv_message(self, timeout: float) -> dict | None:
        """用 select 等可读再收完整消息，避免超时把帧读断。"""
        if self._ws is None:
            return None
        try:
            readable, _, _ = select.select([self._ws.sock], [], [], timeout)
        except (OSError, ValueError) as error:
            raise CdpError(f"CDP 连接已断开：{error}") from error
        if not readable:
            return None
        try:
            raw = self._ws.recv()
        except websocket.WebSocketConnectionClosedException as error:
            raise CdpError("CDP 连接已断开，请重新执行") from error
        except (OSError, websocket.WebSocketException) as error:
            raise CdpError(f"CDP 接收失败：{error}") from error
        if not raw:
            raise CdpError("CDP 连接已断开，请重新执行")
        return json.loads(raw)

    def pump(self, seconds: float) -> None:
        """持续接收事件若干秒（滚动/点击后等待页面自己发请求）。"""
        deadline = time.time() + seconds
        while self._ws is not None and time.time() < deadline:
            message = self._recv_message(min(0.3, max(0.02, deadline - time.time())))
            if message is not None:
                self._dispatch(message)

    def _on_event(self, message: dict) -> None:
        method = message.get("method")
        params = message.get("params") or {}
        if method == "Network.responseReceived" and self.capture:
            url = params.get("response", {}).get("url", "")
            kind = None
            if LIST_URL_KEY in url:
                kind = "list"
            elif DETAIL_URL_KEY in url:
                kind = "detail"
            if kind:
                self._fetch_body(params.get("requestId"), url, kind)
        elif method == "Network.loadingFinished" and self._pending_bodies:
            request_id = params.get("requestId")
            pending = self._pending_bodies.get(request_id)
            if pending:
                self._fetch_body(request_id, pending[0], pending[1], retry=False)

    def _fetch_body(self, request_id: str | None, url: str, kind: str, retry: bool = True) -> None:
        if not request_id:
            return
        try:
            result = self.call("Network.getResponseBody", {"requestId": request_id}, timeout=10)
            text = result.get("body") or ""
            if result.get("base64Encoded"):
                import base64

                text = base64.b64decode(text).decode("utf-8", "replace")
            data = json.loads(text)
        except Exception:  # noqa: BLE001 - 响应体还没准备好，等 loadingFinished 再取
            if retry:
                self._pending_bodies[request_id] = (url, kind)
            return
        self._pending_bodies.pop(request_id, None)
        item = {"url": url, "data": data}
        if kind == "list":
            self.list_payloads.append(item)
        else:
            self.detail_payloads.append(item)

    # ---------- 页面操作 ----------

    def evaluate(self, expression: str, timeout: float | None = None):
        result = self.call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "awaitPromise": True},
            timeout=timeout,
        )
        if result.get("exceptionDetails"):
            detail = result["exceptionDetails"]
            text = (detail.get("exception") or {}).get("description") or detail.get("text") or "未知错误"
            raise CdpError(f"页面脚本执行失败：{str(text)[:200]}")
        return (result.get("result") or {}).get("value")

    def mouse_move(self, x: float, y: float, steps: int | None = None) -> None:
        """分多步移动到目标点，带弧度与随机停顿，模拟人手而不是瞬移。"""
        sx, sy = self._mouse
        steps = steps or random.randint(14, 30)
        # 控制点随机偏移，走出轻微弧线
        cx = (sx + x) / 2 + random.uniform(-80, 80)
        cy = (sy + y) / 2 + random.uniform(-50, 50)
        for index in range(1, steps + 1):
            t = index / steps
            ease = t * t * (3 - 2 * t)  # smoothstep：先快后慢
            px = (1 - ease) ** 2 * sx + 2 * (1 - ease) * ease * cx + ease ** 2 * x
            py = (1 - ease) ** 2 * sy + 2 * (1 - ease) * ease * cy + ease ** 2 * y
            self.call(
                "Input.dispatchMouseEvent",
                {"type": "mouseMoved", "x": px, "y": py, "button": "none", "buttons": 0},
                timeout=8,
            )
            # 每步间隔不均等，越接近目标越慢
            time.sleep(random.uniform(0.008, 0.035) * (1 + t))
        self._mouse = (x, y)

    def click(self, x: float, y: float, human: bool = True) -> None:
        """CSS 坐标点击（视口坐标，不是屏幕坐标）。human=True 时带鼠标轨迹。"""
        if human:
            self.mouse_move(x, y)
            time.sleep(random.uniform(0.08, 0.4))  # 落点后短暂停顿再按
        base = {"x": float(x), "y": float(y), "button": "left"}
        self.call(
            "Input.dispatchMouseEvent",
            {**base, "type": "mousePressed", "buttons": 1, "clickCount": 1},
            timeout=10,
        )
        time.sleep(random.uniform(0.06, 0.16))  # 按住时长
        self.call(
            "Input.dispatchMouseEvent",
            {**base, "type": "mouseReleased", "buttons": 0, "clickCount": 1},
            timeout=10,
        )

    def wheel(self, x: float, y: float, delta_y: float) -> None:
        self.call(
            "Input.dispatchMouseEvent",
            {"type": "mouseWheel", "x": float(x), "y": float(y), "deltaX": 0, "deltaY": float(delta_y)},
            timeout=10,
        )

    def fetch_json(self, url: str, method: str = "GET", body: str | None = None) -> dict:
        """在页面上下文里 fetch（携带 Cookie / token），返回解析后的 JSON。"""
        payload = {
            "url": url,
            "method": method.upper(),
            "body": body or "",
            "tokenOverride": self.token,
            "zpTokenOverride": self.zp_token,
            "requireToken": True,
            "requireZpToken": True,
            "timeoutMs": int(self.timeout * 1000),
        }
        script = f"({FETCH_JS})({json.dumps(payload, ensure_ascii=False)})"
        result = self.evaluate(script, timeout=self.timeout + 10)
        if not result or not result.get("ok"):
            error = (result or {}).get("error", "unknown")
            missing = (result or {}).get("missing")
            raise CdpError(f"页面内 fetch 失败：{error} {missing or ''}".strip())
        try:
            return json.loads(result.get("text") or "")
        except json.JSONDecodeError:
            return {"_raw": (result.get("text") or "")[:2000]}


class CdpFetchClient(CdpClient):
    """兼容 BrowserFetchClient 的接口（connect/probe/fetch_json/close），供接口模式使用。"""

    def __init__(
        self,
        cdp_url: str = "http://127.0.0.1:9222",
        page_match: str = "zhipin.com",
        token: str | None = None,
        zp_token: str | None = None,
        timeout: float = 30,
    ):
        super().__init__(cdp_url=cdp_url, page_match=page_match, timeout=timeout, capture=False)
        self.token = token
        self.zp_token = zp_token

    def probe(self) -> dict:
        return self.evaluate(PROBE_JS)
