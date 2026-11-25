#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Windows 原生鼠标输入：用 SendInput 发送真实滚轮/点击事件。

目的：不通过 Playwright/CDP 派发输入，而是像真人一样操作鼠标滚轮。
使用前需要 BOSS 的 Chrome 窗口在前台；采集期间不要移动鼠标。
"""

from __future__ import annotations

import ctypes
import random
import time
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)


def _enable_dpi_awareness() -> None:
    """声明进程 DPI 感知，否则 125% 缩放下 GetClientRect/SetCursorPos 会错位。

    不做这一步时系统会按虚拟坐标换算，导致落点偏向窗口左上角，滚轮落到右侧详情面板。
    """
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # per-monitor v2
        return
    except Exception:  # noqa: BLE001 - 旧系统没有 shcore
        pass
    try:
        user32.SetProcessDPIAware()
    except Exception:  # noqa: BLE001
        pass


_enable_dpi_awareness()

INPUT_MOUSE = 0
MOUSEEVENTF_WHEEL = 0x0800
WHEEL_DELTA = 120
SW_RESTORE = 9
CHROME_CLASS = "Chrome_WidgetWin_1"
VK_MENU = 0x12
VK_TAB = 0x09
KEYEVENTF_KEYUP = 0x0002


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.POINTER(wintypes.ULONG)),
    ]


class _INPUT_UNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUT_UNION)]


class MouseControllerError(RuntimeError):
    """找不到窗口或系统拒绝输入。"""


class MouseController:
    """按窗口标题找到 BOSS 的 Chrome 窗口，并在窗口内发送滚轮/点击。"""

    def __init__(self, window_keyword: str = "BOSS直聘", log=print):
        self.window_keyword = window_keyword
        self.log = log
        self.hwnd: int | None = None
        self.anchor: tuple[int, int] | None = None

    # ---------- 窗口 ----------

    def _enum_windows(self) -> list[tuple[int, str]]:
        results: list[tuple[int, str]] = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def callback(hwnd, _lparam):  # noqa: ANN001
            if not user32.IsWindowVisible(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if length <= 0:
                return True
            buffer = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buffer, length + 1)
            title = buffer.value
            class_name = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, class_name, 256)
            if class_name.value == CHROME_CLASS and self.window_keyword in title:
                results.append((int(hwnd), title))
            return True

        user32.EnumWindows(callback, 0)
        return results

    def attach(self) -> int:
        windows = self._enum_windows()
        if not windows:
            raise MouseControllerError(
                f"找不到标题包含「{self.window_keyword}」的 Chrome 窗口"
            )
        best: tuple[int, int] | None = None
        minimized: int | None = None
        for hwnd, _title in windows:
            if user32.IsIconic(hwnd):
                if minimized is None:
                    minimized = hwnd
                continue
            rect = wintypes.RECT()
            user32.GetClientRect(hwnd, ctypes.byref(rect))
            area = int(rect.right) * int(rect.bottom)
            if rect.right < 200 or rect.bottom < 200:
                continue
            if best is None or area > best[1]:
                best = (hwnd, area)
        chosen = best[0] if best else minimized
        if chosen is None:
            raise MouseControllerError("BOSS 的 Chrome 窗口不可用，请先恢复窗口")
        # 最小化时先还原，后续 focus() 再负责切到前台
        if user32.IsIconic(chosen):
            user32.ShowWindow(chosen, SW_RESTORE)
            time.sleep(0.4)
        self.hwnd = chosen
        rect = wintypes.RECT()
        user32.GetClientRect(self.hwnd, ctypes.byref(rect))
        origin = wintypes.POINT(0, 0)
        user32.ClientToScreen(self.hwnd, ctypes.byref(origin))
        # 指针放在左侧列表区域中部，避免落到右侧详情面板
        self.anchor = (
            origin.x + int(rect.right * 0.35),
            origin.y + int(rect.bottom * 0.6),
        )
        return self.hwnd

    def focus(self) -> bool:
        if not self.hwnd:
            self.attach()
        # 只有最小化时才恢复，避免把已经全屏/最大化的窗口还原成小窗口
        if user32.IsIconic(self.hwnd):
            user32.ShowWindow(self.hwnd, SW_RESTORE)
            time.sleep(0.3)
        if user32.GetForegroundWindow() != self.hwnd:
            try:
                user32.SetForegroundWindow(self.hwnd)
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.2)
        if user32.GetForegroundWindow() != self.hwnd:
            self._force_foreground()
        time.sleep(0.15)
        return user32.GetForegroundWindow() == self.hwnd

    def _force_foreground(self) -> None:
        """SetForegroundWindow 被前台锁拒绝时，用 AttachThreadInput 强制切到前台。"""
        kernel32 = ctypes.windll.kernel32
        foreground = user32.GetForegroundWindow()
        current_thread = kernel32.GetCurrentThreadId()
        foreground_thread = (
            user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
        )
        target_thread = user32.GetWindowThreadProcessId(self.hwnd, None)
        attached: list[tuple[int, int]] = []
        try:
            if foreground_thread:
                user32.AttachThreadInput(current_thread, foreground_thread, True)
                attached.append((current_thread, foreground_thread))
            if target_thread and target_thread != foreground_thread:
                user32.AttachThreadInput(current_thread, target_thread, True)
                attached.append((current_thread, target_thread))
            user32.SetForegroundWindow(self.hwnd)
            user32.BringWindowToTop(self.hwnd)
        finally:
            for left, right in attached:
                user32.AttachThreadInput(left, right, False)

    # ---------- 输入 ----------

    def _send(self, inputs) -> None:
        array = (INPUT * len(inputs))(*inputs)
        sent = user32.SendInput(len(inputs), array, ctypes.sizeof(INPUT))
        if sent != len(inputs):
            raise MouseControllerError(
                f"SendInput 失败：error={ctypes.get_last_error()}"
            )

    def _wheel_input(self, notches: int) -> INPUT:
        item = INPUT()
        item.type = INPUT_MOUSE
        item.mi = MOUSEINPUT(
            0, 0, (WHEEL_DELTA * notches) & 0xFFFFFFFF, MOUSEEVENTF_WHEEL, 0, None
        )
        return item

    def scroll(self, notches: int = -5, jitter: bool = True) -> None:
        """负值向下滚动；调用前会将指针放到列表区域并确保窗口在前台。

        jitter=True 时每次落点略有不同，不会每次都从同一个坐标滚轮。
        """
        if not self.hwnd:
            self.attach()
        if not self.focus():
            raise MouseControllerError("无法把 BOSS 窗口切到前台，请手动点一下该窗口")
        x, y = self.anchor
        if jitter:
            x += random.randint(-60, 40)
            y += random.randint(-120, 120)
        user32.SetCursorPos(int(x), int(y))
        self._send([self._wheel_input(notches)])

    # ---------- 窗口切换 ----------

    def foreground(self) -> bool:
        return bool(self.hwnd) and user32.GetForegroundWindow() == self.hwnd

    @staticmethod
    def _key(vk: int, up: bool = False) -> None:
        user32.keybd_event(vk, 0, KEYEVENTF_KEYUP if up else 0, 0)

    def alt_tab(self) -> None:
        """按一次 Alt+Tab（真实键盘事件，和用户手动切换应用一样）。"""
        self._key(VK_MENU)
        time.sleep(random.uniform(0.04, 0.12))
        self._key(VK_TAB)
        time.sleep(random.uniform(0.06, 0.16))
        self._key(VK_TAB, up=True)
        time.sleep(random.uniform(0.04, 0.1))
        self._key(VK_MENU, up=True)

    def switch_app(self, seconds: float = 4.0) -> bool:
        """Alt+Tab 切到别的应用停留一会，再切回 Chrome；返回 Chrome 是否回到前台。"""
        if not self.hwnd:
            self.attach()
        if not self.focus():
            return False
        self.alt_tab()
        time.sleep(seconds)
        self.alt_tab()
        time.sleep(random.uniform(0.3, 0.8))
        if self.foreground():
            return True
        # Alt+Tab 没落回 Chrome 时直接激活窗口（只在最小化时恢复，不改变大小）
        self.focus()
        time.sleep(0.3)
        return self.foreground()
