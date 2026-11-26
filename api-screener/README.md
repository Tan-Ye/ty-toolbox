# BOSS 直聘采集与页面内打招呼（api-screener）

在**已登录的真实 Chrome** 里浏览职位列表、采集岗位详情、按优先级在详情页点击「立即沟通」。
脚本只操作浏览器（CDP + Windows 原生输入），**不调用任何发送接口**，也不需要抓包软件。

三条铁律：

1. **不主动请求接口**：默认页面模式只监听浏览器自己发出的响应。
2. **不绕过任何人机验证**：登录、求职期望选择、窗口满时的取舍都必须人工完成。
3. **不加速**：滚动、点击、停留、沟通间隔都是刻意拟人化的，不要为了快而调参数。

> 给第一次接手的 AI：请先读完第 4、5、6、11 章，再执行任何命令。

---

## 1. 这个项目做什么

| 能力 | 说明 |
| --- | --- |
| 采集列表 | 滚动职位推荐页，抓浏览器自己发出的列表响应 |
| 采集详情 | 点击当前视口内的岗位卡片，抓浏览器自己发出的详情响应 |
| 入库打分 | 按 `encryptJobId` 去重写入 SQLite，按关键词权重算优先级 |
| 页面内沟通 | 在详情页点「立即沟通」→ 弹窗点「留在此页」，不跳转聊天页 |
| 导出 | 导出按优先级排序的精简 `jobs.json` |
| 额度和时间窗 | 任意 2 小时 30 次、每天 150 次、默认工作日 09:00~18:00 |

明确不做：破解验证码、模拟登录、多账号、大规模并发、绕过每日上限、调用发送接口。

---

## 2. 环境要求

- Windows 10/11（依赖 `msvcrt` 文件锁与 `user32` 原生输入）
- Python 3.10+
- Google Chrome（`start_chrome.py` 会按常见路径查找 `chrome.exe`）
- 第三方依赖只有 `websocket-client`

```bash
pip install websocket-client
```

项目**不使用 Playwright**。Playwright 会启用 CDP 的 `Runtime` 域，触发 BOSS 反调试导致页面反复整页重载；本项目改用原生 CDP，只发 `Runtime.evaluate` 与 `Network.enable`（详见 `agents.md` 第 5.7 节）。

---

## 3. 快速开始

必须在**可交互终端**里运行（脚本会用 `input()` 等待登录确认、期望编号、窗口选择）。

```bash
# 推荐：启动/复用 Chrome，就绪后自动执行采集 + 页面内沟通
python start_chrome.py

# 只浏览采集，不主动沟通
python start_chrome.py --stage collect

# 干跑：正常采集，只模拟沟通决策，不点击「立即沟通」
python start_chrome.py --stage all --dry-run

# 只启动 Chrome，不自动执行第二步
python start_chrome.py --no-run
```

Chrome 已带调试端口时也可以直接：

```bash
python run_job_queue.py                 # 采集 + 页面内沟通
python run_job_queue.py --stage collect # 只采集
python run_job_queue.py --diagnose      # 只检查浏览器/登录/token
```

首次运行需要你在弹出的 Chrome 窗口里**手动登录 BOSS**；登录态保存在 `.chrome-profile`，之后通常不用重复登录。

---

## 4. 数据从哪里来

### 4.1 页面模式（`--collect-mode page`，默认）

脚本只做两件事：**滚动/点击页面**，以及**监听页面自己发出的网络响应**。
响应匹配规则在 `browser/cdp_client.py`（`LIST_URL_KEY` / `DETAIL_URL_KEY`）：

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| 岗位列表 | 浏览器发出的 `/wapi/zpgeek/pc/recommend/job/list.json` | 由滚动触发，脚本用 `Network.responseReceived` + `Network.getResponseBody` 读取 |
| 岗位详情 | 浏览器发出的 `/wapi/zpgeek/job/detail.json` | 由点击卡片触发 |
| 求职期望 | 页面 DOM 的 `a.expect-item` | 只取可见、文字非「推荐」的标签；**不读接口** |
| 登录判断 | cookie `bst`，或页面存储中键名含 `token` 的项 | 见 4.3 |
| token / zp_token | **页面模式不需要** | 只在 `--collect-mode api` 使用 |

要点：

- 页面模式**不主动 fetch 任何业务接口**，所以请求特征与真人浏览一致。
- 详情响应的业务数据在 `zpData` 下（`jobInfo` / `bossInfo` / `brandComInfo`），`securityId` / `lid` / `sessionId` 在 `data` 顶层；代码同时兼容业务数据直接在顶层的情况（`browser/page_collect.py` 的 `_detail_data`）。
- 列表响应里取 `zpData.jobList` 与 `zpData.hasMore`，按 `encryptJobId` 去重。

### 4.2 API 备用模式（`--collect-mode api`，不推荐）

直接请求 `core/config.py` 中固化的期望/详情地址，列表参数来自 `params/list_params.json`。
这种模式容易触发风控，只在接口排查时使用；需要 token，并且期望快照会写到 `data/zhipin/expects.json`（页面模式不写）。

### 4.3 登录判断与 token

- 登录预检（`browser/auth.py`）：页面存在 cookie `bst`，或 localStorage/sessionStorage 中有键名含 `token` 的项，即视为已登录；探测脚本还会额外列出 cookie 名中含 token 的候选。
- 采集开始前（`browser/page_collect.py` 的 `wait_ready`）会再检查一次 `bst` 或 token 候选，否则直接报「当前 Chrome 未登录 BOSS」。
- `token` / `zp_token` 只有 `--collect-mode api` 才需要。可用 `--token` / `--zp-token`、环境变量 `ZP_HEADER_TOKEN` / `ZP_HEADER_ZP_TOKEN`，或 `data/browser_auth.json` 覆盖；当该文件里有 token 且超过 12 小时未更新时，启动会提示可能过期（页面模式可忽略）。
- API 模式里 `zp_token` 缺省取 cookie `bst`。

### 4.4 `collect_apis.py` 是独立工具

它通过 Reqable（Reqable MCP 服务，需在 `config.json` 填访问令牌）导出一段时间内的抓包记录，生成 `data/raw_records.jsonl`、`data/apis.json`、`data/apis.csv`。
**它不参与日常采集/沟通流程**，只在接口变更、需要重新确认端点或参数时手动运行。

---

## 5. 完整运行流程

```text
start_chrome.py
  ├─ 9222 已在监听 → 直接复用
  └─ 否则启动 Chrome（--user-data-dir=.chrome-profile）
       + 打开 https://www.zhipin.com/web/geek/jobs，最多等 30s
        ↓
  run_job_queue.py（先抢 data/run.lock，抢不到退出码 2）
        ↓
  参数校验 → 今日概况 + 2 小时窗口决策（不需要浏览器）
        ↓
  登录预检 → 未登录：输入 Y 重试 / q 退出（退出码 7）
        ↓
  确认 /web/geek/jobs 与列表 DOM 已渲染
        ↓
  读取 a.expect-item → 终端列出编号 → 人工选择并二次确认
        ↓
  切换期望（必要时先切走再切回，强制从第一页加载）→ 校验城市
        ↓
  循环：随机滚动 → 点视口内可见卡片 0~2 张 → 抓 detail.json
        ↓
  详情立即入库（算优先级）→ 决定是否在当前详情页打招呼
        ↓
  点「立即沟通」→ 弹窗点「留在此页」→ 继续浏览
        ↓
  收尾：把已入队但没到间隔的岗位发完 → 导出 jobs.json
        ↓
  写 data/screen/queue_result.json → 打印结束语与退出码
```

### 5.1 第一步：启动/复用 Chrome（`start_chrome.py`）

- 先访问 `http://127.0.0.1:9222/json/version`；能响应就复用，不重复开窗。
- 否则用 `--remote-debugging-port=9222 --user-data-dir=.chrome-profile` 启动 Chrome 并打开职位页。
- 端口最多等 `--wait`（默认 30 秒）。
- 就绪后自动执行 `run_job_queue.py`，未显式给 `--stage` 时补 `--stage all`，并把 `--cdp-url http://127.0.0.1:<port>` 传过去。
- `--no-run` 只启动 Chrome。
- 如果同一个 profile 已有 Chrome 在运行却没有调试端口，新实例不会带端口启动，脚本会在 `--wait` 内等不到端口后报错；此时需要先完全退出那个 Chrome。

### 5.2 启动概况与 2 小时窗口决策（`workflow/startup.py`）

这一步**在登录预检之前**执行，不需要浏览器，直接读数据库：

```text
[今日概况]
  采集：列表 225 条，详情成功 120 条
  沟通：50/150，失败 0
  2 小时窗口：12/30，还可沟通 18 个
```

- 窗口已满时，只有 `--stage all` 且非干跑才会询问：

  1. 只浏览，不沟通（默认，回车即选）
  2. 继续沟通（忽略 2 小时窗口，风险自负）
  3. 退出（退出码 3）

- 选 2 只会把 `--force-window` 置为真，**不会突破每日 150 的硬上限**。
- 当天已沟通数达到 `--daily-limit` 时，直接降级为只浏览。
- `--stage collect`、`--dry-run`、`--force-window` 都不会弹这个询问。

### 5.3 登录预检（`browser/auth.py`）

- 未登录时提示你在 Chrome 里登录，输入 `Y/y/yes` 重新预检；输入 `q/quit/n/no/exit` 退出；空回车视为重新预检。
- 终端不是交互式（`input()` 抛 `EOFError`）时直接返回失败，**退出码 7**。
- 预检通过后才进入采集，未登录时不会发出任何请求。

### 5.4 求职期望必须人工确认（`workflow/expectations.py`）

- 从页面读 `a.expect-item`（排除「推荐」、排除不可见），在终端列出编号。
- 默认编号优先取 `--expect-index`，否则取包含 `--expect-city` 的标签，否则第 1 个。
- 你必须输入编号，再输入 `Y`（或直接回车）确认，否则不会开始采集。
- 城市取所选标签末尾括号里的内容，例如「全栈工程师(杭州)」→ `杭州`；没有括号时退回 `--expect-city`。
- 切换后会校验列表城市（优先用列表响应里的 `cityName`，没有就读前 5 张卡片），不一致会停止，避免采到别的城市。
- 切换时会丢弃切换途中抓到的其它城市列表，只保留目标城市的最后一页。

### 5.5 滚动与点击采集（`browser/page_collect.py`）

- 每轮先看当前视口内有哪些可见卡片（`.job-card-box`，可见高度至少 `min(80px, 卡片高度 × 50%)`）。
- 从「已抓到列表数据、且本轮没点过」的可见卡片里随机取 **0~2 张**（权重 0.2 / 0.5 / 0.3），点击并等待详情响应（最多 12 秒）。
- 然后滚动一次，等待 `--scroll-min-delay`~`--scroll-max-delay`。
- 列表数达到 `--list-target` **且**详情数达到 `--detail-limit` 时结束；连续 3 轮滚动后 `scrollY` 没有增长，视为到底：默认刷新页面并重新选回期望（`--max-refreshes`，默认 2 次），刷新后仍到底则结束。
- 每个详情拿到后**立即入库**，再进入沟通决策（顺序见第 7 章）。
- 已有详情且已沟通过、或已确认不达标（低优先级/不活跃/已下线）的岗位会被跳过；达标但没发出去的旧详情本轮会重新点击补发。

具体随机量见第 6 章。

### 5.6 详情入库

详情响应转成入库字段（`workflow/collecting.py` 的 `build_detail_payload`），包含：

- 岗位：名称、职位名、地点、地址、薪资、经验、学历、职位描述、是否下线
- BOSS：姓名、职位、是否在线、活跃描述
- 公司：名称、行业、规模、融资阶段
- 详情标识：`securityId` / `lid` / `sessionId`
- 优先级：`priority_score` 与命中的 `priority_tags`

写入是合并式的（`storage/job_store.py` 的 `save_detail`）：列表字段被覆写，详情字段单独合并，**沟通状态不会被覆写**。

### 5.7 收尾与导出

- `--stage all` 会把已入队但还没到沟通间隔的岗位发完（`InlineSender.finish`）。
- 按 `priority_score DESC, list_seen_at DESC` 导出前 `--pool-limit`（默认 150）条到 `data/zhipin/jobs.json`。
- 运行结果写入 `data/screen/queue_result.json`，包含开始/结束时间、阶段、干跑标记、是否报错、滚动/刷新/耗时、内联沟通统计。

---

## 6. 随机性设计（为什么不能"提速"）

所有随机行为集中在 `browser/page_collect.py`（页面层）与 `browser/os_input.py`（系统输入层）。
它们是防风控的一部分，**不是装饰**，改动前请读 `agents.md`。

### 6.1 滚动

| 行为 | 取值 |
| --- | --- |
| 每轮滚动距离 | `randint(180,420)` / `randint(420,850)` / `randint(850,1300)` px，三档随机选一 |
| 一次滚动拆分 | 1~3 段；非末段占剩余量 30%~55%，末段拿走剩余；低于 40px 的段跳过 |
| 段间停顿 | 0.15~0.6 秒 |
| 反向小滚 | 12% 概率先向上滚 60~200 px，停 0.3~0.9 秒再继续 |
| 轮间等待 | `--scroll-min-delay` ~ `--scroll-max-delay`（默认 2~4 秒） |
| 额外停顿 | 每轮另有 8% 概率多停 3~8 秒 |
| 原生滚轮落点 | 窗口客户区锚点（宽 35%、高 60%）再随机抖动：x `-60~+40`、y `-120~+120` |
| 滚动前指针移动 | 从当前位置沿随机二次贝塞尔弧线移到落点，8~28 步，0.22~0.55 秒 |
| CDP 滚轮回退落点 | 视口内随机：x 16%~50%、y 30%~75%（同样先走一段轨迹） |
| 到底刷新 | 连续 3 轮 `scrollY` 不增长后 `location.reload()`，等 2~4 秒并重新选回原期望；默认最多 2 次 |

- 原生滚轮（`SendInput`）优先；抛 `MouseControllerError` 时本次及之后都改用 CDP 滚轮，并打印「原生滚轮不可用」提示。
- 滚轮刻度按 `round(delta / 120)` 换算，向上为负。

### 6.2 鼠标与点击

- **只点当前视口内的卡片**，不调用 `scrollIntoView`；卡片滚出视口就跳过并打日志「已滚出视口或不可点击」。
- 卡片内取点（`_card_point`）：x = 卡片左边界 + 卡片宽度 × (8%~52%)，y = 可见上下边界内随机（各留 6px），**最多试 8 个候选点**，用 `elementFromPoint` 校验命中卡片且不在 `<a>` 链接上。
- 点击前先移动到 `(x±28, y±18)` 悬停 0.25~0.9 秒，再点真实随机点。
- 鼠标轨迹（`browser/cdp_client.py` 的 `mouse_move`）：14~30 步，二次贝塞尔曲线，控制点在中点附近 ±80 / ±50 偏移，`smoothstep` 缓动；每步间隔 0.008~0.035 × (1+t) 秒，越接近目标越慢；落点后再停 0.08~0.4 秒才按下，按住 0.06~0.16 秒。
- 「立即沟通」「留在此页」这类按钮使用另一套取点（`_element_point`）：x 18%~82%、y 26%~74%，最多试 6 个候选点。
- 沟通按钮点击前悬停 `(x±12, y±6)`，停 0.3~0.9 秒。
- 点「立即沟通」和「留在此页」时 `human=True`：先沿短轨迹移到按钮，再按住 0.06~0.16 秒。

### 6.3 详情停留与分心

- 每个详情停留 `random.uniform(--detail-min-delay, --detail-max-delay)`（默认 3~6 秒）。
- **10%** 概率额外多停 6~14 秒。
- 每条详情结束后 **6%** 概率插入一次分心行为：

| 类型 | 时长 | 权重 |
| --- | --- | --- |
| 切到其它标签页再回来 | 2~6 秒 | 0.55 |
| Alt+Tab 切到其它应用再回来（真实键盘事件） | 3~9 秒 | 0.45 |
| 切到「消息」页看一眼再回职位页（整轮最多 1 次） | 在消息页停 2~5 秒，回页后再等 0.6~1.5 秒 | 0.25（启用时三类权重变为 0.4 / 0.35 / 0.25） |

- 滚动循环里还有 **5%** 概率触发同类分心。
- 切到「消息」页回来后，如果之前选过期望，会重新选回原期望（不强制执行，避免多余请求）。
- 等待沟通间隔时（`idle_wait`）也不是静止的：每 1.5~3.5 秒把鼠标移到视口右侧区域（x 55%~90%、y 20%~70%）。

### 6.4 其它拟人化细节

- 从第 1 张到第 N 张卡片是**随机打乱**后取，不按顺序点。
- 每次滚动后先在页面里 `pump` 收事件，让页面自己发请求，脚本不替页面发。
- 终端日志使用「点击了…查看详情…」「已了解…岗位」「浏览了…岗位」这类描述，而不是 `POST /xxx 200`。

---

## 7. 沟通决策顺序与日志（`workflow/sending.py`）

每个详情入库后调用一次 `consider(job, data, payload)`，**按顺序**判断，命中即返回：

| 顺序 | 条件 | 终端日志 |
| --- | --- | --- |
| 1 | 本轮前 `--inline-warmup`（默认 3）个详情 | `浏览了「X」岗位，先看看（预热 1/3）` |
| 2 | 详情 `jobInfo.invalidStatus` 为真 | `浏览了「X」岗位，岗位已下线` |
| 3 | 优先级 < `--inline-min-priority`（默认 3） | `浏览了「X」岗位，优先级 N，暂不沟通` |
| 4 | BOSS 非今日/3 日内活跃 | `浏览了「X」岗位，boss 最近不活跃，暂不沟通` |
| 5 | 数据库里已是 `sent` | `浏览了「X」岗位，之前已经沟通过` |
| 6 | 不在工作日/工作时间（`--ignore-work-hours` 可跳过） | `今天（周N）不是允许发送的工作日，先只浏览，不打招呼` / `当前 HH:MM 不在工作时间 09:00-18:00，先只浏览，不打招呼`（只打印一次） |
| 7 | 命中 `--inline-skip-rate`（默认 10%） | `浏览了「X」岗位，这次先跳过` |
| 8 | 每日额度或 2 小时窗口已满 | `今天已经沟通 S/150 个（2 小时窗口 W/30），先只浏览，不再打招呼` |
| 9 | 通过全部检查 | `准备和「X」打个招呼（优先级 N）` → 入队 |

- 入队后会调用 `flush_due(wait=True)`：没到间隔就**留在当前详情页**等（日志 `先看看「X」的岗位详情，N 秒后再打招呼`），到点再点，绝不会翻到别的岗位再点。
- 活跃判断（`storage/job_store.py` 的 `is_active`）：`bossOnline` 为真，或活跃描述包含「刚刚/今日/今天/在线/1日内/2日内/3日内/一日内/两日内/三日内/昨日/昨天」。
- 优先级分数来自岗位名、职位名、列表标签、技能与关键词的匹配（详见第 13 章）。

---

## 8. 成功 / 失败判定

页面沟通由 `browser/page_collect.py` 的 `start_chat` 完成：

1. 先核对当前可见详情面板文字包含岗位名，不一致会抛错并记为 `failed`（防止点错岗位）。
2. 在页面里找 `a.op-btn-chat` 且文字含「立即沟通」的按钮。
3. 找到并点击后，最多 12 秒轮询页面状态：
   - 出现风控关键词（安全验证 / 验证码 / 环境异常 / 环境存在异常）→ 立即终止整轮（退出码 2）。
   - 出现「留在此页」弹窗 → 停 2~5 秒看清楚，再点「留在此页」（兼容旧版 `a.zp-start-chat-greet-btn`、新版 `.greet-boss-dialog .cancel-btn`、以及按文字兜底）。
   - 弹窗消失 → `sent`。
   - 点不掉则尝试关闭按钮（`span.zp-start-chat-greet-close` / `.greet-boss-dialog .close`）；仍关不掉 → 记为**已发送**但立刻终止整轮，避免在遮罩下误点。
   - 按钮已经变成「继续沟通」→ 视为已沟通过（`sent`，`skipped=already_chat`）。
   - 页面跳到 `/web/geek/chat` → 记为已发送但停止本轮。
4. 找不到按钮、或 12 秒内既无弹窗也没有「继续沟通」→ 抛错，记 `failed` 与原因，**不消耗**成功次数，但会计入 30~60 秒间隔。

其它失败情况：

- 点击前详情面板岗位名对不上 → `failed`，同一轮不再点这个岗位。
- `failed` 会写入 `jobs.send_status/send_error` 和 `send_log.jsonl`。
- 下一轮启动时，达标但未发送（含失败）的旧详情如果仍在列表中出现，会重新点击补发。

---

## 9. 额度与时间窗

- **2 小时滚动窗口**：任意 2 小时内最多成功沟通 `SEND_LIMIT_MAX = 30` 个（`core/config.py`）；窗口长度可用 `--cooldown-hours` / `--window-hours` 调整。
- **每日上限**：默认 150（`--daily-limit`），即 BOSS 每日硬上限，不建议调高。
- **沟通间隔**：每次成功或普通失败（记 `failed` 后继续）都会重新随机 `--send-min-delay`~`--send-max-delay`（默认 30~60 秒）。启动时如果数据库里上一次发送还在间隔内，会先把下一次时间点顺延。
- **工作时间**：默认周一至周五 09:00~18:00（`--work-days` / `--work-start` / `--work-end`），**每次沟通前**再检查一次；`--ignore-work-hours` 只用于当天特批。
- 统计口径：直接按 `jobs.sent_at` 统计当天与 2 小时窗口，不依赖额外计数文件。

窗口统计与额度释放提示在 `storage/job_store.py`（`window_stats` / `next_window_slot`），面板展示在 `workflow/startup.py`。

---

## 10. 安全、并发与中断

### 10.1 单实例锁

- `run_job_queue.py` 启动时用 `data/run.lock`（`msvcrt.locking`）加锁，锁内写入 `pid 时间`。
- 抢不到锁时打印「已有另一个 run_job_queue 正在运行」，**退出码 2**，不触碰页面和数据库。
- 进程正常或异常退出都会释放锁；`data/run.lock` 文件本身会保留，内容停留在上一次的 `pid 时间` 行，不影响下次加锁。

### 10.2 风控与登录失效立即终止

- 页面点击「立即沟通」后检测到风控关键词 → `AbortError(environment_abnormal)` → 立即终止整轮（退出码 2）。
- API 备用模式的响应校验（`core/utils.py` 的 `check_response`）会按 `core/config.py` 的关键词分类：

| 类别 | 关键词 | 处理 |
| --- | --- | --- |
| `LOGIN_KEYWORDS` | 请先登录、未登录、登录已失效、登录状态、重新登录、身份验证、账号异常、登录过期 | 终止 |
| `LIMIT_KEYWORDS` | 上限、次数已用完、沟通次数、操作太频繁、操作频繁、稍后再试、请求过于频繁 | 终止 |
| `RISK_KEYWORDS` | 环境存在异常、环境异常、安全验证、请完成验证、验证码 | 终止 |

- **不要连续重试**：被风控打断后应先刷新页面或稍后再试，而不是马上再跑一次。

### 10.3 中断与数据一致性

- `storage/job_store.py` 的 `connect()` 在 `BaseException`（含 Ctrl+C / `SystemExit`）时仍会 `commit()`，已采集的详情和已记录的沟通不会回滚。
- Ctrl+C 由 `run_job_queue.py` 捕获，打印结束语并返回**退出码 3**。
- 单个岗位的普通失败（找不到按钮、没弹窗、岗位名不一致、详情未捕获）只记 `failed` 并继续；风控、登录失效、沟通上限、弹窗关不掉、页面跳转聊天页才会终止整轮。

### 10.4 采集期间的人工约束

- 保持 Chrome 窗口可见，不要最小化或完全遮挡；脚本会尝试还原并切到前台。
- 采集期间不要手动移动鼠标、敲键盘或切换窗口，否则可能干扰原生滚轮/Alt+Tab。
- 期望标签栏对悬停敏感，脚本用 DOM `a.click()` 切换，不用坐标点击。

---

## 11. 给 AI 的使用手册

### 11.1 必须使用可交互终端

脚本会在三个地方阻塞等待 `input()`：登录预检、求职期望选择与确认、2 小时窗口已满时的选择。
重定向输入、计划任务、CI、后台守护进程等非交互环境会在第一步失败（登录阶段直接退出码 7，期望阶段报「用户取消选择求职期望」并退出码 2）。

### 11.2 哪些步骤必须由人完成

| 步骤 | 为什么必须人工 |
| --- | --- |
| 在 Chrome 里登录 BOSS | 脚本不模拟登录、不处理验证码 |
| 选择并确认求职期望 | 直接决定采集范围，选错会采错城市/岗位 |
| 2 小时窗口满时选 1/2/3 | 涉及风控风险，不能由脚本默认"继续" |
| 风控出现后的处置 | 需要人工刷新/等待/重新登录 |

### 11.3 禁止事项

- 不要同时启动两个采集进程：第二个 `run_job_queue.py` 会被单实例锁拒绝；同时开两个 `start_chrome.py` 也可能互相干扰 Chrome 复用。
- 不要在采集进行中手动点击页面、滚动或切换标签页。
- 不要把 `--inline-skip-rate` 调成 0、把 `--send-min-delay/--send-max-delay` 调小、把 `--daily-limit` 调高来"提速"。
- 不要新增任何发送接口调用（`friend/add` 之类），不要保存接口响应体或消息正文。
- 不要用 Playwright 或其它会启用 CDP `Runtime` 域的方式控制页面。
- 不要在风控/登录失效后立即重试。

### 11.4 推荐的首次执行顺序

```bash
# 1) 先只检查环境，不发任何业务请求
python run_job_queue.py --diagnose

# 2) 干跑：正常采集、正常算优先级、只打印"本来要和谁打招呼"
python run_job_queue.py --stage all --dry-run

# 3) 小流量真跑：先只采集，确认入库和导出正常
python run_job_queue.py --stage collect

# 4) 确认无误后再允许页面内沟通（默认 all）
python start_chrome.py
```

### 11.5 如何判断运行状态

| 文件 | 含义 | 怎么看 |
| --- | --- | --- |
| `data/run.lock` | 单实例锁 | 有进程持锁时内容为 `pid 时间`；释放后文件保留旧内容，不能只看文件是否存在 |
| `data/screen/queue_result.json` | **最近一次**运行结果 | 看 `started_at/finished_at`、`stage`、`dry_run`、`collect.error`、`collect.scrolls/refreshes/duration_sec`、`collect.inline.sent/failed/pending` |
| `data/zhipin/send_log.jsonl` | 每次真实发送尝试的结果 | 一行一条，`status` 为 `sent`/`failed`；不含消息正文 |
| `data/zhipin/zhipin.db` | 岗位主库 | `jobs.send_status`、`sent_at`、`priority_score`、`detail_status` |
| `data/zhipin/jobs.json` | 导出的精简列表 | 按优先级排序，含岗位/BOSS/公司/详情/优先级/沟通状态 |

快速查询示例：

```bash
python -c "import sqlite3;c=sqlite3.connect('data/zhipin/zhipin.db');print(c.execute('select send_status,count(*) from jobs group by send_status').fetchall())"
python -m json.tool data/screen/queue_result.json
```

### 11.6 退出码

| 退出码 | 含义 | 常见原因 |
| --- | --- | --- |
| 0 | 完成 | 正常结束，或本轮没有可沟通岗位 |
| 1 | 未预期错误 | 入口层的 CDP 异常等 |
| 2 | 异常终止 | 风控、登录失效、页面结构失败、数据库被占用、单实例冲突 |
| 3 | 手动停止 | Ctrl+C，或窗口面板选择「退出」 |
| 7 | 未登录 | 用户放弃登录，或终端非交互 |

### 11.7 失败处置原则

1. **先看退出码和错误行**，再看 `queue_result.json` 里的 `collect.error`。
2. 退出码 7：在 Chrome 里登录后再跑，不要循环重试。
3. 退出码 2 且提示风控/安全验证：停止，刷新页面，等一段时间再试。
4. 退出码 2 且提示数据库被占用：确认没有第二个进程，再重跑。
5. 退出码 3：这是人为停止，数据已提交，可以直接重跑。
6. 有 `failed` 记录：只要岗位下一轮仍出现在列表中，会自动重新点击补发，不需要手动改库。
7. 任何情况下都**不要**通过修改随机性和额度参数来"追进度"。

---

## 12. 常用参数（以 `workflow/cli.py` 为准）

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--stage` | `all` | `all` = 采集 + 页面内沟通；`collect` = 只采集 |
| `--diagnose` | - | 只检查页面、登录、token 候选，不发业务请求 |
| `--dry-run` | - | 干跑：正常采集与决策，不点「立即沟通」、不写沟通记录、不占额度 |
| `--collect-mode` | `page` | `page` 抓浏览器自己的响应；`api` 直接请求（不推荐） |
| `--cdp-url` | `http://127.0.0.1:9222` | Chrome 调试端口 |
| `--page-match` | `zhipin.com` | 用来匹配 BOSS 标签页的 URL 片段 |
| `--input-mode` | `os` | 滚轮方式：`os` 原生滚轮，失败自动回退 CDP；`cdp` 直接用页面滚轮 |
| `--max-scrolls` | `150` | 最多滚动次数 |
| `--max-refreshes` | `2` | 滚到底后最多刷新几次，0=不刷新 |
| `--scroll-min-delay` / `--scroll-max-delay` | `2` / `4` | 每轮滚动后的等待（秒） |
| `--detail-limit` | `150` | 最多采集多少个详情 |
| `--list-target` | `0` | 列表最多采集多少条；0 表示等于 `--detail-limit` |
| `--pool-limit` | `150` | 导出时按优先级取前多少条 |
| `--detail-min-delay` / `--detail-max-delay` | `3` / `6` | 每个详情停留时间（秒） |
| `--inline-min-priority` | `3` | 主动沟通的最低优先级分数 |
| `--inline-warmup` | `3` | 前 N 个详情只浏览不沟通 |
| `--inline-skip-rate` | `0.1` | 达标岗位的随机跳过概率 |
| `--send-min-delay` / `--send-max-delay` | `30` / `60` | 两次沟通之间的间隔（秒） |
| `--daily-limit` | `150` | 每日沟通上限 |
| `--cooldown-hours` / `--window-hours` | `2` | 滚动窗口小时数（两者同义） |
| `--work-start` / `--work-end` | `09:00` / `18:00` | 允许沟通的时间段，必须早于结束时间 |
| `--work-days` | `1,2,3,4,5` | 允许沟通的星期（1=周一） |
| `--ignore-work-hours` | - | 临时忽略工作日/工作时间 |
| `--force-window` | - | 忽略 2 小时窗口（风险自负），不突破每日上限 |
| `--expect-index` | `0` | 期望默认编号；0 = 按城市推荐；**仍需人工确认** |
| `--expect-city` | `杭州` | 期望默认城市；所选标签无城市时作为回退 |
| `--token` / `--zp-token` | - | 仅 API 备用模式需要 |
| `--auth-file` | `data/browser_auth.json` | token / zp_token 覆盖文件（只读） |
| `--list-params` | `params/list_params.json` | API 模式的列表参数 |
| `--list-pages` | `10` | API 模式最多翻几页（每页 15 条） |
| `--list-page-min-delay` / `--list-page-max-delay` | `10` / `20` | API 模式翻页间隔（秒） |
| `--timeout` | `30` | 单次 CDP 请求超时（秒） |
| `--db` | `data/zhipin/zhipin.db` | SQLite 路径 |
| `--export-json` | `data/zhipin/jobs.json` | 导出路径 |
| `--send-log` | `data/zhipin/send_log.jsonl` | 沟通日志路径 |
| `--out` | `data/screen/queue_result.json` | 运行结果路径 |

`start_chrome.py` 专有参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--port` | `9222` | 调试端口 |
| `--profile` | `.chrome-profile` | Chrome 独立用户目录（保存登录态） |
| `--url` | `https://www.zhipin.com/web/geek/jobs` | 启动时打开的页面 |
| `--wait` | `30` | 等待调试端口就绪的秒数 |
| `--no-run` | - | 只启动/复用 Chrome，不执行第二步 |

其它参数会原样透传给 `run_job_queue.py`（例如 `--stage collect`、`--dry-run`）。

---

## 13. 自定义优先级关键词

优先级分数来自 `params/priority_keywords.json`，直接编辑即可，下次采集自动生效：

```json
{
  "keywords": [
    {"keyword": "前端", "weight": 4},
    {"keyword": "rust", "weight": 5}
  ]
}
```

- 英文关键词按**整词**匹配（`js` 不会命中 `json`），中文按包含匹配。
- `weight` 必须是正整数，重复关键词只算第一次。
- 参与打分的文本：岗位名、职位名、列表标签、技能。
- 文件缺失、JSON 错误或没有有效条目时，回退到 `storage/job_store.py` 的内置默认关键词并打印告警。

---

## 14. 目录结构与文件职责

```text
api-screener/
├── start_chrome.py          启动/复用 Chrome（9222），就绪后自动执行第二步
├── run_job_queue.py         薄入口：单实例锁 + 调用 workflow.cli.main + 退出码处理
├── collect_apis.py          独立工具：导出 Reqable 抓包（非日常流程）
├── core/
│   ├── config.py            路径、接口地址、SEND_LIMIT_MAX、退出码、登录/额度/风控关键词
│   ├── errors.py            AbortError（带 kind 与 payload）
│   ├── utils.py             URL、响应校验、工作时间判断、时间格式化
│   ├── lock.py              data/run.lock 单实例锁
│   └── console.py           终端横幅、步骤、拟人化日志、结束语
├── browser/
│   ├── cdp_client.py        原生 CDP：Runtime.evaluate、Network 抓响应、Input 鼠标/滚轮、切标签页
│   ├── page_collect.py      页面采集：就绪检查、期望标签、滚动、可见卡片点击、详情、页面内沟通、分心
│   ├── os_input.py          Windows 原生滚轮、窗口前台、Alt+Tab（DPI 感知）
│   └── auth.py              登录预检、token 读取、CDP 客户端工厂
├── workflow/
│   ├── cli.py               参数定义与校验、主流程编排、结果落盘
│   ├── startup.py           今日概况与 2 小时窗口决策
│   ├── expectations.py      期望读取、人工选择、城市解析与校验
│   ├── collecting.py        页面采集主流程、详情入库、旧详情补发
│   ├── sending.py           沟通决策、额度、间隔、日志、失败记录
│   └── queue_runner.py      API 备用模式的顺序队列（随机间隔、终止信号）
├── storage/
│   └── job_store.py         SQLite 表结构、入库、优先级、额度统计、导出
├── params/
│   ├── list_params.json     API 备用模式的列表接口参数
│   └── priority_keywords.json 优先级关键词与权重
└── data/
    ├── run.lock             单实例锁文件
    ├── screen/queue_result.json 最近一次运行结果
    ├── browser_auth.json    可选：token / zp_token 覆盖（只读）
    └── zhipin/
        ├── zhipin.db        岗位主库
        ├── jobs.json        导出的精简岗位列表
        ├── send_log.jsonl   沟通结果日志
        └── expects.json     API 模式的期望快照
```

说明：`data/` 下也可能看到旧版本遗留的 `apis.json`、`raw_records.jsonl`、`screen/action.json` 等文件，当前代码不读取它们，可以忽略或自行清理。

---

## 15. 常见问题

**未登录 / 想继续登录**

- 按终端提示在 Chrome 里完成登录，输入 `Y` 重新预检；输入 `q` 退出。

**终端无法交互 / 计划任务里跑**

- 登录确认、期望选择、窗口选择都需要 `input()`；非交互环境会退出码 7 或报「用户取消选择求职期望」。请改用真实终端。

**调试端口连不上**

- 确认 Chrome 窗口还开着，且 9222 端口可访问。
- 某些 IDE/沙箱会在命令结束时回收子进程；把 Chrome 放在持续运行的终端里，或手动执行脚本打印的启动命令。
- 用同一个 `.chrome-profile` 但没开调试端口的 Chrome 正在运行，会挡掉新实例，需要先完全退出。

**API 模式报 `auth_missing ['token']`**

- 只有 `--collect-mode api` 需要 token；页面模式不依赖它。检查 `data/browser_auth.json` 是否过期，必要时删除后重试。

**2 小时窗口已满**

- 启动时选 `1` 只浏览，或选 `2` 忽略窗口继续（风险自负），或等窗口释放。
- 非交互环境可用 `--force-window`，但请确认这是你想要的。

**干跑会真的沟通吗？**

- 不会。`--dry-run` 不点「立即沟通」、不写沟通记录、不消耗窗口和每日额度；但**仍会正常采集、入库、导出**，也会正常滚动和停留。

**提示 database is locked / 已有另一个 run_job_queue 在运行**

- 同一时间只允许一个进程操作页面和数据库；先退出另一个终端。
- 不要用删除 `data/run.lock` 的方式"解锁"，锁是靠文件句柄持有的，删文件解决不了问题。

**采集中提示原生滚轮不可用 / 输入超时**

- 保持 Chrome 窗口可见，不要最小化或完全遮挡。
- 采集期间不要手动操作鼠标、键盘或切换窗口。
- 脚本随后会自动改用 CDP 滚轮，功能仍可继续，但行为不如原生滚轮自然。

**被风控或登录失效打断**

- 立即停止，刷新页面或重新登录，等一段时间再试；不要连续重试。

**想调整采集范围**

- 改 `--detail-limit` / `--list-target` / `--max-scrolls` 即可，不要改滚动和停留的随机参数。

---

## 16. 边界与合规

- 仅用于个人求职场景，遵守平台规则，控制频率。
- 只操作你自己已登录的账号，不做多账号或批量代运营。
- 沟通成功只以页面反馈（弹窗关闭 / 按钮变「继续沟通」）为准，不读取、不保存接口响应体与聊天正文。
- 任何风控信号都应当作停止信号处理。
