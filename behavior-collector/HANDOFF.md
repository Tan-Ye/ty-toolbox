# BehaviorCollector 会话交接文档

> **给下一个会话**：这份文件 + [PLAN.md](./PLAN.md) 就是完整上下文。
> 交接时间：2026-11-26。状态：**M0–M2 + M4 已实现并完成端到端验证；M3（UIA）按决策后置；M5 只做了必需项。**

---

## 0. 一句话任务

Windows 托盘常驻程序，采集「人在电脑上做了什么」——应用启停、前台窗口、键鼠输入、空闲、Chrome 标签页/URL——结构化写入本机 SQLite。**只做采集，不做分析、不上传。**

项目名 **BehaviorCollector**，目录 `behavior-collector`。

---

## 1. 已拍板的决策（2026-11-26）

| # | 决策 | 结论 |
| --- | --- | --- |
| 1 | 命名 | BehaviorCollector（体现行为采集） |
| 2 | 目标框架 | `net10.0-windows` |
| 3 | 明文按键 | 只放 config + 托盘二次确认，不给托盘常规入口 |
| 4 | 保留期 | 90 天 / 2GB；数据放项目内 `behavior-collector/data/`，已 gitignore |
| 5 | Chrome 扩展 | 开发者模式加载；manifest 内置固定 `key`，扩展 ID 稳定 |
| 6 | 开机自启 | 首次运行询问，同意后写 `HKCU\...\CurrentVersion\Run` |
| 7 | export CLI | 带 |
| 8 | 范围 | M0–M2 + M4 + M5 必需项；UIA（M3）后置 |

---

## 2. 已实现内容

### 采集器（`src/BehaviorCollector.Collectors`）

- **WindowCollector**：`SetWinEventHook`（独立消息循环线程）+ 1s 轮询兜底；`window.foreground` / `window.title`，负载含 class、rect、monitor、primary、fullscreen。
- **ProcessCollector**：Toolhelp32 每 2s 快照 diff；首次只建基线；`process.start` / `process.stop`，含 parent_pid 与 exe path。
- **IdleDetector**：`GetLastInputInfo` 每 5s；`idle.start` / `idle.end`，阈值 `input.idleThresholdSeconds`（默认 60）。
- **InputCollector**：SharpHook `EventLoopGlobalHook`。
  - 按键：HMAC-SHA256(salt, vk|mods) 前 16 hex；明文只在 `privacy.plaintextKeys=true` 且托盘确认后写 `key_plain`。
  - 鼠标：点击 down/up、滚轮全记；移动 ≤20Hz 降采样；坐标 + 光标下窗口。
  - 暂停 / idle / 排除应用时不采集。
- **BrowserPipeServer**：命名管道 `behaviorcollector-browser`，接收 Native Host 转发。
- **BrowserHostRunner**：Chrome 启动时第一个参数为 `chrome-extension://...`，进入宿主模式；转发到管道，主程序不在线时落盘 `data/browser-spool.jsonl`；stdout 保持纯二进制协议。

### 存储与隐私（`src/BehaviorCollector.Core`）

- SQLite WAL、单写者 `BatchWriter`（500 条 / 1s 事务）、`user_version` 迁移。
- 表：`events`、`meta`、`collector_state`；索引 ts / (kind,ts) / (app,ts)。
- 盐：DB `meta.install_salt` 随机 32 字节。
- 排除名单 glob → Regex；配置热重载后重建。
- 保留期清理与 2GB 上限（优先删最旧 `input.move`）在 BatchWriter 内每 6h 跑一次。
- `export` JSONL、`--status` 快照、浏览器缓冲导入。

### 宿主（`src/BehaviorCollector.App`）

- WinExe + WinForms 托盘：状态、暂停/继续、打开数据目录、退出；全局热键 `Ctrl+Alt+P`。
- 单实例 Mutex + `--quit` 退出信号。
- config.json 自动生成 + 300ms 防抖热重载。
- 首次运行询问开机自启；明文按键启动时二次确认。
- 每次启动幂等写 Native Messaging manifest 并注册 HKCU。
- CLI：`--status`、`export`、`--quit`、`--help`；`--browser-host` 也支持（Chrome 实际用 origin 参数触发）。
- 退出时写 `app.stop` 并保证刷盘。

### Chrome 扩展（`extension/chrome`）

- MV3，权限 `tabs / webNavigation / storage / nativeMessaging`。
- 事件先入 `chrome.storage.session` 队列，`postMessage` 成功后出队；断线重连补发。
- 固定扩展 ID：`lnfkkjhbfaacbbpkeiepmkphniphdjie`（`Core/Browser/BrowserConstants.cs` 与 `manifest.json` 的 `key` 必须同步）。

---

## 3. 运行方式

```powershell
cd d:\code-tasks\ty-toolbox\behavior-collector

dotnet build BehaviorCollector.slnx

# 启动托盘（首次会问是否开机自启）
src\BehaviorCollector.App\bin\Debug\net10.0-windows\BehaviorCollector.exe

# 统计
...\BehaviorCollector.exe --status

# 导出（--to 含当天）
...\BehaviorCollector.exe export --from 2026-11-26 --to 2026-11-26 --out data\export.jsonl

# 退出正在运行的托盘实例
...\BehaviorCollector.exe --quit
```

- 数据目录：`behavior-collector/data/`（`events.db`、`logs/`、`native-host/`、`browser-spool.jsonl`），已在 `.gitignore`。
- 配置：`behavior-collector/config.json`（首次运行生成，已 gitignore）。
- 扩展加载：`chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/chrome`。加载后 ID 应显示为 `lnfkkjhbfaacbbpkeiepmkphniphdjie`。

---

## 4. 测试与验证现状

- 单元/集成测试 21 个：
  - KeyHasher 3、ExclusionMatcher 3、NativeMessagingProtocol 4、BrowserEventMapper 3、Storage 4、BrowserPipeServer 1、BrowserSpoolImporter 1、进程枚举 1、ProcessCollector 启停 1。
- 已验证的端到端行为：
  - 启动 → `app.start`、窗口事件落库；
  - Native Host → 管道 → `browser.nav` 落库；
  - 主程序关闭时宿主写 spool，重启后导入并删除 spool（日志：`浏览器缓冲导入完成`）；
  - `export` 输出合法 JSONL（含 `app.stop`）；
  - `input.move` / `input.click` 事件已实际采到；
  - `--quit` 优雅退出、无残留实例（正常用户会话下）。
- 环境限制：本仓库的 agent 沙箱里 `dotnet test` 的 VSTest testhost 会因进程访问被拒而失败；可用以下方式跑测试：

```powershell
$env:DOTNET_ROLL_FORWARD='LatestMajor'
dotnet "$env:TEMP\xunitconsole\pkg\tools\net6.0\xunit.console.dll" `
  "tests\BehaviorCollector.Tests\bin\Debug\net10.0-windows\BehaviorCollector.Tests.dll" -nocolor
```

（xunit.console 需从 NuGet 下载 `xunit.runner.console 2.9.3` 解压。）

- 沙箱里 HKCU 注册表和 `%TEMP%` 写入被拒，所以「开机自启注册 / Native Host 注册 / 导出到 TEMP」在 agent 会话里会失败；正常用户桌面运行不受影响。manifest 文件本身会正常生成。

---

## 5. 已知取舍 / 后续

- **UIA（M3）未实现**：PLAN §5.4 的规格保留；接管需要 FlaUI + 节流 + 密码框跳过。
- 显示器只存 monitor handle + primary，未做显示器序号映射。
- 扩展队列用 `storage.session`，Chrome 完全退出后队列会清空；宿主 spool 兜底主程序离线场景。
- 宿主转发是「写管道成功即认为送达」，极端情况下主程序崩溃可能丢最后几条；没有做 eid 去重表。
- 未做安装包 / 单文件发布；当前 Native Host manifest 指向 bin 下的 exe，`dotnet build` 后路径不变。
- 托盘只有基础菜单；没有状态窗口、没有按应用的实时预览。

下一步优先级：UIA > 发布方式（publish 到固定目录）> 扩展/popup 状态 > 更细的进程/浏览器关联。

---

## 6. 工程约定（不变）

- 文档中文，标识符英文；代码注释可中文。
- 隐私红线不放宽：明文默认关、排除名单、暂停热键、密码框（UIA 接入时）整棵子树跳过。
- 不扩大范围：分析、报表、云同步、AI 调用都不属于本项目。
- 不要动 `api-screener/` 等无关目录的未提交改动。
