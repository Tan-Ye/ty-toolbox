# butler —— 个人时间线分析器

把 [BehaviorCollector](../behavior-collector) 采集的 `events.db` 读成「人话」：任意区间的回放、按天的日报。只读、本地、无网络请求。

它是采集层的**下游**，和采集器分属两个项目：采集器负责写事实，butler 负责把事实解释成时间线。

## 快速开始

```bash
cd D:\code-tasks\ty-toolbox\butler

node src/index.js kinds                       # 看数据库里有哪些事件、哪些被认识
node src/index.js range --from "22:30" --to "23:00"
node src/index.js range --from "15:00" --to "16:00" --json
node src/index.js daily --date 2026-11-26
node src/index.js daily --date 2026-11-26 --json
node src/index.js daily --date 2026-11-26 --save   # 同时存到 reports/
node src/index.js memory --date 2026-11-26         # 写成一条 Kotana 长期记忆
node src/index.js memory --date 2026-11-26 --dry-run   # 只看要写什么，不落盘
```

时间参数支持 `22:30`（按 `--date` 或今天补全）、`2026-11-26 22:30`、ISO 时间、`now`；跨午夜自动顺延到次日，区间终点超过当前时间会截到当下。

数据库默认取 `../behavior-collector/data/events.db`，可用 `--db <path>` 或环境变量 `BUTLER_DB` 覆盖。数据库以只读方式打开，butler 永远不会写它。

### 输出与保存

- 默认在终端打印人读版。
- `--json` 输出机器可读结构。
- `--save` 把同一份结果落盘到 `reports/`：`daily-YYYY-MM-DD.txt` + `.json`，或 `range-YYYY-MM-DD-HHMMSS-HHMMSS.txt` + `.json`。txt 给人和后续的模型读，json 给程序和记忆层读。

## 写入 Kotana 记忆

memory 命令把一天的日报压成一条结构化摘要，写进 Kotana 的记忆目录（默认 `..\..\kotana-runtime\.kotana-dev\memories`，即 `D:\code-tasks\kotana-runtime\.kotana-dev\memories`）。它不调 Kotana 的代码，只写它读得懂的文件——一条记忆一个 JSON，原子替换。

### 为什么是「一天一条摘要」

Kotana 每轮对话会全量读取 active 记忆、按字面相关度排序、取前 5 条注入，每条正文截断 200 字。所以：

- **不能存日报全文**（txt 2 KB / json 58 KB），注入时第 200 字之后全丢。摘要控制在 200 字内，一次注入就是完整信息。
- **不能按应用/搜索拆成多条**：一天 5~8 条，一个月就 200 条，每轮全量 list 会越来越慢，而且挤占别的记忆。
- **来源索引放 `metadata`**：它不进模型上下文，是给人或未来的工具做溯源用的（指向 `reports/` 的 txt/json 和具体时间区间）。

### 记忆长什么样

```json
{
  "schemaVersion": 1,
  "type": "memory",
  "memory": {
    "id": "butler-daily-2026-11-26",
    "type": "event",
    "content": "2026-11-26 使用记录：活跃1小时40分，切换92次……",
    "status": "active",
    "tags": ["日报", "使用记录", "2026-11-26", "游戏", "开发", "系统"],
    "metadata": {
      "source": "butler",
      "kind": "daily",
      "date": "2026-11-26",
      "events": { "from": 1795622400000, "to": 1795708800000 },
      "reports": { "txt": "...\\reports\\daily-2026-11-26.txt", "json": "..." },
      "stats": { "activeMs": 5987526, "switches": 92, "clicks": 28, "..." : "..." },
      "topApps": [{ "name": "英雄联盟", "ms": 2668382 }],
      "categories": [{ "category": "游戏", "ms": 2668382 }],
      "searches": ["vmware tools", "..."],
      "generatedAt": "2026-11-27T04:22:22.540Z"
    },
    "createdAt": "2026-11-26T16:00:00.000Z",
    "updatedAt": "2026-11-26T16:00:00.000Z"
  }
}
```

- **id 固定为 `butler-daily-YYYY-MM-DD`**：同一天重复导入会覆盖同一条，天然幂等，不会写出一堆重复记忆。
- **`content` 按优先级拼接**：概览 → 前 5 个应用 → 前 3 类用途 → 搜索词 → 最长专注 → 最大空档（≥30 分）。累计超过 200 字就丢弃后面的段，保证不被截断。
- **没数据的日子也写一条**：`YYYY-MM-DD 使用记录：无前台活动记录。`——「那天没开机」本身是有用的事实。

### 用法

```bash
node src/index.js memory --date 2026-11-26 --dry-run   # 只打印 id/content/metadata
node src/index.js memory --date 2026-11-26             # 写入默认目录
node src/index.js memory --out D:\kotana\data\memories # 写到 Kotana 正式运行的数据目录
```

`reports` 字段只在对应日报文件存在时才填；先 `daily --save` 再 `memory`，溯源指针才完整。

### 已知弱点

Kotana 的检索是**纯字面匹配**（中文二元组 + 英文单词），没有向量。所以「我昨天在玩什么」这类不含正文原词的问法命中不了这条记忆；「英雄联盟」「vmware」「游戏」这类命中良好。这是 Kotana 自身的检索限制，换摘要措辞解决不了——真要提升，得改 Kotana 的 ranker（例如让 metadata 的关键字段参与匹配）。

### 每天自动导入

已注册 Windows 计划任务 **ButlerDailyImport**：每天 00:05 运行 `scripts/import-yesterday.ps1`，自动算「昨天」→ `daily --save` → `memory`，输出追加到 `logs/import.log`。

```powershell
Get-ScheduledTask -TaskName ButlerDailyImport            # 看状态与下次运行时间
Start-ScheduledTask -TaskName ButlerDailyImport          # 手动触发一次
Get-ScheduledTaskInfo -TaskName ButlerDailyImport        # 看上次结果（0 = 成功）
Unregister-ScheduledTask -TaskName ButlerDailyImport -Confirm   # 不要了
```

- 任务设了 `StartWhenAvailable`：00:05 电脑关机或睡眠时，下次登录后会补跑；补跑仍然只导「昨天」，不会漏也不会重复（幂等覆盖）。
- 任务以当前用户身份运行，只在该用户登录时执行；`logs/import.log` 是排查入口。
- 想换时间/换行为：改任务触发器，或直接改 `scripts/import-yesterday.ps1`。

## 实时观察与提醒（watch）

`watch` 是常驻进程：每 60 秒看一次「此刻在干什么」，命中规则就弹一条 Windows 通知。它和分析器共用同一套 `timeline.js`，所以「现在」与「日报」对同一批事件的理解一致。

```bash
node src/index.js watch                          # 常驻，默认参数
node src/index.js watch --verbose                # 每轮打印当前状态，方便观察
node src/index.js watch --once --verbose --dry-run   # 只跑一轮、只打印，不弹通知
node src/index.js watch --test                   # 只弹一条测试通知
```

### 三条规则（都可调）

| 规则 | 触发条件 | 默认 | 文案 |
| --- | --- | --- | --- |
| `focus` | 同一窗口（app + 标题）连续待够 | 45 分钟 | 在 Dnf 上已经连续 45 分钟了，起来动一下？ |
| `late` | 这个点之后仍然活跃 | 23:30 | 快 23:45 了，今天到这吧 |
| `fragment` | 最近 1 小时应用切换次数超标 | 30 次 | 这一小时切了 42 次，要不要收一下心？ |

- 同一规则命中后 **30 分钟冷却**，不会每分钟刷屏。
- 空闲中（`idle.start` 之后）不提醒；采集器停了（最后事件超过 90 秒）视为「无活动」，也不提醒。
- 参数：`--interval 60`（秒）、`--focus 45`（分钟）、`--switches 30`（次）、`--late 23:30`。

### 启动与自启

- **登录自启**：已写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的 `ButlerWatch`，登录后由 `scripts/watch.ps1` 在后台拉起（无窗口），输出写 `logs/watch.log`、错误写 `logs/watch.err.log`。
- **单实例**：`%TEMP%\butler-watch.lock` 记录 PID，重复启动会提示「已经在运行」并退出。异常退出留下的锁会在下次启动时自动识别（检查 PID 是否存活）。
- 想关掉自启：`reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v ButlerWatch /f`。

### 通知出口

用 PowerShell 5.1 调 WinRT Toast（系统自带，无第三方依赖），AppID 借的是 PowerShell 自己的。两个实现坑都已在 `src/notify.js` 里处理：脚本文件要 UTF-8 BOM（否则中文乱码）、标题/正文用环境变量传给 PowerShell（命令行传中文会丢）。

### 当前局限

- 规则是**启发式**的：游戏连续玩 45 分钟也会提醒，觉得吵就调大 `--focus` 或临时停掉。
- 只提醒、不响应：通知是单向的，没有「知道了」「别烦我」的回执。
- 没有模型参与判断：文案是模板，不理解上下文（比如「在等编译」和「在打游戏」都会提醒）。这正是下一步接 C 方案（DSH 当判断大脑）要补的。

## 数据契约

butler 只依赖 `events` 表这一张事实表（采集器是唯一写入方）：

| 列 | 含义 |
| --- | --- |
| `ts` | 事件发生的 Unix 毫秒时间 |
| `kind` | 事件类型，见下表 |
| `app` | 进程名（exe），可能为 null |
| `title` | 窗口标题 / 页面标题 |
| `url` | 仅浏览器事件 |
| `hwnd` / `pid` | 窗口句柄 / 进程号 |
| `data` | 该 kind 自己的 JSON 负载 |

### 已支持的事件（kind）

| kind | 写入方 | 语义 | 关键 `data` 字段 |
| --- | --- | --- | --- |
| `window.foreground` | 采集器 | 前台窗口，**变化时立即发，不变时每 60 秒一条心跳** | `class`、`rect`、`monitor`、`fullscreen` |
| `window.title` | 采集器 | 同一窗口标题变化（如浏览器切标签） | 同上 |
| `app.start` / `app.stop` | 采集器 | 进程启动/退出（`app` 为被启动的进程） | `pid`、`version`、`os` |
| `browser.activate` / `browser.nav` | Chrome 扩展 | 标签页激活 / 导航 | `eid`、`tab_id`、`window_id` |
| `input.click` | 采集器 | 鼠标按下（只取 `action=down`） | `x`、`y`、`button`、`action` |
| `input.wheel` | 采集器 | 滚轮 | `rotation`、`direction` |
| `idle.start` / `idle.end` | 采集器 | 空闲开始/结束（默认 60 秒阈值） | `idle_ms`、`threshold_s` |

采集器当前关闭了 `process.start/stop`（约 23% 的噪声）、`input.move`（约 25%）、`input.key`（要输入密度不要按键轨迹），所以这些 kind 不会出现在新数据里；老数据里如果还有，`kinds` 命令会标成「未注册，跳过」，分析时自动忽略。

### 预留但未启用的采集通道

采集侧已经给下面两类事件留好位置，butler 的 kind 注册表也接受它们（不认识就跳过，认识了就能用）：

- **UIA 事件**（`uia.focus` / `uia.invoke` / `uia.value`）：接入 FlaUI.UIA3 后，能知道你在哪个按钮/输入框上操作。分析侧可以据此判断「填表」「点菜单」这类动作。
- **录屏**（`recording.start` / `recording.stop`，`data` 里带 `path`、`width`、`height`、`fps`）：独立通道、按需录制、视频单独存储与清理。日后可以用 `analyzers/verify.js` 拿视频帧核对时间线的准确性。

## 架构

```
events.db
   │  db.js               只读打开 + 区间查询
   ▼
kinds/<kind>.js           每个 kind 一个解析器：库行 → 语义事件
   │  kinds/index.js      注册表：未知 kind 返回 null（跳过）
   ▼
timeline.js               语义事件 → 前台段 / 空闲段 / 点击 / 导航 / 空档
   ▼
analyzers/range.js        任意区间：时长、切换、搜索、空档
analyzers/daily.js        日报：用途、站点、专注、作息
   ▼
report/text.js            终端排版（中文宽度对齐）
export/kotana-memory.js   日报 → 200 字以内的 Kotana 记忆（JSON，原子写）
```

`timeline.js` 是核心，两条关键规则：

1. **段截断**：一段前台时间最多延续到「段内最后一次确认 + 10 分钟」。采集器停了、或者人离开了，这段空白就不会被算成活跃。
2. **去抖与不跨空档**：采集器在窗口切换瞬间可能同秒记下多个窗口，短于 3 秒的段吸收进前一段；但合并和吸收都不允许跨越超过 2 秒的空档，避免把「采集中断」和「真的在用」混在一起。

## 扩展方式

### 新增一种事件

1. 在 `src/kinds/<name>.js` 里导出一个 `parse<Kind>(event)`，返回统一形状的语义对象（`focus` / `browser` / `click` / `wheel` / `idle-start` / `idle-end` / `lifecycle`），不是自己需要的就返回 `null`。
2. 在 `src/kinds/index.js` 的 `KIND_INDEX` 里注册 `kind → 解析器`。
3. 如果需要它参与时间线（比如也算「确认」），在 `timeline.js` 对应分支里加一行。

**一个 kind 一个文件**，不要在一个文件里塞多种事件；`index.js` 只做注册。

### 新增一个分析器

1. 在 `src/analyzers/<name>.js` 里写 `analyze<Name>(timeline)`，输入是 `timeline.js` 的输出（`segments`、`idles`、`clicks`、`navs`、`gaps`、`lifecycles`），输出纯数据对象。
2. 在 `src/index.js` 加子命令，在 `src/report/text.js` 加渲染函数。

分析器不要直接查数据库、不要认识 kind 字符串——它只吃 `timeline` 的语义结构。这样新增采集通道（UIA、录屏）时，只有 `kinds/` 层需要改。

## 当前局限

- **短会话会被低估**：一段前台时间如果完全没有事件（无窗口切换、无点击、无滚轮），超过 10 分钟的部分会记成空档。采集器已经在发 60 秒心跳，正常使用下影响很小；历史数据（2026-11-26 之前）没有心跳，长段会偏短。
- **标题里的隐私**：`title` 可能包含文档名、聊天对象名。butler 只在本地打印，不做脱敏；如果要分享输出，先看一遍。
- **聊天内容不可见**：采集器不抓聊天正文（隐私与合规），日报只能给出聊天应用的使用时长与切换频率。
- **跨设备不可见**：只有这台机器上的行为。
- **记忆不归档**：`memory` 只写不删，一年 365 条 active 记忆。Kotana 每轮全量 list，条数多了会慢；现在先接受，等真的变慢再给旧记忆转 `archived`（代价是历史检索不到）。
- **记忆靠字面检索**：见上文「已知弱点」。`我最近在玩什么` 这类问法命中不了，不是摘要写错，是 Kotana ranker 只做词面匹配。

## 文件说明

```
src/
  index.js            CLI 入口（kinds / range / daily / memory）
  db.js               只读打开与区间查询
  timeline.js         事件流 → 时间线（段、空闲、点击、导航、空档）
  kinds/
    index.js          注册表
    window.js         window.foreground / window.title
    app-lifecycle.js  app.start / app.stop
    browser.js        browser.activate / browser.nav
    input.js          input.click / input.wheel
    idle.js           idle.start / idle.end
  analyzers/
    range.js          任意区间回放
    daily.js          按天日报
  report/
    text.js           终端输出
  export/
    kotana-memory.js  日报 → Kotana 记忆文件（含 200 字裁剪与 metadata 溯源）
  util/
    time.js           时间解析与格式化
    text.js           应用名、域名、搜索词、分类规则
```
