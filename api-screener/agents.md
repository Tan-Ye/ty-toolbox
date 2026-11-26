# AGENTS.md — 代码结构与修改约定

本文件写给"下一个接手这个项目的 AI/人"。它不重复 README 的操作步骤，只说明：

- 代码怎么分层、依赖往哪个方向走；
- 哪些地方**不能随便改**，改之前必须想清楚什么；
- 改完怎么验证，运行中怎么读日志和状态文件。

**阅读顺序**：README 第 5 章（流程）→ 第 6 章（随机性）→ 第 7 章（沟通决策）→ 本文件第 5 章（修改禁区）。
任何涉及页面行为的改动，先在真实环境里 `--dry-run` 跑一遍。

---

## 1. 项目定位与不可动摇的边界

- 用途：个人求职时筛选岗位、查看详情、按优先级在页面内打招呼。
- 采集依赖**真实浏览器自己发出的请求**；沟通依赖**真实页面点击**。
- 不做：模拟登录、绕过验证码、多账号、并发、调用发送接口、保存接口响应体或聊天正文。

---

## 2. 分层与依赖方向

```text
入口脚本        start_chrome.py      run_job_queue.py      collect_apis.py（独立工具）
                    │                     │
                    ▼                     ▼
workflow/       cli → startup / collecting / sending / expectations / queue_runner
                    │
        ┌───────────┼──────────────┐
        ▼           ▼              ▼
browser/        cdp_client / page_collect / os_input / auth
        │           │
        ▼           ▼
storage/        job_store
        │
        ▼
core/           config / errors / utils / lock / console（不依赖其它包）
```

规则：

- `core` 不依赖任何业务包；`browser`、`storage` 只依赖 `core`；`workflow` 可以依赖前三者。
- 入口脚本只调用 `workflow` 和 `core.lock`，**不要把业务逻辑写回入口**。
- 包内一律使用绝对导入（`from core.config import ...`），只有入口脚本把项目根目录加入 `sys.path`。
- 新增能力按职责放置：页面交互进 `browser`，流程决策进 `workflow`，持久化进 `storage`，常量进 `core.config`。

---

## 3. 文件职责

| 文件 | 职责 | 改动风险 |
| --- | --- | --- |
| `start_chrome.py` | 探测并复用 9222，否则启动 Chrome；就绪后透传参数执行 `run_job_queue.py` | 中 |
| `run_job_queue.py` | 薄入口：抢 `data/run.lock`、调用 `workflow.cli.main`、映射退出码 | 高（锁与退出码） |
| `collect_apis.py` | Reqable 抓包导出工具，不参与日常流程 | 低 |
| `core/config.py` | 路径、接口地址、`SEND_LIMIT_MAX`、退出码、登录/额度/风控关键词 | 高 |
| `core/errors.py` | `AbortError`（带 `kind` 与 `payload`） | 中 |
| `core/utils.py` | URL 拼接、响应校验与关键词分类、工作时间判断 | 高（终止逻辑） |
| `core/lock.py` | `msvcrt` 单实例锁 | 高 |
| `core/console.py` | 终端文案（拟人化日志） | 低（但别改成接口式日志） |
| `browser/cdp_client.py` | 原生 CDP：`Runtime.evaluate`、`Network.*` 抓响应、`Input.*` 鼠标/滚轮、切标签页 | 高 |
| `browser/page_collect.py` | 页面采集与页面内沟通的全部随机行为 | 最高 |
| `browser/os_input.py` | 原生滚轮、窗口前台、Alt+Tab | 高 |
| `browser/auth.py` | 登录探测、token 读取、客户端工厂 | 中 |
| `workflow/cli.py` | 参数定义、校验、主编排、结果落盘 | 高（默认值即契约） |
| `workflow/startup.py` | 今日概况、2 小时窗口决策 | 高（额度） |
| `workflow/expectations.py` | 期望标签读取、人工选择、城市解析 | 中 |
| `workflow/collecting.py` | 页面采集主流程、详情入库、补发筛选 | 高（顺序） |
| `workflow/sending.py` | 沟通决策顺序、额度、间隔、失败记录 | 最高 |
| `workflow/queue_runner.py` | API 备用模式的顺序队列：随机间隔、Ctrl+C 终止 | 中（仅 API 模式） |
| `storage/job_store.py` | 表结构、入库合并、优先级、额度统计、导出 | 高 |
| `params/priority_keywords.json` | 优先级关键词（可直接编辑） | 低 |
| `params/list_params.json` | 仅 API 备用模式的列表参数 | 低 |

---

## 4. 一次运行发生了什么（给改代码的人）

1. `run_job_queue.py` 抢锁 → `workflow.cli.main()`。
2. `parse_args` / `validate_args`：这里定义了所有默认值，文档数字都以它为准。
3. `startup_gate`：**在登录预检之前**读库，展示今日概况；窗口满时可能改 `args.stage` / `args.force_window`。
4. `check_login` → 未登录时 `prompt_login`（`input()`，非交互直接失败，退出码 7）。
5. `run_collect`：`page` 走 `run_collect_page`，`api` 走顺序队列。
6. 页面模式：`PageCollector.wait_ready` → `expect_tabs` → `choose_expect`（人工）→ `select_expect` → `verify_city` → `reset_list` → `collect_interleaved`。
7. 每次详情成功：`build_detail_payload` → `save_detail` → `InlineSender.consider` → 可能 `start_chat`。
8. 收尾：`sender.finish()` → `export_json` → `queue_result.json`。

改动时留意两个顺序不可交换：

- **先入库、再沟通**：沟通失败也要保留详情，并且下一轮能补发。
- **先决策、再等待**：没到 30~60 秒间隔时停留在当前详情页等待，不能先翻到别的岗位。

---

## 5. 修改禁区

以下改动，**没有充分理由和干跑验证就不要动**。改之前先说明：为什么必须改、影响哪些数字、如何验证。

### 5.1 随机性参数与分心行为

涉及：`browser/page_collect.py`（`_scroll`、`_scroll_once`、`_card_point`、`_click_visible`、`maybe_break`、`idle_wait`）、`browser/os_input.py`（`scroll` 抖动）、`browser/cdp_client.py`（`mouse_move`、`click`）。

为什么不能动：滚动三档、1~3 段拆分、12% 回滚、6% 分心、10% 延长停留，这些是防风控的主要特征。把它们"优化"成固定步长或去掉停顿，会让行为明显机械化。

允许改的情况：页面结构变化导致取点失败、窗口/DPI 适配问题。改完必须用 `--dry-run` 观察日志节奏是否仍然自然。

`refresh_list`（到底刷新，默认最多 2 次）也属于浏览节奏：刷新后必须重新选回期望、重新等卡片，不要改成无限刷新或连续 F5；`--max-refreshes 0` 应保持旧的“到底即停”行为。

### 5.2 额度与时间窗

涉及：`core/config.py` 的 `SEND_LIMIT_MAX = 30`、`workflow/startup.py`、`workflow/sending.py` 的 `_capacity`/`_schedule_next`、`core/utils.py` 的 `check_work_window`、`storage/job_store.py` 的 `count_sent_since`/`next_window_slot`。

为什么不能动：30/2 小时与 150/天是对平台的自我约束，且统计口径直接来自 `jobs.sent_at`。改口径会导致额度算错，可能超额发送。

注意：`--force-window` 只忽略 2 小时窗口，**不允许突破每日上限**；这个语义不要改。

### 5.3 风控 / 登录失效的终止逻辑

涉及：`core/config.py` 的 `LOGIN_KEYWORDS` / `LIMIT_KEYWORDS` / `RISK_KEYWORDS`、`core/utils.py` 的 `check_response`、`browser/page_collect.py` 的 `start_chat` 风控检测、`workflow/sending.py` 中 `except AbortError` 的重新抛出条件。

为什么不能动：继续执行只会加重风控或导致误操作。`sending.py` 只对 `login_invalid` / `limit_reached` / `environment_abnormal` 重新抛出并终止，其它 `AbortError` 记失败后继续，这个分类要保留。

### 5.4 单实例锁

涉及：`core/lock.py`、`run_job_queue.py`。

为什么不能动：两个进程会同时操作同一个 Chrome 页面和 SQLite，必然互相打断点击节奏、抢滚动位置，并可能重复沟通。

注意：不要通过删除 `data/run.lock` 来"解锁"；锁是文件句柄级别的，删除文件不会释放另一个进程的锁。锁必须在 `finally` 中释放。

### 5.5 详情入库顺序与合并语义

涉及：`workflow/collecting.py` 的 `persist` / `run_collect_page`、`storage/job_store.py` 的 `save_detail` / `UPSERT_LIST_SQL` / `connect`。

不可交换的顺序：详情校验 → 计算优先级 → `save_detail` → `consider`。

不可破坏的语义：

- 列表 upsert **不能覆写** `send_status` / `sent_at` / 详情字段；
- `save_detail` 是合并式更新，列表响应晚到也不能把详情冲掉；
- `connect()` 在 `BaseException` 时仍要 `commit()`，保证 Ctrl+C 后已写入的数据不丢；
- 详情 id 与列表 id 不一致时必须记失败，不能入库。

### 5.6 点击成功的判定

涉及：`browser/page_collect.py` 的 `start_chat` 返回值、`workflow/sending.py` 的 `_send`。

判定规则：

- 弹窗关闭，或按钮变为「继续沟通」→ `sent`；
- 找不到按钮 / 12 秒内无弹窗 → `PageCollectError` → `failed`；
- 有弹窗但关不掉 → 先记 `sent`，再抛 `AbortError("stopped")` 终止整轮（避免遮罩下误点）；
- 页面跳到聊天页 → 记 `sent` 并停止本轮。

不要为了"减少失败"把无弹窗也记成成功，否则会重复打扰同一个 BOSS，也会让额度统计失真。

### 5.7 浏览器接入方式（同样是硬约束）

- 不使用 Playwright，不启用 `Runtime.enable` / `Page.enable` / `Debugger.enable`；只发 `Runtime.evaluate` 和 `Network.enable`。
- 不新增任何发送接口调用（`friend/add` 等）。
- 不记录接口响应体、消息正文、cookie 或 token 值到日志。

---

## 6. 修改流程（标准作业）

1. 读 README 第 5、6、7 章，确认改动落在哪一层。
2. 小步修改，一次只改一个关注点；优先改 `workflow` / `storage`，尽量不碰 `browser/page_collect.py`。
3. 静态检查：
   ```bash
   python -m py_compile workflow/cli.py workflow/sending.py browser/page_collect.py
   ```
4. 干跑验证（不点击「立即沟通」、不写沟通记录、不占额度，但会真实采集）：
   ```bash
   python run_job_queue.py --stage all --dry-run
   ```
5. 检查 `data/screen/queue_result.json` 的 `collect.error`、`details_ok`、`inline.sent`，以及终端日志节奏。
6. 若要验证真实点击，先用 `--stage collect` 只采集，再小流量跑 `--stage all`。
7. **不要并发运行**两个采集进程；跑之前确认没有其它终端在跑。

---

## 7. 数据库与状态文件

| 路径 | 作用 | 读写方 | 注意 |
| --- | --- | --- | --- |
| `data/run.lock` | 单实例锁 | `core/lock.py` | 内容为 `pid 时间`；文件存在不代表被锁 |
| `data/zhipin/zhipin.db` | 岗位主库 | `storage/job_store.py` | 主键 `encrypt_job_id`；`send_status` 是沟通真相 |
| `data/zhipin/send_log.jsonl` | 每次沟通尝试结果 | `workflow/sending.py` | 一行一条，仅 `time/job_id/job_name/status`（失败再加 `error`） |
| `data/zhipin/jobs.json` | 导出结果 | `export_json` | 按 `priority_score DESC, list_seen_at DESC` 取前 `--pool-limit` 条 |
| `data/screen/queue_result.json` | 最近一次运行摘要 | `workflow/cli.py` | 每次运行覆写；含 `stage/dry_run/collect.error/inline` |
| `data/browser_auth.json` | 可选 token 覆盖 | `browser/auth.py` | 只读；页面模式不需要；超过 12 小时会提示 |
| `data/zhipin/expects.json` | 期望快照 | API 模式 `expectations.py` | 页面模式不写 |
| `params/priority_keywords.json` | 优先级关键词 | `job_store.load_priority_keywords` | 按 mtime 缓存，改完下次采集生效 |

关键字段（`jobs` 表）：

- 采集：`list_seen_at`、`detail_status`、`detail_fetched_at`、`detail_error`
- 岗位：`job_name`、`salary_desc`、`city_name`、`job_labels`、`skills`、`post_description`
- BOSS/公司：`boss_online`、`boss_active_desc`、`brand_*`
- 打分：`priority_score`、`priority_tags`
- 沟通：`send_status`（`sent` / `failed` / 空）、`sent_at`、`send_error`

额度统计全部基于 `sent_at`：当天用 `substr(sent_at,1,10)`，窗口用 `sent_at >= now - N 小时`。

---

## 8. 日志阅读指南

### 8.1 终端日志 = 实时拟人化操作日志

它在**操作发生时**打印，用来判断脚本此刻在做什么、节奏是否正常。典型行：

```text
已取得「全栈工程师」期望岗位列表
点击了「高级全栈开发工程师」岗位，查看详情信息...
已了解「高级全栈开发工程师」岗位（刚刚活跃，20-30K）
浏览了「Java 开发」岗位，优先级 2，暂不沟通
准备和「AI 全栈工程师」打个招呼（优先级 9）
先看看「AI 全栈工程师」的岗位详情，23 秒后再打招呼
点击了「AI 全栈工程师」岗位，发送了求职信息
```

这类日志**不能**当成发送记录：它只说明脚本做了什么，不代表最终状态（例如弹窗关不掉时会先打印发送成功再终止）。

### 8.2 `send_log.jsonl` = 结果日志

一行一条，只记录**真实尝试**的结果，不保存消息正文：

```json
{"time":"2026-11-26T10:47:53+08:00","job_id":"347581f40608682f0nJ_2ty9E1JR","job_name":"ATH事业群-AI Agent研发工程师/专家-杭州","status":"sent"}
{"time":"2026-11-26T10:50:12+08:00","job_id":"...","job_name":"...","status":"failed","error":"点击「立即沟通」后未出现问候弹窗"}
```

`failed` 不会消耗成功额度，但会计入下一次 30~60 秒间隔；下一轮会补发。

### 8.3 `queue_result.json` = 本次运行摘要

看四个地方：`collect.error`（有没有异常终止）、`collect.details_ok`（详情入库数）、`collect.inline.sent/failed/pending`（沟通结果）、`started_at/finished_at`（是否中途被杀）。

### 8.4 终端错误前缀

- `[错误]`：`console.error`，走 stderr，通常伴随非 0 退出码。
- `[终止]`：队列被终止（`workflow/queue_runner.py`，API 模式）。
- `[建议]`：`ABORT_HINTS` 给出的下一步建议。

---

## 9. 排障清单与验证命令

### 9.1 环境与连接

```bash
python run_job_queue.py --diagnose
```

- 打印页面 URL、`readyState`、cookie 名、`hasBst`、token 候选、`loggedIn`。
- 未登录也会返回 0，只打印提示；`--diagnose` 不写结果文件，但同样需要能抢到 `run.lock`。

调试端口：

```powershell
curl.exe -s http://127.0.0.1:9222/json/version
Get-Content data/run.lock
```

### 9.2 数据与额度

```bash
python -c "import sqlite3;from storage import job_store;c=sqlite3.connect('data/zhipin/zhipin.db');c.row_factory=sqlite3.Row;print(job_store.today_stats(c));print(job_store.window_stats(c,2,30))"
python -m json.tool data/screen/queue_result.json
```

窗口与当天统计必须调用 `job_store` 的函数，不要自己拼 SQL：`sent_at` 带时区且用 `T` 分隔，直接和 `datetime('now')` 比较会算错。启动面板显示的就是这两个函数的结果。

### 9.3 常见故障对照

| 现象 | 可能原因 | 验证 / 处理 |
| --- | --- | --- |
| 启动即「已有另一个 run_job_queue 正在运行」 | 锁被占用 | 找到并退出另一个终端；不要删锁文件 |
| 退出码 7 | 未登录或终端非交互 | 在 Chrome 里登录；换可交互终端 |
| `连接 Chrome 调试端口失败` | 没启动 Chrome / 端口不对 | 先 `python start_chrome.py --no-run`，再检查 9222 |
| `没有找到匹配「zhipin.com」的标签页` | 标签页被关或跳走 | 重新打开职位页，或重跑 |
| `岗位列表 DOM 未渲染` | 页面未加载完、被验证页拦截 | 人工确认页面；必要时刷新后重跑 |
| `原生滚轮不可用` | 窗口最小化/被遮挡/前台切换失败 | 保持窗口可见，采集时不要动鼠标 |
| `database is locked` | 另一个进程在写 | 只保留一个进程；`connect` 有 10 秒超时 |
| 大量 `failed` 且原因都是"未出现问候弹窗" | 页面结构变化或按钮状态异常 | 人工点一次确认页面；再检查 `CHAT_*` 选择器 |
| 沟通数不增长但日志说"准备打招呼" | 在等 30~60 秒间隔，或额度已满 | 看是否有「先看看…N 秒后再打招呼」 |

### 9.4 页面结构变化时

先只改选择器常量，不要动流程：

- 卡片：`.job-card-box`，链接 `a.job-name[href*="/job_detail/<id>.html"]`
- 期望标签：`a.expect-item`（排除「推荐」与不可见项；期望必须用 DOM 点击，不能用坐标点击）
- 沟通按钮：`a.op-btn-chat`；取点时按文字含「立即沟通」筛选，其文字还用于判断是否已变成「继续沟通」
- 留在此页：`a.zp-start-chat-greet-btn` / `.greet-boss-dialog .cancel-btn` / 兜底按文字
- 关闭：`span.zp-start-chat-greet-close` / `.greet-boss-dialog .close`
- 详情面板：`.job-detail-box`

改完用 `--dry-run` 验证采集链路，再小流量验证一次真实点击。

---

## 10. 代码约定

- 注释与文档字符串用中文；新增逻辑要说明"为什么"，而不是复述代码。
- 终端输出统一走 `core.console`，保持拟人化描述；不要在业务代码里 `print` 裸接口状态。
- 不打印、不落盘 token / cookie / 响应体 / 消息正文。
- 所有时间戳使用本地时区 ISO 格式（`now_iso()`）。
- 新增参数时同步更新：`workflow/cli.py` 的默认值与 help、README 第 12 章表格。
- 新增持久化字段时同步更新 `SCHEMA`、`save_detail`、`row_to_dict`。
- 不要引入新的第三方依赖；目前外部依赖只有 `websocket-client`。

---

## 11. 提交前检查清单

- [ ] 没有启用 `Runtime.enable`，没有引入 Playwright。
- [ ] 没有新增发送接口调用，没有记录响应体/消息正文。
- [ ] 滚动、鼠标轨迹、卡片取点、停留、分心行为仍保留，数值未被"顺手优化"。
- [ ] 滚到底默认最多刷新 2 次，刷新后重新选回期望；`--max-refreshes 0` 能关闭。
- [ ] 期望仍用 DOM 点击并校验城市；仍然只点当前视口内的卡片，没有 `scrollIntoView`。
- [ ] 沟通仍遵守 30~60 秒间隔、2 小时 30 个、每日 `--daily-limit` 个。
- [ ] 风控 / 登录失效 / 沟通上限仍然立即终止；普通失败仍只记 `failed` 并继续。
- [ ] 详情仍是"先入库、再沟通"，`send_status` 不会被列表 upsert 覆写。
- [ ] 单实例锁仍在 `finally` 释放，退出码仍是 0/1/2/3/7 的语义。
- [ ] `connect()` 在异常退出时仍会提交已写入的数据。
- [ ] `--dry-run` 能完整跑通，`queue_result.json` 与终端日志符合预期。
- [ ] README 的参数表与 `workflow/cli.py` 一致（尤其 `--inline-min-priority` 默认 3）。
