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
