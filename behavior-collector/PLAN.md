# 采集层开发计划（v1.0，M0–M2 + M4 已实现）

> **交接**：新会话请先读 [HANDOFF.md](./HANDOFF.md)（背景、已定事项、M0 清单、坑），本文件是方案与验收标准。
> 目标产物：一个常驻 Windows 托盘的小程序，把「人在电脑上做了什么」以结构化事件写入本地 SQLite。
> 只做采集，不做分析、不做 AI、不做记忆体。下游怎么用这批数据，是后面的事。
> 项目定名 **BehaviorCollector**（目录 `behavior-collector`），名字直接体现「行为采集」。

---

## 1. 目标与非目标

### v0 要采到的东西

| 类别 | 粒度 | 说明 |
| --- | --- | --- |
| 应用启动/退出 | 进程级 | 哪个 exe、PID、父进程、启动/结束时间 |
| 前台窗口 | 窗口级 | 标题、所属进程、窗口类、位置、显示器、停留时长（查询时算） |
| 窗口内操作 | UIA 控件级 | 焦点控件、控件类型、名称、值预览、点击目标 |
| 键盘输入 | 按键级（哈希） | 键码 + 修饰键的 HMAC；默认不存明文 |
| 鼠标输入 | 点击/滚轮/降采样移动 | 坐标、按键、光标下窗口 |
| 浏览器 | 标签页/URL 级 | Chrome 扩展上报 URL、标题、切换、SPA 路由 |
| 空闲 | 区间 | 空闲开始/结束（阈值可配，默认 60s） |

### v0 明确不做

- 截屏、屏幕录制、OCR（后续若要做，改成事件触发 + pHash 去重，不在本轮）
- 聊天内容抓取（微信/QQ 桌面端不做；企业微信会话存档需要企业资质，个人场景不适用）
- 文件操作审计（要 ETW + 管理员，v0 不做）
- 游戏内操作（需要逐游戏 Hook/反作弊对抗，不做）
- 任何云端上传、任何 AI 调用、任何常驻 HTTP 服务
- 分析报表、习惯画像、拟人化模型

---

## 2. 语言与运行时

**C# / .NET 10（LTS，`net10.0-windows`）**

- 本机已装：SDK 11.0.100、Runtime 10.0.15（Desktop）、11.0.0 —— 直接 target net10 没问题，LTS 到 2028-11。
- 理由：全局钩子、UIA 事件、Native Messaging、托盘常驻，全是 Windows 原生接口 + 长时间稳定运行，C# 的 P/Invoke 与 UIA 封装生态最成熟；Python 侧（pywin32/pywinauto/pynput）原型快，但钩子稳定性、UIA 事件吞吐、单文件分发都更差。
- 分发：framework-dependent 单文件（本机有运行时），约 5–10MB；不裁剪，避免反射踩坑。

---

## 3. 技术选型（第三方库对照）

### 3.1 采用

| 用途 | 选型 | 版本 | 说明 |
| --- | --- | --- | --- |
| Win32 API | **Microsoft.Windows.CsWin32** | 0.3.371 | 微软官方源生成器，只生成用到的签名，**零运行时依赖**；比手写 P/Invoke 和 Vanara 都干净 |
| UI Automation | **FlaUI.UIA3** | 5.0.0 | 订阅焦点/结构变更事件、取控件属性，比裸 COM 省几百行；官方目标框架到 net8.0-windows7.0，net10 可直接引用 |
| 全局键鼠钩子 | **SharpHook** | 8.0.3 | MIT，libuiohook 封装，有 net10.0 目标；键码/修饰键/坐标都现成，省掉 SetWindowsHookEx + 回调线程管理 |
| 存储 | **Microsoft.Data.Sqlite** | 10.0.x | 与运行时同版本，WAL + 事务批量写足够 |
| 宿主/DI/配置/日志 | **Microsoft.Extensions.Hosting** | 10.0.x | IHostedService 管采集器生命周期，配置热重载 |
| 日志落盘 | **Serilog.Extensions.Hosting** + File sink | 当前稳定版 | 按天滚动，保留 7 天，排查钩子/UIA 异常用 |
| 托盘 | WinForms `NotifyIcon` | 内置 | 无主窗口，托盘菜单：暂停/继续、状态、打开数据目录、退出 |
| 测试 | xUnit | 当前稳定版 | 只测纯逻辑（哈希、降采样、批处理、迁移） |

> 另：`Interop.UIAutomationClient 10.19041.0` 是 FlaUI.UIA3 的传递依赖，自动带入。

### 3.2 调研过但 v0 不采用

| 方案 | 结论 |
| --- | --- |
| **iRecorderSDK**（wecooperate） | 覆盖范围最接近（窗口/浏览器 URL/Office 文档/聊天对象），但是**闭源商业 SDK**，只给 `OnWindowChanged` 回调、拿不到原始事件流，无法定制 UIA/输入；且需邮件申请授权。适合做对照验证，不适合当前"要能改"的需求 |
| **iMonitorSDK**（冰镜） | 内核驱动、企业审核授权、要处理签名与 WHQL 兼容；v0 不监控文件/网络，用不上 |
| **ActivityWatch** | 开源可直接跑，但只有「窗口 + AFK」粒度，没有 UIA/输入细节，数据模型固定、扩不了应用内语义；只借鉴它的 event 数据结构 |
| **openadapt-capture** | Python + 同时录屏，与"不截屏、低占用"目标相反 |
| **screenpipe** | 24/7 录屏 + OCR，磁盘和隐私成本都高，v0 排除 |
| **Interception 驱动** | 内核驱动装驱动成本高、易被反作弊针对；用户态 SharpHook 够用 |
| **Playwright / CDP** | 需要以调试端口启动 Chrome，会改变你日常浏览器的启动方式；扩展方案无侵入，CDP 仅作为扩展失效时的备选 |

---

## 4. 架构

```
                 ┌──────────────────────────────────┐
 Chrome 扩展 ──► │ BehaviorCollector.exe（浏览器宿主模式）      │  ← Native Messaging（stdin/stdout）
 (MV3)           └──────────────┬───────────────────┘
                                │ 命名管道 \\.\pipe\collector-browser
┌───────────┬───────────┬───────┴────┬──────────┐
│  Window   │  Process  │   Input    │   UIA    │   四个采集器（各自线程/任务）
└─────┬─────┴─────┬─────┴─────┬──────┴────┬─────┘
      └───────────┴───────────┴───────────┘
                      ▼
            Channel<Event>（有界 50k，满了丢最旧并计数）
                      ▼
          BatchWriter（500 条或 1s 刷盘，单事务）
                      ▼
        behavior-collector/data/events.db（SQLite WAL）
```

设计要点：

1. **单写者**：只有 BatchWriter 碰 DB，采集器只往 Channel 里丢事件，避免 SQLite 多线程写锁。
2. **子进程不写 DB**：`--browser-host` 模式只做协议转换，事件转发给主进程；主进程不在时退化为本地 jsonl 缓冲，下次启动补录。
3. **背压可见**：Channel 丢弃计数、每个采集器的 events/min、错误数，都进 `status` 输出和托盘提示，不静默丢数据。
4. **采集器可单独开关**：配置热重载，关掉输入或 UIA 不用重启。

### 4.1 目录结构

```
behavior-collector/
  PLAN.md
  BehaviorCollector.slnx
  config.json               # 首次运行自动生成，可热重载
  data/                     # 运行时数据（已在 .gitignore，绝不提交）
    events.db
    logs/
    native-host/
    browser-spool.jsonl
  src/
    BehaviorCollector.App/          # 宿主、托盘、配置、单实例、CLI（status/export/browser-host）
    BehaviorCollector.Core/         # Event、Channel、BatchWriter、迁移、隐私过滤、导出
    BehaviorCollector.Collectors/   # Window / Process / Input / Idle / Browser 采集器
  extension/chrome/         # MV3 扩展（manifest.json、background.js）
  tests/BehaviorCollector.Tests/
```

Native Messaging 宿主不单独建项目：Chrome 启动宿主时第一个参数是 `chrome-extension://<id>/`，程序据此进入宿主模式；无参数时进托盘模式。

---

## 5. 采集器规格

### 5.1 窗口（Window）

- `SetWinEventHook(EVENT_SYSTEM_FOREGROUND | EVENT_OBJECT_NAMECHANGE, WINEVENT_OUTOFCONTEXT)`，回调线程带消息循环。
- 兜底：1s 轮询 `GetForegroundWindow()`，对比上次 hwnd+title，防钩子漏事件。
- 字段：hwnd、pid、exe 名、窗口标题（截断 512）、窗口类名、矩形、显示器序号、是否全屏。
- 去重：同 hwnd + 同 title 在 1s 内只记一条；标题变化单独记 `window.title`。
- 时长：不落库，查询时用相邻 `window.foreground` 的时间差算。

### 5.2 进程（Process）

- Toolhelp32 快照，每 2s 一次，pid → {exe, parentPid}，与上次 diff 出 `process.start` / `process.stop`。
- 路径用 `QueryFullProcessImageName`（提权进程可能失败，失败就只留 exe 名，不重试不报错）。
- 不查命令行（WMI 慢且噪音大），需要时后续单点加。

### 5.3 输入（Input）

- SharpHook `GlobalHook`，键盘 + 鼠标。
- **键盘**：只存 `HMAC-SHA256(install_salt, $"{vk}|{mods}")` 前 16 hex + 修饰键位掩码 + 时间戳。**默认不存明文键名**。
  - 明文开关：`privacy.plaintextKeys`（默认 false），打开时托盘二次确认，日志留痕，DB 里多一列 `key_plain`。
- **鼠标移动**：**降采样到 ≤20Hz**（50ms 采样一次），且只保留坐标 + 光标下窗口；空闲期间不记。
- **点击/滚轮**：每个 down/up 都记，含坐标、按键、`WindowFromPoint` 得到的 hwnd/pid/exe。
- **空闲**：`GetLastInputInfo` 每 5s 检查，超过阈值发 `idle.start`，恢复发 `idle.end`；空闲期间输入事件直接丢弃。
- 哈希盐：安装时随机 32 字节，存 DB `meta` 表；换机器/重装盐就变，旧哈希不可反查（这是有意的）。

### 5.4 UIA（Uia）

- 全局焦点事件：`Automation.AddAutomationFocusChangedEventHandler`。
- 前台窗口子树结构变更：窗口切换时对当前前台窗口 `RegisterStructureChangedEvent(Subtree)`，切走就注销；只跟一个窗口，避免全局监听拖垮系统。
- 提取字段：ControlType、Name（截断 120）、AutomationId、ClassName、ValuePattern 的值（截断 200，仅 Edit/Document）、矩形中心点、`IsPassword`。
- **密码框整棵子树跳过**（`IsPassword == true` 直接 return，不记 Name 也不记值）。
- 节流：每 PID 令牌桶 20 事件/s，250ms 合并同类事件；UIA 调用统一 2s 超时，连续 3 次超时对该 PID 熔断 5 分钟。
- 只处理前台窗口所属进程 + 其子窗口，不遍历桌面。

### 5.5 浏览器（Chrome）

- MV3 扩展，`permissions: ["tabs","webNavigation","storage","nativeMessaging"]`，不需要 `host_permissions`；空闲由原生 collector 负责，不重复订阅 `chrome.idle`。
- 监听：`tabs.onActivated`、`tabs.onUpdated`（url/title 变化）、`webNavigation.onCommitted`、`webNavigation.onHistoryStateUpdated`（SPA 路由）、`windows.onFocusChanged`。
- 通道：`chrome.runtime.connectNative("com.behaviorcollector.browser")` 长连接，协议 = 4 字节小端长度 + UTF-8 JSON。
- 断线：事件先写 `chrome.storage.session` 队列；`postMessage` 成功后出队，断线重连后补发。主程序不在时宿主把原始消息落盘到 `data/browser-spool.jsonl`，主程序下次启动时在一个事务里补录、成功后删文件。
- 扩展 ID 固定：`manifest.json` 内置 `key`，ID 恒为 `lnfkkjhbfaacbbpkeiepmkphniphdjie`；App 用同一常量生成 `allowed_origins`，二者必须同步。
- 注册：manifest 放 `data/native-host/com.behaviorcollector.browser.json`，注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.behaviorcollector.browser` —— **HKCU 不需要管理员**，App 每次启动幂等重写。
- 扩展加载方式：Chrome 打开 `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选择 `extension/chrome`。

### 5.6 会话与空闲

- 每个事件带 `session`（`WTSGetActiveConsoleSessionId`）和 `monitor`，多显示器/远程桌面能区分。
- 进程声明 PerMonitorV2 DPI 感知，坐标存物理像素、不缩放。

---

## 6. 数据模型

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;

CREATE TABLE events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,          -- 事件时间，Unix ms（UTC）
  kind      TEXT    NOT NULL,          -- window.foreground / window.title / process.start /
                                       -- process.stop / input.key / input.click / input.wheel /
                                       -- input.move / uia.focus / uia.change / browser.nav /
                                       -- browser.activate / idle.start / idle.end / pause.start ...
  source    TEXT    NOT NULL,          -- window | process | input | uia | browser
  pid       INTEGER,
  hwnd      INTEGER,
  app       TEXT,                      -- exe 名，小写
  title     TEXT,
  url       TEXT,
  session   INTEGER,
  data      TEXT,                      -- JSON，按 kind 不同：{vk_hash, mods} / {x,y,button} / {ctrl_type,name,value} ...
  key_plain TEXT                       -- 仅当 privacy.plaintextKeys 打开
);

CREATE INDEX ix_events_ts        ON events(ts);
CREATE INDEX ix_events_kind_ts   ON events(kind, ts);
CREATE INDEX ix_events_app_ts    ON events(app, ts);

CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);  -- schema_version / install_salt / install_id / created_at

CREATE TABLE collector_state (
  source        TEXT PRIMARY KEY,
  enabled       INTEGER,
  last_error    TEXT,
  last_event_at INTEGER
);

-- M5 可选：夜间预聚合，分析查询不必扫全表
CREATE TABLE stats_daily (
  day TEXT, app TEXT,
  active_seconds INTEGER, events INTEGER,
  PRIMARY KEY (day, app)
);
```

- 位置：**项目目录下的 `behavior-collector/data/`**（不写 C 盘用户目录），可通过 `config.json` 的 `storage.dataDir` 改；`data/` 已加入 `.gitignore`。
  - `data/events.db`、`data/logs/`、`data/native-host/`、`data/browser-spool.jsonl`。
  - 从源码运行时按 `BehaviorCollector.slnx` 定位项目根；发布后回退到 exe 所在目录。
- 保留期：默认 90 天，每日 03:00 批量删除 + 增量 vacuum；库上限 2GB，超了先删最旧的 `input.move`。
- 迁移：`schema_version` 单调递增，启动时按版本执行迁移脚本。

---

## 7. 隐私与安全

| 项 | 做法 |
| --- | --- |
| 按键 | 默认只存 HMAC 前 16 hex，盐随机存本机；盐丢了哈希就废了，反查不了 |
| 明文按键 | 默认关；config 打开 + 托盘二次确认 + 日志留痕 |
| 密码框 | UIA `IsPassword` 整棵子树跳过 |
| 应用排除 | 默认名单（标题/进程正则）：`*password*`、`keepass*`、`1password*`、`bitwarden*`、`*bank*`；命中就只记 `window.foreground`，不做 UIA/输入 |
| 暂停 | 全局热键 `Ctrl+Alt+P`（可改）+ 托盘菜单；暂停期间只记 `pause.start/end` |
| 数据落地 | 只写本机；DB 目录 `icacls` 只给当前用户；不联网 |
| 导出 | `BehaviorCollector.exe export --from --to [--out]`，显式执行才产出文件；默认 JSONL |

---

## 8. 性能预算

| 指标 | 目标 |
| --- | --- |
| CPU | 空闲 <0.5%，正常使用 <2%（UIA 开启时峰值 <5%） |
| 内存 | <150MB（含 .NET 运行时） |
| 磁盘/天 | <80MB（不含截屏；输入降采样后） |
| 事件量估算 | 窗口 ~50/h、进程 ~20/h、输入 ~3k/h、UIA ~5k/h |
| 启动 | <2s 进入采集状态 |

---

## 9. 里程碑

| # | 内容 | 交付物 | 验收 | 人日 |
| --- | --- | --- | --- | --- |
| M0 | 骨架 | sln + 4 项目、配置、日志、单实例、托盘、SQLite 建表+迁移 | 双击启动，托盘可用，DB 生成，退出干净无残留进程 | 1 |
| M1 | 窗口+进程+空闲+落库 | Window/Process 采集器、空闲检测、BatchWriter、`status` | 连跑 4h，人工核对 20 次窗口切换、10 次进程启停，漏记 0/≤1；DB 行数与日志计数一致 | 2 |
| M2 | 输入 | SharpHook 键盘哈希 + 鼠标降采样 + 点击/滚轮 + 空闲门控 | 打字 5 分钟，key 事件数与系统计数误差 <2%；移动 ≤20Hz；空闲 60s 后无 move | 1.5 |
| M3 | UIA | 焦点事件 + 前台窗口结构变更 + 节流 + 字段提取 + 密码跳过 | Chrome 里切标签/输入搜索，能还原"操作了哪个控件 + 文本预览"；事件超载时自动降采样不卡系统 | 2.5 |
| M4 | Chrome | MV3 扩展、Native Messaging 宿主、HKCU 注册、断线缓冲 | 打开 URL 1s 内入库；SPA 路由变化入库；主程序关闭期间事件不丢、重启补录 | 2 |
| M5 | 收尾 | 自启（HKCU Run）、崩溃恢复、日志轮转、保留期清理、`export`、打包、72h soak | 72h 不崩、内存无增长、导出 JSONL 可被 pandas 直接读 | 1.5 |
| | | | **合计** | **10.5** |

### v0 范围（已拍板）

**先做 M0–M2 + M4，UIA（M3）后置**；M5 只取必需项：`export` CLI、开机自启（HKCU Run）、保留期清理、日志轮转。
验收标准不变。UIA 事件、密码框子树跳过、UIA 节流等规格保留在 §5.4，作为下一阶段输入。

### 实现状态（2026-11-26）

- 已完成：M0、M1、M2、M4，以及 M5 必需项（export / 自启 / 保留期 / 日志轮转）。
- 未开始：M3（UIA）。
- 验证：21 个自动化测试；本机端到端覆盖窗口 / 进程 / 输入 / 浏览器事件 / 离线缓冲导入 / 导出 / 优雅退出。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| UIA 事件风暴 / 跨进程调用卡顿 | 拖慢系统、采集器假死 | 每 PID 令牌桶 + 250ms 合并 + 2s 超时 + 连续超时熔断 5 分钟；只跟一个前台窗口 |
| 提权应用的 UIA 读不到（UIPI） | 部分应用只有窗口级 | 文档标注；不为此改成管理员常驻（服务化后续再说） |
| 全局钩子被杀软标记 | 被拦截或误报 | 单文件发布 + 后续代码签名；配置可单独关输入采集；README 写清用途 |
| Chrome MV3 Service Worker 休眠断连 | 丢浏览器事件 | 事件先落 `chrome.storage.session` + 序号，重连补发，主程序按序号去重 |
| 自绘应用（微信/QQ/游戏）无 UIA | 应用内语义缺失 | 明确只到窗口级；后续对高价值应用单点适配（如微信走 UI 自动化有限字段） |
| DB 膨胀 | 磁盘占用、查询变慢 | 90 天保留 + 夜间 vacuum + 输入降采样 + 移动事件优先淘汰 |
| 多显示器 / DPI / 远程桌面 | 坐标错乱、事件串会话 | PerMonitorV2 + 物理像素 + 记 session id |
| 托盘程序被误退出 | 数据断档 | 单实例 Mutex + 退出写 `app.stop`；重启后补一条 `app.start` 标记缺口 |

---

## 11. 决策点（已拍板，2026-11-26）

| # | 决策 | 结论 |
| --- | --- | --- |
| 1 | 名字 | **BehaviorCollector**（目录 `behavior-collector`），体现「行为采集」 |
| 2 | 目标框架 | **`net10.0-windows`** |
| 3 | 明文按键开关 | **只放 config + 托盘二次确认**，托盘菜单不提供开启入口 |
| 4 | 保留期 | **90 天 / 2GB**；数据放项目内 `behavior-collector/data/`，不写 C 盘用户目录，并加入 `.gitignore` |
| 5 | Chrome 扩展 | **开发者模式加载**（固定 `key`，扩展 ID 稳定，Native Host 自动注册） |
| 6 | 开机自启 | **首次运行询问**，同意后写 `HKCU\...\CurrentVersion\Run` |
| 7 | `export` CLI | **带**（JSONL，供下游分析） |
| 8 | 节奏 | **先 M0–M2 + M4 + M5 必需项**，UIA 后置 |

---

## 12. 如果评审通过，第一步

M0 当天完成：建 sln、四个项目、配置与日志、托盘、SQLite 建表 + 迁移、单实例。第二天起床就能看到 `data/events.db` 里有 `app.start` 和第一批 `window.foreground`。

之后按 M1 → M2 → M3 → M4 → M5 推进，每个里程碑结束给你一份「跑出来的数据长什么样」的样例 + 验收结果，再进下一个。
