#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""通过真实页面交互采集岗位：滚动列表 + 点击卡片，抓取浏览器自身请求的响应。

为什么不直接 fetch 接口：BOSS 对接口调用有风控；这里让页面自己去请求。
为什么不用 Playwright：它的 Runtime.enable 会触发页面反调试并整页重载，
本模块改用 cdp_client.CdpClient（只发 Runtime.evaluate、不开启 Runtime 域）。

  - 列表：Windows SendInput 发送真实滚轮（失败时退回 CDP 滚轮），页面自己请求
    recommend/job/list.json，脚本从 Network 响应里读取 JSON；
  - 详情：CDP Input.dispatchMouseEvent 点击岗位卡片，页面自己请求 job/detail.json；
  - 沟通：达标岗位在详情页点击「立即沟通」，在“已向BOSS发送消息”弹窗中点
    「留在此页」，继续浏览，不跳转聊天页；
  - 每次滚动/点击之间都有随机间隔，行为接近正常浏览。

由 run_job_queue.py --collect-mode page 调用，一般不单独执行。
"""

from __future__ import annotations

import json
import random
import time
from typing import Callable

from browser.cdp_client import CdpClient
from browser.os_input import MouseController, MouseControllerError
from core import console
from core.errors import AbortError

CARD_SELECTOR = ".job-card-box"
EXPECT_TAB_SELECTOR = "a.expect-item"
CHAT_BUTTON_SELECTOR = "a.op-btn-chat"
# 问候弹窗有两套结构：旧版 zp-start-chat-greet-*，新版 greet-boss-dialog
CHAT_STAY_SELECTORS = (
    "a.zp-start-chat-greet-btn",       # 旧版：留在此页 / 继续沟通
    ".greet-boss-dialog .cancel-btn",  # 新版：留在此页
    "a, button",                       # 兜底：按“留在此页”文字找
)
CHAT_CLOSE_SELECTORS = (
    "span.zp-start-chat-greet-close",
    ".greet-boss-dialog .close",
)


class PageCollectError(RuntimeError):
    """页面结构变化或交互失败。"""


class PageCollector:
    def __init__(
        self,
        client: CdpClient,
        input_mode: str = "os",
        log: Callable[[str], None] = print,
    ):
        self.client = client
        self.log = log
        self.input_mode = input_mode
        self.mouse: MouseController | None = None
        if input_mode == "os":
            self.mouse = MouseController(log=log)
        self._list_cursor = 0
        self._has_more = True
        self._tabs: list[dict] = []
        self._expect_index = 0
        self._expect_city = ""
        self._nav_breaks = 0
        self.viewport = {"w": 1280, "h": 900}
        self._wheel_fallback = False
        self.scroll_count = 0
        self.refresh_count = 0

    # ---------- 页面状态 ----------

    def probe(self) -> dict:
        return self.client.evaluate(
            "(() => { const jar = {}; for (const p of document.cookie.split(';')) "
            "{ const i = p.indexOf('='); if (i > 0) jar[p.slice(0, i).trim()] = 1; } "
            "const cands = []; for (const s of ['localStorage','sessionStorage']) "
            "{ try { const st = window[s]; for (let i = 0; i < st.length; i++) "
            "{ const k = st.key(i); if (/token/i.test(k)) cands.push(k); } } catch (e) {} } "
            "return {url: location.href, readyState: document.readyState, "
            "cookieNames: Object.keys(jar), hasBst: Boolean(jar['bst']), tokenCandidates: cands}; })()"
        )

    def card_count(self) -> int:
        try:
            return int(self.client.evaluate(f"(() => document.querySelectorAll('{CARD_SELECTOR}').length)()") or 0)
        except Exception:  # noqa: BLE001
            return 0

    def _update_viewport(self) -> None:
        try:
            size = self.client.evaluate("(() => [innerWidth, innerHeight])()") or [1280, 900]
            self.viewport = {"w": float(size[0]), "h": float(size[1])}
        except Exception:  # noqa: BLE001
            pass

    def _url(self) -> str:
        try:
            return str(self.client.evaluate("(() => location.href)()") or "")
        except Exception:  # noqa: BLE001 - 页面跳转中读不到
            return ""

    def _nav_click(self, label: str) -> bool:
        """点顶部导航栏的链接（职位/消息等），优先 DOM 点击。"""
        script = r"""(label) => {
          const anchors = Array.from(document.querySelectorAll('a'));
          const link = anchors.find(a => {
            if ((a.innerText || '').trim() !== label) return false;
            const href = a.getAttribute('href') || '';
            return href.includes('/web/geek/') || href.includes('/web/boss/');
          });
          if (!link) return false;
          link.removeAttribute('target');
          link.click();
          return true;
        }"""
        try:
            return bool(self.client.evaluate(f"({script})({json.dumps(label, ensure_ascii=False)})"))
        except Exception:  # noqa: BLE001
            return False

    def ensure_jobs_page(self, timeout_ms: int = 25000) -> bool:
        """确认在职位页：不在就走导航栏「职位」进入。返回是否发生了导航。"""
        current = self._url()
        if "/web/geek/jobs" in current:
            return False
        self.log(f"    当前不在职位页（{current or '未知'}），通过导航栏进入「职位」")
        clicked = self._nav_click("职位")
        if not clicked:
            try:
                self.client.evaluate(
                    "(() => { location.href = 'https://www.zhipin.com/web/geek/jobs'; return true; })()"
                )
            except Exception:  # noqa: BLE001 - 跳转会中断当前调用
                pass
        if not self._wait(lambda: "/web/geek/jobs" in self._url(), 15000):
            raise PageCollectError(
                "导航到职位页失败，请手动打开 https://www.zhipin.com/web/geek/jobs 后重试"
            )
        self._wait(lambda: self.card_count() > 0, timeout_ms)
        return True

    def wait_ready(self, timeout_ms: int = 30000) -> None:
        """采集前先确认已登录、在职位页、岗位列表 DOM 已渲染，不做任何采集动作。"""
        try:
            probe = self.probe()
        except Exception as error:  # noqa: BLE001
            raise PageCollectError(f"读取浏览器登录状态失败：{error}") from error
        if not (probe.get("hasBst") or probe.get("tokenCandidates")):
            raise PageCollectError("当前 Chrome 未登录 BOSS，请先手动登录后再采集")
        self._update_viewport()
        if self.ensure_jobs_page(timeout_ms):
            self.client.pump(random.uniform(1.0, 2.0))
        if not self._wait(lambda: self.card_count() > 0, timeout_ms):
            raise PageCollectError(
                "岗位列表 DOM 未渲染（找不到 .job-card-box），请确认页面停留在职位推荐页"
            )
        self.log(f"    页面已就绪，当前看到 {self.card_count()} 个岗位")

    def wait_for_cards(self, timeout_ms: int = 20000) -> int:
        self._wait(lambda: self.card_count() > 0, timeout_ms)
        return self.card_count()

    def _wait(self, predicate, timeout_ms: int, interval: float = 0.3) -> bool:
        deadline = time.monotonic() + timeout_ms / 1000
        while time.monotonic() < deadline:
            if predicate():
                return True
            self.client.pump(interval)
        return predicate()

    # ---------- 求职期望 ----------

    def expect_tabs(self) -> list[str]:
        """读取页面上的求职期望标签（排除「推荐」）。"""
        script = (
            f"(() => Array.from(document.querySelectorAll('{EXPECT_TAB_SELECTOR}')).map(a => ({{"
            "text: (a.innerText || '').trim(), "
            "active: (a.className || '').toString().split(/\\s+/).includes('active'), "
            "x: a.getBoundingClientRect().left + a.getBoundingClientRect().width / 2, "
            "y: a.getBoundingClientRect().top + a.getBoundingClientRect().height / 2, "
            "visible: a.getBoundingClientRect().width > 0 && a.getBoundingClientRect().height > 0"
            "})).filter(t => t.text && t.text !== '推荐' && t.visible))()"
        )
        for _ in range(6):
            try:
                tabs = self.client.evaluate(script) or []
            except Exception:  # noqa: BLE001 - 页面跳转中读不到就重试
                tabs = []
            if tabs:
                self._tabs = tabs
                return [tab["text"] for tab in tabs]
            self.client.pump(1.0)
        return []

    def _click_tab(self, text: str) -> bool:
        """点击期望标签。用 DOM click：标签栏对鼠标悬停敏感，坐标点击容易落到相邻标签。"""
        tab = next((item for item in self._tabs if item["text"] == text), None)
        if not tab:
            return False
        try:
            return bool(self.client.evaluate(
                "(() => { const text = " + repr(text).replace("'", '"') + ";"
                " const a = Array.from(document.querySelectorAll('a.expect-item'))"
                ".find(x => (x.innerText || '').trim() === text);"
                " if (!a) return false; a.click(); return true; })()"
            ))
        except Exception:  # noqa: BLE001
            return False

    def select_expect(self, index: int = 0, city: str = "杭州", refresh: bool = True) -> str | None:
        """选择求职期望：index>0 按序号，否则按城市匹配。

        默认强制刷新：即使目标标签已选中，也重新点一次（必要时先点别的再点回来），
        确保列表从第一页重新加载，采集不会从上次滚动到的位置开始。
        """
        tabs = self.expect_tabs()
        if not tabs:
            return None
        self._expect_index = index
        self._expect_city = city
        if index > 0:
            if index > len(tabs):
                raise PageCollectError(f"页面只有 {len(tabs)} 个求职期望标签：{tabs}")
            target = tabs[index - 1]
        else:
            matches = [text for text in tabs if city and city in text]
            target = matches[0] if matches else tabs[0]

        current = next((tab for tab in self._tabs if tab["text"] == target), None)
        already = bool(current and current.get("active"))
        if already and not refresh:
            self.log(f"    期望已选中：{target}")
            return target

        if not already:
            before = len(self.client.list_payloads)
            if self._click_tab(target) and self._wait(
                lambda: len(self.client.list_payloads) > before, 15000
            ):
                self.log(f"    已切换期望：{target}")
                return target

        # 已选中或直接点击没抓包：点另一个期望再点回来，强制从第一页重新加载
        others = [text for text in tabs if text != target]
        if others:
            before = len(self.client.list_payloads)
            self._click_tab(others[0])
            self._wait(lambda: len(self.client.list_payloads) > before, 12000)
            before = len(self.client.list_payloads)
            if self._click_tab(target) and self._wait(
                lambda: len(self.client.list_payloads) > before, 15000
            ):
                self.log(f"    已切换期望：{target}")
                return target
        self.log(f"    [提示] 点击「{target}」后未捕获到列表请求")
        return None

    def verify_city(self, city: str) -> tuple[bool, list[str]]:
        """校验当前列表的岗位城市（优先用列表响应，没有则读页面卡片）。"""
        if not city:
            return True, []
        cities: list[str] = []
        if self.client.list_payloads:
            jobs = ((self.client.list_payloads[-1]["data"].get("zpData") or {}).get("jobList") or [])
            cities = [str(job.get("cityName") or "") for job in jobs]
        if not cities:
            try:
                lines = self.client.evaluate(
                    "(() => Array.from(document.querySelectorAll('.job-card-box')).slice(0, 5)"
                    ".map(li => (li.innerText || '').split('\\n').find(t => t.includes('·')) || ''))()"
                ) or []
                cities = [str(line).split("·")[0].strip() for line in lines if line]
            except Exception:  # noqa: BLE001
                cities = []
        hit = [name for name in cities if city in name]
        return bool(hit), cities[:5]

    # ---------- 偶发分心行为（人类不会一直专注采集） ----------

    def _nav_break(self) -> bool:
        """切到「消息」页看一眼再回「职位」页，然后选回原期望。"""
        if not self._nav_click("消息"):
            return False
        self.client.pump(random.uniform(2.0, 5.0))
        if not self._nav_click("职位"):
            return False
        if not self._wait(lambda: "/web/geek/jobs" in self._url(), 15000):
            return False
        if not self._wait(lambda: self.card_count() > 0, 25000):
            return False
        self.client.pump(random.uniform(0.6, 1.5))
        if self._expect_city or self._expect_index:
            # 页面重载后列表会回到默认推荐，重新选回原期望
            self.select_expect(self._expect_index, self._expect_city, refresh=False)
            self.client.pump(random.uniform(0.6, 1.5))
        return True

    def maybe_break(self, chance: float = 0.06, allow_nav: bool = False) -> bool:
        """按概率插入一次分心行为：切换标签页 / 切换应用 / 切导航页面。"""
        if random.random() >= chance:
            return False
        kinds = ["tab", "app"]
        weights = [0.55, 0.45]
        if allow_nav and (self._expect_city or self._expect_index) and self._nav_breaks < 1:
            kinds.append("nav")
            weights = [0.4, 0.35, 0.25]
        kind = random.choices(kinds, weights=weights, k=1)[0]
        if kind == "tab":
            seconds = random.uniform(2.0, 6.0)
            if self.client.switch_other_tab(seconds):
                self.log(f"    切到其他标签页看看，{seconds:.1f} 秒后回来")
                self.client.pump(random.uniform(0.4, 1.0))
                return True
        elif kind == "nav":
            self._nav_breaks += 1
            self.log("    去「消息」页面看一眼，再回职位页")
            if self._nav_break():
                return True
        if self.mouse:
            seconds = random.uniform(3.0, 9.0)
            self.log(f"    切到其他应用处理一下，{seconds:.1f} 秒后回来")
            if self.mouse.switch_app(seconds):
                self.client.pump(random.uniform(0.3, 0.8))
                return True
        return False

    # ---------- 列表：滚动抓包 ----------

    def _parse_list(self, payload: dict) -> dict[str, dict]:
        data = payload.get("data") or {}
        code = data.get("code")
        if code not in (0, "0"):
            raise PageCollectError(
                f"列表接口返回异常：code={code} message={data.get('message')}"
            )
        zp_data = data.get("zpData") or {}
        self._has_more = bool(zp_data.get("hasMore"))
        jobs: dict[str, dict] = {}
        for job in zp_data.get("jobList") or []:
            job_id = job.get("encryptJobId")
            if job_id:
                jobs[job_id] = job
        return jobs

    def _drain_list(self, jobs: dict[str, dict]) -> None:
        while self._list_cursor < len(self.client.list_payloads):
            payload = self.client.list_payloads[self._list_cursor]
            self._list_cursor += 1
            for job_id, job in self._parse_list(payload).items():
                jobs[job_id] = job  # 重复岗位直接覆写

    def _scroll_y(self) -> float:
        try:
            return float(self.client.evaluate("(() => window.scrollY || 0)()") or 0)
        except Exception:  # noqa: BLE001
            return 0.0

    def scroll_to_top(self) -> None:
        try:
            self.client.evaluate("(() => { window.scrollTo(0, 0); return true; })()")
        except Exception:  # noqa: BLE001
            pass
        self.client.pump(0.5)

    def reset_list(self, city: str | None = None) -> None:
        """丢弃切换期望途中抓到的其它城市列表，只保留目标城市的最后一页。"""
        payloads = self.client.list_payloads
        if city and payloads:
            last = payloads[-1]
            jobs = ((last["data"].get("zpData") or {}).get("jobList") or [])
            keep = any(city in str(job.get("cityName") or "") for job in jobs)
            payloads[:] = [last] if keep else []
        else:
            payloads.clear()
        self._list_cursor = 0
        self._has_more = True

    def _scroll_once(self, delta: int) -> float:
        """执行一次滚轮动作（OS 滚轮优先，失败退回 CDP），返回滚动后的 scrollY。"""
        before = self._scroll_y()
        if self.mouse and not self._wheel_fallback:
            # 滚轮刻度取绝对值，方向由 delta 的正负决定；反向小滚也要能成功返回
            notches = max(1, int(round(abs(delta) / 120)))
            try:
                self.mouse.scroll(-notches if delta > 0 else notches)
                self.client.pump(random.uniform(0.2, 0.5))
                after = self._scroll_y()
                if abs(after - before) > 1:
                    return after
            except MouseControllerError as error:
                self._wheel_fallback = True
                self.log(f"    [提示] 原生滚轮不可用（{str(error)[:60]}），改用页面滚轮")
        # 原生滚轮不可用（窗口不在前台等）时用 CDP 滚轮，落点也每次不同
        x = self.viewport["w"] * random.uniform(0.16, 0.5)
        y = self.viewport["h"] * random.uniform(0.3, 0.75)
        try:
            # 回退到页面滚轮时也先走一段轨迹，避免指针瞬移到落点
            self.client.mouse_move(x, y)
        except Exception:  # noqa: BLE001 - 轨迹失败不影响滚轮
            pass
        self.client.wheel(x, y, delta)
        self.client.pump(random.uniform(0.2, 0.5))
        return self._scroll_y()

    def _scroll(self, delta: int) -> float:
        """一次滚动动作拆成 1~3 段，段间停顿，偶尔先往回滚一点再继续。"""
        if random.random() < 0.12:
            # 像人一样往回确认一下再往下
            self._scroll_once(-random.randint(60, 200))
            self.client.pump(random.uniform(0.3, 0.9))
        segments = random.randint(1, 3)
        remaining = max(60, delta)
        position = 0.0
        for index in range(segments):
            if index == segments - 1:
                part = remaining
            else:
                part = int(remaining * random.uniform(0.3, 0.55))
            remaining -= part
            if part < 40:
                continue
            position = self._scroll_once(part)
            if index < segments - 1:
                self.client.pump(random.uniform(0.15, 0.6))
        return position

    # ---------- 详情：点击当前视口内的卡片抓包 ----------

    def _card_point(self, job_id: str) -> dict | None:
        """在卡片当前可视区域内随机取一个安全点（避开 a 链接），不滚动页面。"""
        script = """(args) => {
          const {jobId, tries} = args;
          const link = document.querySelector(`a.job-name[href*="/job_detail/${jobId}.html"]`);
          if (!link) return null;
          const li = link.closest('li');
          if (!li) return null;
          const rect = li.getBoundingClientRect();
          const top = Math.max(rect.top, 0) + 6;
          const bottom = Math.min(rect.bottom, innerHeight) - 6;
          if (bottom <= top) return null;
          for (let i = 0; i < tries; i += 1) {
            const fx = 0.08 + Math.random() * 0.44;
            const x = rect.left + rect.width * fx;
            const y = top + Math.random() * (bottom - top);
            if (x < 2 || y < 2 || x > innerWidth - 2 || y > innerHeight - 2) continue;
            const el = document.elementFromPoint(x, y);
            if (el && li.contains(el) && !el.closest('a')) return {x, y};
          }
          return null;
        }"""
        payload = json.dumps({"jobId": job_id, "tries": 8}, ensure_ascii=False)
        try:
            point = self.client.evaluate(f"({script})({payload})")
        except Exception:  # noqa: BLE001
            return None
        return point

    def visible_cards(self) -> list[dict]:
        """返回当前视口内可见的岗位卡片（只读位置，不滚动页面）。"""
        script = r"""(() => {
          const items = [];
          const links = document.querySelectorAll('li.job-card-box a.job-name[href*="/job_detail/"]');
          for (const link of links) {
            const match = (link.getAttribute('href') || '').match(/\/job_detail\/([^/]+)\.html/);
            if (!match) continue;
            const li = link.closest('li.job-card-box');
            if (!li) continue;
            const rect = li.getBoundingClientRect();
            const visibleTop = Math.max(rect.top, 0);
            const visibleBottom = Math.min(rect.bottom, window.innerHeight);
            if (visibleBottom - visibleTop < Math.min(80, rect.height * 0.5)) continue;
            items.push({jobId: match[1]});
          }
          return items;
        })()"""
        try:
            return list(self.client.evaluate(script) or [])
        except Exception:  # noqa: BLE001
            return []

    @staticmethod
    def _detail_data(item: dict) -> dict:
        """详情响应真实数据在 zpData 下，兼容直接在顶层的情况。"""
        data = item.get("data") or {}
        return data.get("zpData") or data

    def _click_visible(
        self,
        job: dict,
        index: int,
        total: int,
        delay: tuple[float, float],
        wait_ms: int,
    ) -> dict | None:
        """点击当前视口内的卡片并等待详情响应；不滚动页面找卡片。"""
        job_id = str(job.get("encryptJobId") or "")
        name = job.get("jobName")
        point = self._card_point(job_id)
        if not point:
            console.detail_skip(index, total, name, "已滚出视口或不可点击")
            return None
        console.detail_start(index, total, name)
        # 先移到卡片附近悬停一下，像人一样看一眼再点，落点仍按随机点
        try:
            self.client.mouse_move(
                point["x"] + random.uniform(-28, 28),
                point["y"] + random.uniform(-18, 18),
            )
            self.client.pump(random.uniform(0.25, 0.9))
        except Exception:  # noqa: BLE001 - 轨迹移动失败不影响点击
            pass
        before = len(self.client.detail_payloads)
        try:
            self.client.click(point["x"], point["y"])
        except Exception as error:  # noqa: BLE001
            console.detail_skip(index, total, name, f"点击失败 {str(error)[:60]}")
            return None
        found = self._wait(
            lambda: any(
                ((self._detail_data(item).get("jobInfo") or {}).get("encryptId") == job_id)
                for item in self.client.detail_payloads[before:]
            ),
            wait_ms,
        )
        if not found:
            console.detail_skip(index, total, name, "未捕获详情请求")
            return None
        data = next(
            self._detail_data(item) for item in self.client.detail_payloads[before:]
            if (self._detail_data(item).get("jobInfo") or {}).get("encryptId") == job_id
        )
        job_info = data.get("jobInfo") or {}
        boss_info = data.get("bossInfo") or {}
        console.detail_ok(
            index,
            total,
            job_info.get("jobName") or name,
            boss_info.get("activeTimeDesc") or "活跃未知",
            job_info.get("salaryDesc") or job.get("salaryDesc") or "",
        )
        dwell = random.uniform(*delay)
        if random.random() < 0.1:
            dwell += random.uniform(6, 14)  # 偶尔看久一点
        self.client.pump(dwell)
        self.maybe_break(0.06, allow_nav=True)
        return data

    # ---------- 页面内发起沟通：立即沟通 → 留在此页 ----------

    def _element_point(self, selector: str, label: str | None = None) -> dict | None:
        """在可见元素内部随机取一个能点中的坐标，避开边缘。"""
        script = r"""(args) => {
          const {selector, label} = args;
          for (const el of document.querySelectorAll(selector)) {
            const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
            if (label && !text.includes(label)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 2 || rect.height <= 2) continue;
            if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
            for (let i = 0; i < 6; i += 1) {
              const x = rect.left + rect.width * (0.18 + Math.random() * 0.64);
              const y = rect.top + rect.height * (0.26 + Math.random() * 0.48);
              if (x < 2 || y < 2 || x > innerWidth - 2 || y > innerHeight - 2) continue;
              const hit = document.elementFromPoint(x, y);
              if (hit && (hit === el || el.contains(hit))) {
                return {x: x, y: y, text: text.slice(0, 80)};
              }
            }
          }
          return null;
        }"""
        payload = json.dumps({"selector": selector, "label": label}, ensure_ascii=False)
        try:
            return self.client.evaluate(f"({script})({payload})")
        except Exception:  # noqa: BLE001
            return None

    def _first_element_point(self, selectors, label: str | None = None) -> dict | None:
        """按顺序尝试多个选择器，返回第一个能点中的坐标。"""
        for selector in selectors:
            point = self._element_point(selector, label)
            if point:
                return point
        return None

    def _detail_panel_text(self) -> str:
        """当前可见详情面板的文字，用于确认弹窗/按钮属于刚才点击的岗位。"""
        script = r"""(() => {
          const boxes = [...document.querySelectorAll('.job-detail-box')];
          const box = boxes.find(item => {
            const rect = item.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && getComputedStyle(item).visibility !== 'hidden';
          });
          return box ? (box.innerText || '') : '';
        })()"""
        try:
            return str(self.client.evaluate(script) or "")
        except Exception:  # noqa: BLE001
            return ""

    def _chat_dialog_state(self) -> dict:
        """读取沟通弹窗状态：是否出现「留在此页」、是否跳转聊天页、是否有风控提示。"""
        script = r"""(() => {
          const bodyText = document.body ? (document.body.innerText || '') : '';
          const risk = ['安全验证', '验证码', '环境异常', '环境存在异常'].find(k => bodyText.includes(k)) || '';
          const visible = el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };
          const norm = el => (el.innerText || '').replace(/\s+/g, ' ').trim();
          const stay = [...document.querySelectorAll('a, button')]
            .filter(el => visible(el) && norm(el) === '留在此页');
          const boxes = [...document.querySelectorAll('.greet-boss-dialog')].filter(visible);
          const btn = document.querySelector('a.op-btn-chat');
          return {
            risk,
            dialog: stay.length > 0 || boxes.length > 0,
            chatText: btn ? norm(btn) : '',
            url: location.href,
          };
        })()"""
        try:
            return dict(self.client.evaluate(script) or {})
        except Exception:  # noqa: BLE001
            return {}

    def idle_wait(self, seconds: float) -> None:
        """在详情页等发送间隔时做轻微鼠标移动/滚动，避免长时间完全静止。"""
        end = time.monotonic() + max(0.0, seconds)
        while time.monotonic() < end:
            step = min(random.uniform(1.5, 3.5), end - time.monotonic())
            if step <= 0:
                break
            try:
                x = random.uniform(self.viewport["w"] * 0.55, self.viewport["w"] * 0.9)
                y = random.uniform(self.viewport["h"] * 0.2, self.viewport["h"] * 0.7)
                self.client.mouse_move(x, y)
            except Exception:  # noqa: BLE001 - 等待期间的轻微动作失败可忽略
                pass
            self.client.pump(step)

    def start_chat(
        self, job: dict, data: dict | None = None, delay: tuple[float, float] = (2.0, 5.0)
    ) -> dict:
        """点击「立即沟通」，出现问候弹窗后点「留在此页」，全程拟人点击。"""
        job_info = (data or {}).get("jobInfo") or {}
        name = str(job_info.get("jobName") or job.get("jobName") or "")
        panel = self._detail_panel_text()
        if name and "".join(name.split()) not in "".join(panel.split()):
            raise PageCollectError(f"详情面板与岗位不一致，跳过发送：{name}")

        button = self._element_point(CHAT_BUTTON_SELECTOR, "立即沟通")
        if not button:
            state = self._chat_dialog_state()
            if "继续沟通" in str(state.get("chatText") or ""):
                return {"ok": True, "skipped": "already_chat"}
            raise PageCollectError("未找到可点击的「立即沟通」按钮")

        # 先悬停一下再按，落点和按住时长都有随机
        try:
            self.client.mouse_move(
                button["x"] + random.uniform(-12, 12),
                button["y"] + random.uniform(-6, 6),
            )
            self.client.pump(random.uniform(0.3, 0.9))
        except Exception:  # noqa: BLE001 - 轨迹移动失败不影响点击
            pass
        self.client.click(button["x"], button["y"], human=True)

        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            self.client.pump(random.uniform(0.3, 0.7))
            state = self._chat_dialog_state()
            risk = str(state.get("risk") or "")
            if risk:
                raise AbortError("environment_abnormal", f"点击立即沟通后被风控拦截：{risk}")
            if state.get("dialog"):
                # 像人一样看一眼弹窗，再选择留在此页
                self.client.pump(random.uniform(*delay))
                stay = self._first_element_point(CHAT_STAY_SELECTORS, "留在此页")
                if not stay:
                    if self._wait(lambda: not self._chat_dialog_state().get("dialog"), 3000):
                        return {"ok": True, "stayed": True}
                    self.log("    弹窗出现了但找不到「留在此页」，先停一下")
                    return {"ok": True, "stayed": False, "blocked": True}
                try:
                    self.client.mouse_move(stay["x"], stay["y"])
                    self.client.pump(random.uniform(0.2, 0.6))
                except Exception:  # noqa: BLE001
                    pass
                self.client.click(stay["x"], stay["y"], human=True)
                if not self._wait(lambda: not self._chat_dialog_state().get("dialog"), 6000):
                    close = self._first_element_point(CHAT_CLOSE_SELECTORS)
                    if close:
                        self.client.click(close["x"], close["y"])
                        self._wait(lambda: not self._chat_dialog_state().get("dialog"), 3000)
                if self._chat_dialog_state().get("dialog"):
                    self.log("    弹窗没有关掉，先停一下，避免误点")
                    return {"ok": True, "stayed": False, "blocked": True}
                self.client.pump(random.uniform(0.4, 1.0))
                return {"ok": True, "stayed": True}
            url = str(state.get("url") or "")
            chat_text = str(state.get("chatText") or "")
            if "/web/geek/chat" in url:
                self.log("    页面跳到了聊天页，先停一下")
                return {"ok": True, "stayed": False, "blocked": True}
            if "继续沟通" in chat_text:
                return {"ok": True, "stayed": False}
        raise PageCollectError("点击「立即沟通」后未出现问候弹窗")

    def refresh_list(self) -> bool:
        """滚到底后刷新页面，重新选回原期望，继续抓新一批推荐。"""
        console.refresh()
        before = len(self.client.list_payloads)
        try:
            # 用页面重载而不是新开标签页；刷新后仍由页面自己发列表请求
            self.client.evaluate("(() => { location.reload(); return true; })()")
        except Exception:  # noqa: BLE001 - 重载会中断当前 evaluate
            pass
        self.client.pump(random.uniform(2.0, 4.0))

        if self._expect_index or self._expect_city:
            selected = self.select_expect(self._expect_index, self._expect_city, refresh=True)
            if not selected:
                self.log("    刷新后没能选回原期望，先停一下")
                return False
        else:
            self._wait(lambda: len(self.client.list_payloads) > before, 20000)

        if not self._wait(lambda: self.card_count() > 0, 20000):
            self.log("    刷新后没有看到岗位卡片，先停一下")
            return False
        self.client.pump(random.uniform(0.8, 1.6))
        # 丢掉刷新前抓到的旧页，只保留刷新后第一页，避免重复计数
        if self._expect_city:
            self.reset_list(self._expect_city)
        else:
            # 没有识别到期望标签时，保留刷新后新增的列表，不能把新页也清掉
            self.client.list_payloads[:] = self.client.list_payloads[before:]
            self._list_cursor = 0
        self.refresh_count += 1
        if self._expect_city:
            self.log("    刷新完成，重新选回期望，继续浏览")
        else:
            self.log("    刷新完成，继续浏览")
        return True

    def collect_interleaved(
        self,
        target: int = 150,
        detail_limit: int = 150,
        max_scrolls: int = 150,
        delay: tuple[float, float] = (2.0, 4.0),
        detail_delay: tuple[float, float] = (3.0, 6.0),
        detail_wait_ms: int = 12000,
        skip_ids: set[str] | None = None,
        city: str | None = None,
        on_detail: Callable[[dict, dict], None] | None = None,
        on_tick: Callable[[], None] | None = None,
        max_refreshes: int = 2,
    ) -> tuple[list[dict], dict[str, dict]]:
        """列表滚动与详情点击交替执行；只点击当前视口内的卡片。"""
        if self.mouse:
            # 提前还原/激活 Chrome，避免最小化或遮挡导致 CDP 输入被限速
            self.mouse.focus()
        jobs: dict[str, dict] = {}
        details: dict[str, dict] = {}
        clicked: set[str] = set(skip_ids or ())
        self._drain_list(jobs)
        last_y = self._scroll_y()
        idle = 0
        for step in range(1, max_scrolls + 1):
            if city:
                for job_id in [
                    job_id for job_id, job in jobs.items()
                    if city not in str(job.get("cityName") or "")
                ]:
                    jobs.pop(job_id, None)
            if len(details) < detail_limit:
                visible = [
                    card for card in self.visible_cards()
                    if card.get("jobId") in jobs and card.get("jobId") not in clicked
                ]
                random.shuffle(visible)
                count = random.choices([0, 1, 2], weights=[0.2, 0.5, 0.3], k=1)[0]
                for card in visible[: min(len(visible), count)]:
                    if len(details) >= detail_limit:
                        break
                    job = jobs.get(card["jobId"])
                    if not job:
                        continue
                    clicked.add(card["jobId"])
                    data = self._click_visible(
                        job, len(details) + 1, detail_limit, detail_delay, detail_wait_ms
                    )
                    if data is not None:
                        details[card["jobId"]] = data
                        if on_detail:
                            on_detail(job, data)
            if len(jobs) >= target and len(details) >= detail_limit:
                break
            start_y = self._scroll_y()
            current_y = self._scroll(random.choice((
                random.randint(180, 420),
                random.randint(420, 850),
                random.randint(850, 1300),
            )))
            self.scroll_count += 1
            console.scroll_action(int(current_y - start_y))
            self.client.pump(random.uniform(*delay))
            if on_tick:
                on_tick()
            if random.random() < 0.08:
                self.client.pump(random.uniform(3.0, 8.0))
            self.maybe_break(0.05, allow_nav=True)
            before = len(jobs)
            self._drain_list(jobs)
            if len(jobs) > before:
                idle = 0
                page = max(1, (len(jobs) + 14) // 15)
                console.scroll(
                    page, len(jobs) - before, len(jobs), target, len(details), detail_limit
                )
                last_y = current_y
                continue
            if current_y <= last_y + 5:
                idle += 1
            else:
                idle = 0
            last_y = max(last_y, current_y)
            if idle >= 3:
                if self.refresh_count < max_refreshes and self.refresh_list():
                    idle = 0
                    # 刷新后的第一页已经在 list_payloads 里，立即入表，别等下一次滚动
                    self._drain_list(jobs)
                    last_y = self._scroll_y()
                    self.client.pump(random.uniform(1.5, 3.0))
                    continue
                self.log("    已经浏览到列表底部，结束本轮浏览")
                break
        return list(jobs.values()), details
