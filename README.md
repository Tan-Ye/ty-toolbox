# ty-toolbox

个人“工作坊”，半成品、工具、小实验，不知道归类的都往这里扔。

## 项目

### [api-screener](./api-screener)

BOSS 直聘自动采集与打招呼工具。复用已登录的真实 Chrome 页面完成「采集岗位 → 去重入库 → 按优先级打招呼」，不直接拼接口请求，降低额外风控特征。技术栈：Python + SQLite + Chrome DevTools Protocol。

详见 [api-screener/README.md](./api-screener/README.md)。

### [DuckovMods](./DuckovMods)

《逃离鸭科夫》模组集合。当前包含 [GuozuYa](./DuckovMods/GuozuYa)：在角色天赋选择界面新增「祖国鸭」天赋，属性为拥有其他所有天赋的正面加成、且不带任何负面效果。技术栈：C# / .NET Standard 2.1，运行时反射注入游戏 Endowment 系统。

- 源码：[ModBehaviour.cs](./DuckovMods/GuozuYa/ModBehaviour.cs)
- 模组信息：[info.ini](./DuckovMods/GuozuYa/info.ini)
- 图标：[preview.png](./DuckovMods/GuozuYa/preview.png)

### [behavior-collector](./behavior-collector)

Windows 电脑操作痕迹采集层（M0–M2 + M4 已实现，M3/UIA 后置）。常驻托盘采集应用启停、前台窗口、键鼠输入、Chrome 标签页与 URL、空闲区间，结构化写入本地 SQLite；只做采集，不做分析。技术栈：C# / .NET 10 + CsWin32 + SharpHook + SQLite。

- 方案与里程碑：[behavior-collector/PLAN.md](./behavior-collector/PLAN.md)
- 会话交接：[behavior-collector/HANDOFF.md](./behavior-collector/HANDOFF.md)
- 控制接口（给上层程序调用，不必开托盘菜单）：`--status` 输出 JSON（`running` / `paused` / `dataDir` / `todayTotal` / `totalEvents`），`--pause` / `--resume` 通过命名事件信号（`Local\BehaviorCollector.Pause|Resume`）通知正在运行的实例，`--quit` 退出。kotana 的 `CollectorProcess` 适配器就是 spawn 这个 exe 再发信号。
- 数据目录：当前写 `data-v2/events.db`（由 `config.json` 的 `storage.dataDir` 决定）；旧的 `data/events.db` 是 11-27 之前的历史库，默认不再写入。

### [butler](./butler)

行为数据的时间线分析器：只读 behavior-collector 的 `events.db`，把事件整理成任意区间的回放和按天的日报（应用时长、用途分布、站点分布、搜索记录、专注碎片、采集空档），并把日报压成一条 ≤200 字的摘要写进 Kotana 的长期记忆（`memory` 命令，元数据里留溯源指针）。只读、本地、无网络请求。技术栈：Node.js 24 + `node:sqlite`。

- 用法与扩展方式：[butler/README.md](./butler/README.md)
- 函数入口：`butler/src/lib.js` 直接导出 `openDb` / `eventsInRange` / `buildTimeline` / `analyzeDaily` / `analyzeRange` / `formatDaily` / `renderDailyContent` 等，供上层程序 `import`（kotana 的 `ButlerInsight` 适配器走这条路，不经过 CLI）；CLI 只是这层的薄壳。
