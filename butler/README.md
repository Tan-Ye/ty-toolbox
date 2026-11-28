# butler —— 个人时间线分析器

把 [BehaviorCollector](../behavior-collector) 采集的 `events.db` 读成「人话」：任意区间的回放、按天的日报。只读、本地、无网络请求。

它是采集层的**下游**：采集器负责写事实，butler 负责把事实解释成时间线。

## 项目边界（硬约束）

butler 只做两件事，其他一律不做：

1. **分析数据**：只读 behavior-collector 的 `events.db`，把原始事件整理成时间线、日报、区间统计等结构化结果；不采集、不判断、不推送、不提醒、不执行动作。
2. **暴露接口**：通过 `src/lib.js` / `lib.d.ts` 把分析结果交给调用方；下游怎么消费、是否推送，与 butler 无关。

实时监听、提醒、推送、记忆写入由其他工具负责，不在本项目实现。

这两条是硬约束，适用于所有 AI 写入的代码、文档和提出的方案。任何 AI 产出如果不服务于以上两点，必须立即反馈，不得直接写入、实施或当作项目能力。

## 项目冻结说明

butler 进入冻结状态：只有当 behavior-collector 新增采集工具（以及该工具产生的新事件类型）时，才更新对应的分析器（`src/kinds/`、`timeline.js`、`analyzers/`，必要时同步 `lib.d.ts` 和本文档）；除此之外不再改动本项目，不新增命令、通知、自动化或其它外围能力。

## 快速开始

```bash
cd D:\code-tasks\ty-toolbox\butler

node src/index.js kinds                       # 看数据库里有哪些事件、哪些被认识
node src/index.js range --from "22:30" --to "23:00"
node src/index.js range --from "15:00" --to "16:00" --json
node src/index.js daily --date 2026-11-26
node src/index.js daily --date 2026-11-26 --json
node src/index.js daily --date 2026-11-26 --save   # 同时存到 reports/
```

时间参数支持 `22:30`（按 `--date` 或今天补全）、`2026-11-26 22:30`、ISO 时间、`now`；跨午夜自动顺延到次日，区间终点超过当前时间会截到当下。

数据库路径按 `--db` > 环境变量 `BUTLER_DB` > 采集器 `config.json` 的 `storage.dataDir` > `../behavior-collector/data/events.db` 的顺序解析。采集器换了数据目录时 butler 会自动跟随，也可以用 `--db` 显式指定。数据库以只读方式打开，butler 永远不会写它。

### 输出与保存

- 默认在终端打印人读版。
- `--json` 输出机器可读结构。
- `--save` 把同一份结果落盘到 `reports/`：`daily-YYYY-MM-DD.txt` + `.json`，或 `range-YYYY-MM-DD-HHMMSS-HHMMSS.txt` + `.json`。txt 给人和后续的模型读，json 给下游程序读。

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
| `source` | 事件来源，可能为 null |
| `session` | 会话标识，可能为 null |
| `data` | 该 kind 自己的 JSON 负载 |

`eventsInRange` 返回精简后的对象：`{ ts, kind, app, title, url, hwnd, session, data }`；`source`、`pid`、`id` 不返回，`data` 始终是对象（解析失败时为 `{}`）。

### 已支持的事件（kind）

| kind | 写入方 | 语义 | 关键 `data` 字段 |
| --- | --- | --- | --- |
| `window.foreground` | 采集器 | 前台窗口，**变化时立即发，不变时每 60 秒一条心跳** | `class`、`rect`、`monitor`、`fullscreen` |
| `window.title` | 采集器 | 同一窗口标题变化（如浏览器切标签） | 同上 |
| `app.start` / `app.stop` | 采集器 | 应用启动/退出；`app` 为空的 start 且带 `version`、或 stop 带 `reason`，表示采集器自身生命周期 | `version`、`os`、`reason` |
| `browser.activate` / `browser.nav` | Chrome 扩展 | 标签页激活 / 导航 | `eid`、`tab_id`、`window_id` |
| `input.click` | 采集器 | 鼠标按下（只取 `action=down`） | `x`、`y`、`button`、`action` |
| `input.wheel` | 采集器 | 滚轮 | `rotation`、`direction` |
| `idle.start` / `idle.end` | 采集器 | 空闲开始/结束（默认 60 秒阈值） | `idle_ms`、`threshold_s` |

采集器当前关闭了 `process.start/stop`、`input.move`、`input.key`，所以这些 kind 不会出现在新数据里；`pause.start/end` 未注册，`kinds` 命令会标成「未注册，跳过」，分析时自动忽略。老数据里如果有未注册的 kind，也一样跳过。

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
lib.js / index.js         对外接口 / CLI
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
2. 在 `src/index.js` 加子命令，在 `src/report/text.js` 加渲染函数；需要给外部调用时，再从 `src/lib.js` 导出。

分析器不要直接查数据库、不要认识 kind 字符串——它只吃 `timeline` 的语义结构。这样新增采集通道时，只有 `kinds/` 层需要改。

## 当前局限

- **首尾空档会被算进去**：`daily` 会把 00:00 到首条事件、末条事件到 24:00 的空白算进「数据空档」，凌晨的睡眠会被写成“可能是采集器没运行”；`range` 也包含区间首尾空档。
- **无数据日报显示不自然**：没有任何事件时，`daily` 的区间会显示成 `00:00-00:00 24小时`（次日 0 点被格式化成 00:00）。
- **短会话会被低估**：一段前台时间如果完全没有事件（无窗口切换、无点击、无滚轮），超过 10 分钟的部分会记成空档。采集器已经在发 60 秒心跳，正常使用下影响很小；历史数据（2026-11-26 之前）没有心跳，长段会偏短。
- **标题里的隐私**：`title` 可能包含文档名、聊天对象名。butler 只在本地打印或写 `reports/`，不做脱敏；分享输出前先看一遍。
- **聊天内容不可见**：采集器不抓聊天正文（隐私与合规），日报只能给出聊天应用的使用时长与切换频率。
- **跨设备不可见**：只有这台机器上的行为。
- **没有自动化测试**：改完用 `node --check`、`daily`、`range` 手工验证。

## 文件说明

```
src/
  index.js            CLI 入口（kinds / range / daily）
  lib.js              函数式接口（给外部进程 import）
  lib.d.ts            接口类型声明
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
  util/
    time.js           时间解析与格式化
    text.js           应用名、域名、搜索词、分类规则
reports/              --save 生成的日报/区间报告
```
