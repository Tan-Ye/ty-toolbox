#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 Reqable MCP 服务采集全部抓包记录，整理并保存接口信息。

前置条件:
  1. Reqable 已启动，并在 设置 -> API服务 中启用 API 服务。
  2. 已取得 Reqable 访问令牌，填入 config.json 的 token 字段，或设置环境变量 REQABLE_TOKEN。

用法示例:
  python collect_apis.py
  python collect_apis.py --list-tabs
  python collect_apis.py --tab-name 抖音 --limit 50
  python collect_apis.py --with-curl --max-body-chars 0

输出文件（默认 ./data）:
  raw_records.jsonl  原始抓包记录，一条一行，含完整请求/响应信息
  apis.json          按 方法+协议+host+path 去重后的接口清单
  apis.csv           接口清单表格版，便于 Excel 查看
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.json"
SAMPLE_CHARS = 2000

CAPTURE_TAB_TYPES = {
    "captureLive",
    "captureTemporarySession",
    "captureReviewFile",
    "captureReviewHistory",
    "captureReviewFavorite",
}

DEFAULT_CONFIG = {
    "mcp_server_exe": "",
    "host": "127.0.0.1",
    "port": 9000,
    "token": "",
    "tab_id": "",
    "tab_name": "",
    "output_dir": "data",
    "max_body_chars": 200000,
    "request_timeout": 60,
}


class McpError(RuntimeError):
    """MCP 通信或工具调用失败。"""


class ReqableMcpClient:
    """以 stdio 方式驱动 Reqable 内置的 mcp-server.exe。"""

    def __init__(self, exe: Path, host: str, port: int, token: str, timeout: float):
        env = os.environ.copy()
        env["REQABLE_TOKEN"] = token
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            self._proc = subprocess.Popen(
                [str(exe), "--host", host, "--port", str(port), "--scope", "all"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
                creationflags=creationflags,
            )
        except OSError as exc:
            raise McpError(f"无法启动 Reqable MCP 服务：{exe}（{exc}）") from exc

        self._messages: queue.Queue = queue.Queue()
        self._stderr_lines: list[str] = []
        self._timeout = timeout
        self._next_id = 0
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        self._initialize()

    def _read_stdout(self) -> None:
        assert self._proc.stdout is not None
        for raw in self._proc.stdout:
            self._messages.put(raw.decode("utf-8", "replace").strip())
        self._messages.put(None)

    def _read_stderr(self) -> None:
        assert self._proc.stderr is not None
        for raw in self._proc.stderr:
            line = raw.decode("utf-8", "replace").strip()
            if line:
                self._stderr_lines.append(line)
                del self._stderr_lines[:-30]

    def _send(self, payload: dict) -> None:
        if self._proc.poll() is not None:
            raise McpError("Reqable MCP 服务已退出。" + self._stderr_hint())
        assert self._proc.stdin is not None
        self._proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        self._proc.stdin.flush()

    def _stderr_hint(self) -> str:
        if not self._stderr_lines:
            return ""
        return " MCP 错误输出：" + " | ".join(self._stderr_lines[-5:])

    def request(self, method: str, params: dict | None = None) -> dict:
        self._next_id += 1
        request_id = self._next_id
        payload = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        self._send(payload)

        deadline = time.monotonic() + self._timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise McpError(f"MCP 调用超时（{self._timeout}s）：{method}")
            try:
                line = self._messages.get(timeout=remaining)
            except queue.Empty:
                raise McpError(f"MCP 调用超时（{self._timeout}s）：{method}") from None
            if line is None:
                raise McpError("Reqable MCP 服务已退出。" + self._stderr_hint())
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") != request_id:
                continue  # 忽略通知或非本次请求的消息
            if "error" in message:
                error = message["error"]
                text = error.get("message") if isinstance(error, dict) else str(error)
                raise McpError(f"MCP 请求失败（{method}）：{text}")
            result = message.get("result")
            return result if isinstance(result, dict) else {}

    def notify(self, method: str) -> None:
        self._send({"jsonrpc": "2.0", "method": method})

    def _initialize(self) -> None:
        self.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "api-screener", "version": "0.1.0"},
            },
        )
        self.notify("notifications/initialized")

    def call_tool(self, name: str, arguments: dict) -> dict:
        result = self.request("tools/call", {"name": name, "arguments": arguments})
        text = _result_text(result)
        if result.get("isError"):
            if "access token" in text.lower():
                raise McpError(
                    "Reqable 访问令牌缺失或无效。请在 Reqable 的 设置 -> API服务"
                    "（或 工具 -> MCP服务器）中复制访问令牌，填入 "
                    f"{CONFIG_PATH} 的 token 字段，或设置环境变量 REQABLE_TOKEN。"
                )
            raise McpError(f"{name} 调用失败：{text or '未知错误'}")
        structured = result.get("structuredContent")
        if isinstance(structured, dict):
            return structured
        if text:
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError:
                return {"text": text}
            if isinstance(parsed, dict):
                return parsed
        return {}

    def close(self) -> None:
        if self._proc.poll() is not None:
            return
        try:
            self._proc.terminate()
            self._proc.wait(timeout=3)
        except Exception:
            try:
                self._proc.kill()
            except Exception:
                pass


def _result_text(result: dict) -> str:
    parts: list[str] = []
    for item in result.get("content") or []:
        if isinstance(item, dict) and item.get("type") == "text":
            value = item.get("text")
            if isinstance(value, str):
                parts.append(value)
    return "\n".join(parts)


def load_config() -> dict:
    config = dict(DEFAULT_CONFIG)
    if CONFIG_PATH.is_file():
        with CONFIG_PATH.open("r", encoding="utf-8") as handle:
            loaded = json.load(handle)
        if isinstance(loaded, dict):
            config.update({key: loaded[key] for key in DEFAULT_CONFIG if key in loaded})
    return config


def find_mcp_server(configured: str) -> Path:
    candidates: list[Path] = []
    if configured:
        candidates.append(Path(configured))
    found = shutil.which("mcp-server.exe")
    if found:
        candidates.append(Path(found))
    for base in (
        os.environ.get("ProgramFiles"),
        os.environ.get("ProgramFiles(x86)"),
        os.environ.get("LOCALAPPDATA"),
    ):
        if base:
            candidates.append(Path(base) / "Reqable" / "mcp-server.exe")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise McpError(
        "未找到 Reqable 的 mcp-server.exe，请在 config.json 的 mcp_server_exe 中填写完整路径。"
    )


def resolve_token(cli_token: str, config_token: str) -> str:
    token = (cli_token or os.environ.get("REQABLE_TOKEN") or config_token or "").strip()
    if not token or token == "您的令牌":
        raise McpError(
            "未配置 Reqable 访问令牌。请在 Reqable 的 设置 -> API服务"
            "（或 工具 -> MCP服务器）中复制访问令牌，填入 "
            f"{CONFIG_PATH} 的 token 字段，或设置环境变量 REQABLE_TOKEN。"
        )
    return token


def print_tabs(tabs: list[dict]) -> None:
    if not tabs:
        print("Reqable 当前没有打开的标签页。")
        return
    print(f"{'ID':<28} {'类型':<24} 名称")
    print("-" * 80)
    for tab in tabs:
        print(f"{str(tab.get('id', '')):<28} {str(tab.get('type', '')):<24} {tab.get('name', '')}")


def select_tab(tabs: list[dict], tab_id: str, tab_name: str) -> dict:
    if tab_id:
        for tab in tabs:
            if str(tab.get("id")) == str(tab_id):
                return tab
        raise McpError(f"未找到 ID 为 {tab_id} 的标签页，可用标签页：\n" + _tabs_text(tabs))

    candidates = [tab for tab in tabs if tab.get("type") in CAPTURE_TAB_TYPES]
    if not candidates:
        raise McpError("Reqable 当前没有抓包标签页，请先打开实时抓包或抓包文件。\n" + _tabs_text(tabs))

    if tab_name:
        keyword = tab_name.lower()
        matched = [tab for tab in candidates if keyword in str(tab.get("name", "")).lower()]
        if not matched:
            raise McpError(f"没有名称包含「{tab_name}」的抓包标签页：\n" + _tabs_text(candidates))
        candidates = matched

    for tab in candidates:
        if tab.get("type") == "captureLive":
            return tab
    return candidates[0]


def _tabs_text(tabs: list[dict]) -> str:
    return "\n".join(
        f"  - {tab.get('id')} [{tab.get('type')}] {tab.get('name', '')}" for tab in tabs
    )


def trim_record(record: dict, max_body_chars: int) -> dict:
    if max_body_chars <= 0:
        return record
    for section in ("request", "response"):
        container = record.get(section)
        if isinstance(container, dict):
            container["body"] = _trim_body(container.get("body"), max_body_chars)
    return record


def _trim_body(body: object, max_chars: int) -> object:
    if not isinstance(body, dict):
        return body
    text = body.get("text")
    if isinstance(text, str) and len(text) > max_chars:
        body = dict(body)
        body["original_chars"] = len(text)
        body["text"] = text[:max_chars]
        body["truncated"] = True
    return body


def unwrap_record(data: dict) -> dict:
    record = data.get("record")
    if isinstance(record, dict):
        return record
    return data


def headers_to_dict(headers: object) -> dict:
    result: dict[str, str] = {}
    if not isinstance(headers, list):
        return result
    for header in headers:
        if not isinstance(header, dict):
            continue
        name = header.get("name")
        value = header.get("value")
        if not isinstance(name, str) or not name:
            continue
        value = "" if value is None else str(value)
        if name in result:
            result[name] = f"{result[name]}, {value}"
        else:
            result[name] = value
    return result


def header_value(headers: dict, name: str) -> str | None:
    for key, value in headers.items():
        if key.lower() == name.lower():
            return value
    return None


def body_sample(body: object) -> tuple[str | None, str | None]:
    if not isinstance(body, dict):
        return None, None
    text = body.get("text")
    mime = body.get("mime")
    sample = text[:SAMPLE_CHARS] if isinstance(text, str) else None
    return sample, mime if isinstance(mime, str) else None


def add_unique(values: list, value: object) -> None:
    if value is None or value == "":
        return
    if value not in values:
        values.append(value)


def build_api_entry(record: dict) -> tuple[str, dict]:
    url = record.get("url") or ""
    parts = urlsplit(url)
    request = record.get("request") or {}
    method = str(request.get("method") or "UNKNOWN").upper()
    scheme = (parts.scheme or "http").lower()
    host = parts.hostname or ""
    port = parts.port
    path = parts.path or "/"
    netloc = host
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        netloc = f"{host}:{port}"
    key = f"{method} {scheme}://{netloc}{path}"
    query_keys = sorted({name for name, _ in parse_qsl(parts.query, keep_blank_values=True)})
    entry = {
        "key": key,
        "method": method,
        "scheme": scheme,
        "host": host,
        "port": port,
        "path": path,
        "query_keys": query_keys,
        "sample_url": url,
        "count": 0,
        "capture_ids": [],
        "first_capture_id": None,
        "last_capture_id": None,
        "first_time": None,
        "last_time": None,
        "status_codes": [],
        "content_types": [],
        "protocols": [],
        "applications": [],
        "request": {"headers": {}, "body_mime": None, "body_sample": None},
        "response": {"status": None, "body_mime": None, "body_sample": None},
        "curl": None,
    }
    return key, entry


def update_api_entry(entry: dict, record: dict, capture_id: int) -> None:
    request = record.get("request") or {}
    response = record.get("response") or {}
    timestamp = (record.get("connection") or {}).get("timestamp")

    entry["count"] += 1
    entry["capture_ids"].append(capture_id)
    if entry["first_capture_id"] is None:
        entry["first_capture_id"] = capture_id
        entry["first_time"] = timestamp
    entry["last_capture_id"] = capture_id
    entry["last_time"] = timestamp

    parts = urlsplit(record.get("url") or "")
    for name in (n for n, _ in parse_qsl(parts.query, keep_blank_values=True)):
        if name not in entry["query_keys"]:
            entry["query_keys"].append(name)
    entry["query_keys"].sort()

    add_unique(entry["status_codes"], response.get("code"))
    add_unique(entry["protocols"], record.get("protocol"))

    app = record.get("application")
    if isinstance(app, dict):
        add_unique(entry["applications"], app.get("name"))

    req_headers = headers_to_dict(request.get("headers"))
    resp_headers = headers_to_dict(response.get("headers"))
    req_sample, req_mime = body_sample(request.get("body"))
    resp_sample, resp_mime = body_sample(response.get("body"))
    content_type = resp_mime or header_value(resp_headers, "content-type")
    add_unique(entry["content_types"], content_type)

    if not entry["request"]["headers"]:
        entry["request"] = {
            "headers": req_headers,
            "body_mime": req_mime,
            "body_sample": req_sample,
        }
    if entry["response"]["status"] is None:
        entry["response"] = {
            "status": response.get("status"),
            "body_mime": resp_mime,
            "body_sample": resp_sample,
        }
    entry["status_codes"].sort(key=lambda value: (value is None, value))


def write_outputs(
    out_dir: Path,
    tab: dict,
    all_ids: list[int],
    failed_ids: list[int],
    apis: list[dict],
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "collected_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": {
            "tool": "Reqable MCP",
            "tab": tab,
            "total_capture_ids": len(all_ids),
            "fetched_records": sum(api["count"] for api in apis),
            "failed_ids": failed_ids,
        },
        "total_apis": len(apis),
        "apis": apis,
    }
    apis_path = out_dir / "apis.json"
    with apis_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)

    csv_path = out_dir / "apis.csv"
    fieldnames = [
        "method",
        "scheme",
        "host",
        "port",
        "path",
        "query_keys",
        "sample_url",
        "count",
        "status_codes",
        "content_types",
        "protocols",
        "applications",
        "first_capture_id",
        "last_capture_id",
        "first_time",
        "last_time",
    ]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for api in apis:
            row = {name: api.get(name) for name in fieldnames}
            for name in ("query_keys", "status_codes", "content_types", "protocols", "applications"):
                row[name] = " | ".join(str(item) for item in api.get(name) or [])
            writer.writerow(row)

    print(f"\n完成：共 {len(apis)} 个接口")
    print(f"  接口清单 : {apis_path}")
    print(f"  表格清单 : {csv_path}")
    print(f"  原始记录 : {out_dir / 'raw_records.jsonl'}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="采集 Reqable 全部抓包记录并整理为接口清单")
    parser.add_argument("--token", default="", help="Reqable 访问令牌，默认读取 REQABLE_TOKEN 或 config.json")
    parser.add_argument("--host", default="", help="Reqable API 服务地址，默认 127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="Reqable API 服务端口，默认 9000")
    parser.add_argument("--mcp-exe", default="", help="mcp-server.exe 路径，默认自动查找")
    parser.add_argument("--tab-id", default="", help="指定抓包标签页 ID")
    parser.add_argument("--tab-name", default="", help="按名称关键字选择抓包标签页")
    parser.add_argument("--limit", type=int, default=0, help="只采集前 N 条记录，默认全部")
    parser.add_argument("--out-dir", default="", help="输出目录，默认 ./data")
    parser.add_argument("--max-body-chars", type=int, default=-1, help="Body 最大保存字符数，0 表示不截断")
    parser.add_argument("--with-curl", action="store_true", help="为每个接口生成 cURL 命令")
    parser.add_argument("--list-tabs", action="store_true", help="只列出 Reqable 标签页后退出")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    config = load_config()

    token = resolve_token(args.token, str(config.get("token", "")))
    exe = find_mcp_server(args.mcp_exe or str(config.get("mcp_server_exe", "")))
    host = args.host or str(config.get("host") or "127.0.0.1")
    port = args.port or int(config.get("port") or 9000)
    timeout = float(config.get("request_timeout") or 60)
    max_body_chars = args.max_body_chars if args.max_body_chars >= 0 else int(config.get("max_body_chars", 200000))
    out_dir = Path(args.out_dir) if args.out_dir else BASE_DIR / str(config.get("output_dir", "data"))
    if not out_dir.is_absolute():
        out_dir = BASE_DIR / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    client = ReqableMcpClient(exe, host, port, token, timeout)
    try:
        tabs = (client.call_tool("tab_list", {}) or {}).get("tabs") or []
        if args.list_tabs:
            print_tabs(tabs)
            return 0

        tab = select_tab(tabs, args.tab_id or str(config.get("tab_id") or ""), args.tab_name or str(config.get("tab_name") or ""))
        print(f"抓包标签页：{tab.get('name', '')} [{tab.get('type')}] (id={tab.get('id')})")

        filter_result = client.call_tool("capture_record_filter", {"tabId": str(tab["id"]), "filters": []})
        raw_ids = filter_result.get("items") or []
        ids = sorted({int(value) for value in raw_ids if isinstance(value, (int, str)) and str(value).isdigit()})
        if args.limit > 0:
            ids = ids[: args.limit]
        if not ids:
            print("当前标签页没有抓包记录。")
            return 1
        print(f"共发现 {len(ids)} 条抓包记录，开始获取详情...")

        apis: dict[str, dict] = {}
        failed_ids: list[int] = []
        fetched = 0
        raw_path = out_dir / "raw_records.jsonl"
        with raw_path.open("w", encoding="utf-8") as raw_file:
            for index, capture_id in enumerate(ids, 1):
                try:
                    record = unwrap_record(
                        client.call_tool(
                            "capture_record_get_by_id",
                            {"tabId": str(tab["id"]), "id": capture_id},
                        )
                    )
                except McpError as exc:
                    failed_ids.append(capture_id)
                    print(f"[{index}/{len(ids)}] #{capture_id} 获取失败：{exc}")
                    continue

                if not record.get("url"):
                    failed_ids.append(capture_id)
                    print(f"[{index}/{len(ids)}] #{capture_id} 返回数据为空，已跳过")
                    continue

                trim_record(record, max_body_chars)
                raw_file.write(json.dumps(record, ensure_ascii=False) + "\n")
                raw_file.flush()

                key, entry = build_api_entry(record)
                if key not in apis:
                    apis[key] = entry
                update_api_entry(apis[key], record, capture_id)

                fetched += 1
                method = entry["method"]
                print(f"[{index}/{len(ids)}] #{capture_id} {method} {record.get('url')}")

        if not apis:
            print("没有采集到任何记录。")
            return 1

        api_list = sorted(apis.values(), key=lambda item: item["first_capture_id"] or 0)

        if args.with_curl:
            print("\n正在生成 cURL 命令...")
            for index, api in enumerate(api_list, 1):
                try:
                    result = client.call_tool(
                        "capture_record_generate_curl",
                        {"tabId": str(tab["id"]), "id": int(api["first_capture_id"])},
                    )
                    curl = result.get("curl") or result.get("command") or result.get("text")
                    if isinstance(curl, str):
                        api["curl"] = curl
                except McpError as exc:
                    print(f"[{index}/{len(api_list)}] {api['key']} 生成 cURL 失败：{exc}")

        write_outputs(out_dir, tab, ids, failed_ids, api_list)
        if failed_ids:
            print(f"注意：{len(failed_ids)} 条记录获取失败：{failed_ids}")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except McpError as error:
        print(f"[错误] {error}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n已中断。", file=sys.stderr)
        sys.exit(130)
