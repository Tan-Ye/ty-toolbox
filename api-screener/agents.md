# AGENTS.md

本文件记录 BOSS 直聘采集/沟通脚本的长期约定、防风控细节和改动注意事项。后续修改代码前先读这里，避免把已经验证有效的随机化、分心行为和浏览器操作方式改掉。

## 目标与边界

- 用途：个人求职时筛选岗位、查看详情、按优先级发送沟通消息。
- 不做：绕过验证码、破解登录、多账号、大规模并发、超出 BOSS 每日上限的发送。
- 默认只采集；发送必须满足优先级、活跃度、时间、窗口和每日额度约束。

## 运行方式

```powershell
python start_chrome.py                 # 启动/复用 Chrome，然后采集 + 穿插发送
python start_chrome.py --stage collect # 只采集，不发送
python start_chrome.py --no-run        # 只启动 Chrome
python run_job_queue.py --stage all --dry-run   # 干跑：只记录发送决策
```

- 登录只能手动完成。未登录时终端会提示登录，输入 `Y` 重新预检。
- 期望岗位由用户在终端选择并再次确认后才开始采集。
- 调试 Chrome 必须保持运行；窗口不要最小化，否则 CDP 输入会被系统限速。

## 代码结构

```
run_job_queue.py   薄入口：单实例锁、调用 workflow.cli.main、异常与退出码
start_chrome.py    启动/复用 Chrome（独立脚本）
collect_apis.py    独立工具：从 Reqable 采集接口（非日常流程）
core/              config 配置 / errors 异常 / utils 工具 / lock 单实例锁 / console 终端输出
browser/           cdp_client CDP / page_collect 页面采集 / os_input 系统输入 / auth 登录检查
workflow/          queue_runner 队列 / expectations 期望 / collecting 采集 / sending 发送
                   startup 启动面板 / cli 参数与主流程编排
storage/job_store  SQLite 入库、优先级、发送记录与导出
```

- 依赖方向：`core` 不依赖其它包；`browser`、`storage` 只依赖 `core`；`workflow` 依赖前三者；入口脚本只调用 `workflow` 和 `core.lock`。
- 包内一律使用绝对导入（如 `from core.config import ...`）；入口脚本会把项目根目录加入 `sys.path`。
- 随机滚动、鼠标轨迹、点击位置、停留和分心行为集中在 `browser/page_collect.py`、`browser/os_input.py`；改动其他模块时不要碰这些行为。
- 新逻辑按职责放入对应包，`run_job_queue.py` 只保留入口、单实例锁和顶层异常处理。

## 防风控铁律

1. **不使用 Playwright 启动或控制浏览器。**
   - Playwright 的 `page.evaluate` 会启用 CDP `Runtime` 域，BOSS 反调试会在十几秒内反复整页重载。
   - 只使用 `connect_over_cdp` 也不够；本项目已移除 Playwright，改为原生 CDP。

2. **原生 CDP 只发必要命令，绝不 `Runtime.enable`。**
   - 数据读取用 `Runtime.evaluate`（`returnByValue: true, awaitPromise: true`）。
   - 抓包用 `Network.enable` + `Network.responseReceived` + `Network.getResponseBody`。
   - 已验证：只发 `Runtime.evaluate` + `Network.enable` 时页面可稳定存活数百秒。

3. **列表和详情不直接请求接口。**
   - 页面模式：脚本只滚动和点击，抓浏览器自己发出的 `recommend/list.json` 与 `job/detail.json` 响应。
   - API 直连模式仅作备用，容易触发风控。

4. **保留所有随机化和分心行为，重构时不得删掉。**
   - 滚动距离：每次从 180~420 / 420~850 / 850~1300 三档随机，拆成 1~3 段，段间停顿随机，约 12% 先回滚一点。
   - 鼠标：14~30 步弧线轨迹，步长/速度/停顿随机；点击前有随机停顿。
   - 点击位置：在卡片与视口的交集内随机采样，并做 ±3px 抖动；只点当前可视区域。
   - 停留：详情 3~6 秒随机，约 10% 概率延长到 6~14 秒。
   - 分心：列表阶段每次滚动约 5%、详情阶段每个岗位约 7% 触发切换标签页/应用/导航页，再切回来。
   - 这些行为是防风控的重要一环，不是为了好看。

5. **发送节奏。**
   - 任意 2 小时内最多 30 条，每天最多 150 条（BOSS 每日硬上限）。
   - 每条间隔 30~60 秒，随机；风控/登录失效/沟通上限立即停止整个脚本。
   - 只给 boss 今日活跃或 3 日内活跃的岗位发。
   - 非工作日/非工作时间不发送；当天特批用 `--ignore-work-hours`。

6. **不记录发送接口的响应体。**
   - 只记录岗位 id、是否成功、错误原因。
   - 已发送的判定标准是接口真实发出并正常返回，不区分手动还是脚本触发。

## 浏览器操作细节

- CDP 鼠标坐标是 CSS 视口坐标；OS `SetCursorPos`/`ClientToScreen` 需要进程 DPI 感知（已设置 `SetProcessDpiAwareness(2)`）。
- OS 滚轮有效；OS `SendInput` 左键点击不被页面接收，所以点击使用 CDP `Input.dispatchMouseEvent`。
- 点击序列：`mouseMoved`（button:none/buttons:0）→ `mousePressed`（buttons:1）→ `mouseReleased`（buttons:0）。
- 期望标签对悬停敏感，不能用坐标点击；用 DOM `a.click()`。
- 切换期望后必须校验列表城市；丢弃切换途中抓到的其它城市 payload。
- 详情数据在 `zpData` 下（`securityId/lid/sessionId/jobInfo/bossInfo`），不是顶层。
- 列表卡片：`li.job-card-box`，岗位链接 `a.job-name[href="/job_detail/<encryptJobId>.html"]`。
- 页面被最小化/遮挡时 CDP 输入会超时；先还原窗口并用 `AttachThreadInput` 强制前台。

## 数据与存储

- SQLite：`data/zhipin/zhipin.db`，`jobs` 表以 `encrypt_job_id` 为主键。
- 导出：`data/zhipin/jobs.json`（默认前 150 条，按优先级排序）。
- 发送日志：`data/zhipin/send_log.jsonl`，一行一次调用，不保存响应体。
- 发送记录：`jobs.send_status/sent_at/send_error`；2 小时窗口直接按 `sent_at` 统计。
- 数据库连接在异常退出时会提交已完成的写入，避免“已经发出去但没记录”。
- 用 `data/run.lock` 做单实例锁，禁止两个脚本同时操作页面和数据库；进程退出后锁自动释放。

## 发送模型

- `--stage all`：采集详情入库后立即评估，满足条件进入待发队列；到 30~60 秒间隔再发，不打断浏览。
- 资格：优先级 >= `--inline-min-priority`（默认 6）、boss 近期活跃、未发送、详情有效。
- 前 `--inline-warmup` 个详情只浏览不发送（默认 3），之后才开始考虑。
- 达标岗位按 `--inline-skip-rate` 随机跳过（默认 10%），避免“看到就发”。
- 发送使用页面内 `friend/add`，不点“立即沟通”按钮，避免弹窗和页面状态变化。
- 单个岗位普通错误：记录失败，继续浏览/发送；风控、登录失效、沟通上限：立即抛错终止整轮。
- `--stage all` 开启穿插发送后，本轮不再追加批量发送，剩余岗位留给 `--stage send`。
- 独立 `--stage send` 使用同一个 2 小时滚动窗口和每日额度。

## 启动面板

启动时先显示今日概况（不依赖浏览器）：

```text
[今日概况]
  采集：列表 X 条，详情成功 Y 条
  发送：S/150，失败 F
  2 小时窗口：W/30，还可发送 N 条（或下一个额度约 ... 后释放）
```

- 窗口已满时由用户选择：
  1. 只采集，不发送（默认）
  2. 继续发送（忽略窗口，风险自负）
  3. 退出
- `--stage send` 只有“退出等待 / 继续发送”两个选项。
- 继续发送只忽略 2 小时窗口，不突破每日 150 条硬上限。
- `--force-window` 可显式跳过窗口提示（风险自负）；`--dry-run` 不触发窗口限制。

## 干跑

```powershell
python run_job_queue.py --stage all --dry-run
```

- 正常采集、正常计算优先级、正常打印“本应发送谁”。
- 不调用 `friend/add`，不写入发送记录，不消耗窗口/每日额度（从 0 开始模拟）。
- 想加快节奏可加 `--send-min-delay 1 --send-max-delay 2`。
- 干跑通过后再小流量真发 1~2 条，确认接口与记录正常。

## 退出码

- 0 完成
- 1 未预期错误
- 2 异常终止（风控、详情不一致、内联发送终止等）
- 3 手动停止/用户退出
- 4 2 小时发送窗口已满
- 5 当日额度用完
- 6 非工作日/非工作时间
- 7 未登录

## 改动检查清单

- 是否仍然没有启用 CDP `Runtime` 域？
- 是否仍然没有用 Playwright 启动/控制浏览器？
- 滚动、鼠标、点击位置、停留、分心行为是否保留？
- 期望是否仍用 DOM 点击并校验城市？
- 是否只点击当前可视区域，没有 `scrollIntoView` 强制滚动？
- 发送是否仍遵守 30~60 秒间隔、2 小时 30 条、每天 150 条？
- 风控/登录失效/沟通上限是否立即终止整轮？
- 是否没有新增发送响应体记录？
- 数据库异常退出时，已发生的详情/发送记录是否仍能提交？
- 新增逻辑是否放进对应包（`core` / `browser` / `workflow` / `storage`），`run_job_queue.py` 是否仍保持薄入口？
