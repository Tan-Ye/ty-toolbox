# @ty-toolbox/pet

自渲染的 Windows 桌面桌宠，同时保留原 TypeScript 控制层。

仓库里有两块：

- **桌面应用**：`src-tauri/` + `web/`，Tauri 2 透明置顶窗口，包含设置面板、托盘、本地 HTTP 与 `pet` CLI。
- **控制库**：`src/`（构建到 `dist/` 后发布到 npm），负责启动/停止外部 dsh-pet、读写其配置、更新、碎碎念与 asar/CDP 工具。

桌面应用不依赖 dsh-pet；两者可以各自运行，也可以由宿主通过 HTTP/CLI 控制本应用。


## 安装与构建

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build          # 库 + CLI → dist/
pnpm app:dev        # Tauri 开发模式启动桌面桌宠
pnpm app:build      # 打 Windows NSIS 安装包
```

要求 Node.js >= 22（库用到全局 `fetch` 与 `WebSocket`）。桌面应用另外需要
Rust 工具链、WebView2 运行时与 Windows SDK；Tauri CLI 由 devDependency
`@tauri-apps/cli` 提供，不需要全局安装。

## 桌面应用（Windows）

- 窗口：320×440、透明、无边框、始终置顶、不进入任务栏；关闭窗口只隐藏，退出走托盘或 `quit`。
- 托盘：显示桌宠 / 隐藏桌宠 / 桌宠设置 / 退出。
- 设置：右键桌宠 → 设置。可调人物大小（80–140%）、停靠角落、是否置顶、气泡字号、
  空闲动作与间隔、点击回应、拖拽动画、气泡时长与碎碎念。
- 配置：`%APPDATA%\com.ty-toolbox.pet\prefs.json`（Tauri `app_data_dir`）；文件损坏时
  自动备份为 `prefs.json.broken-<时间戳>` 并回退默认值。
- 便携/测试：`PET_DATA_DIR` 可覆盖配置目录，`PET_WEBVIEW_DATA_DIR` 可覆盖 WebView2
  缓存目录；`PET_HTTP_PORT` 可改控制接口端口。
- 单实例：重复启动只显示已有窗口。
- 暂未包含：开机自启、自动更新、多宠物实例。

`pnpm app:build` 的安装包在 `src-tauri/target/release/bundle/nsis/`；
只想快速验证二进制时可以跑 `pnpm app:build:dir`（不打包）。

## 命令行与 HTTP

先 `pnpm build`，然后：

```bash
node dist/cli/pet.js status
node dist/cli/pet.js say "我在这儿。"
node dist/cli/pet.js work working "整理今天的记录"
node dist/cli/pet.js clear
node dist/cli/pet.js play idle
node dist/cli/pet.js show
node dist/cli/pet.js prefs
node dist/cli/pet.js prefs set '{"appearance":{"scale":120}}'
```

`npm link` 或把 `dist/cli/pet.js` 放进 PATH 后，可以直接用 `pet ...`。
CLI 默认连 `http://127.0.0.1:7340`，可用 `PET_HTTP_URL` 改完整地址，或
`PET_HTTP_PORT` 只改端口。

桌面应用启动后会监听 `127.0.0.1:7340`（`PET_HTTP_PORT` 可覆盖）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 存活检查 |
| GET | `/status` | 运行状态与窗口可见性 |
| GET | `/prefs` | 当前偏好 |
| PUT/POST | `/prefs` | 深合并偏好并即时生效 |
| POST | `/say` | `{ "text": "...", "durationMs": 5000 }` |
| POST | `/work` | `{ "state": "working", "task": "..." }`，state 为 thinking/working/result/waiting/success/error |
| POST | `/work/clear` | 清除工作状态 |
| POST | `/play` | `{ "animation": "idle" }`，可选 idle/look/drag/click-happy/click-shy/click-wave/sleep/walk |
| POST | `/show`、`/hide` | 显示/隐藏桌宠 |
| POST | `/settings` | 打开设置窗口 |
| POST | `/quit` | 退出应用 |

HTTP 只绑定回环地址、没有鉴权，不要转发到公网或局域网。

## 用法

```ts
import {
  DshPetCompanion,
  DshPetSettingsStore,
  DshPetUpdater,
  PetCompanionService,
  PetChatterService,
  bundledPetVersion,
  loadPetCompanionConfig,
  petStoragePaths,
} from "@ty-toolbox/pet";

const dataDir = "D:/kotana/data";
const config = loadPetCompanionConfig({ dataDir });

const companion = new DshPetCompanion({
  dataDir,
  port: config.port,
  petId: config.petId,
  ...(config.exePath === undefined ? {} : { exePath: config.exePath }),
});

const updater = new DshPetUpdater({ dataDir });
const service = new PetCompanionService({ companion, updater });

await service.start();
await service.say("我在这儿。", { durationMs: 5_000 });
await service.work("working", "整理今天的记录");
await service.clearWork();

const settings = new DshPetSettingsStore({ dataDir });
const current = settings.load();
await settings.save({ ...current, global: { ...current.global, clickSoundEnabled: false } });
```

碎碎念需要宿主提供「怎么说话」和「是否该说话」两个回调；模型生成台词时由宿主注入
`generate`，包本身不依赖任何 Provider：

```ts
const chatter = new PetChatterService({
  say: (text) => service.say(text),
  isRunning: async () => (await service.status()).running,
  minDelayMs: 3 * 60_000,
  maxDelayMs: 8 * 60_000,
});
chatter.start();
```

## 公开 API

| 分类 | 导出 |
| --- | --- |
| 控制 | `DshPetCompanion`、`PetCompanionError`、`PetCompanionService` |
| 设置 | `DshPetSettingsStore`、`PetSettingsError` |
| 更新 | `DshPetUpdater`、`PetUpdateError`、`compareVersions` |
| 碎碎念 | `PetChatterService`、`PET_CHATTER_LINES` |
| 配置/路径 | `loadPetCompanionConfig`、`readInstalledPetExe`、`bundledPetVersion`、`petStoragePaths` |
| 工具 | `readAsarEntry`、`extractAsar`、`stripJsonComments`、`findPetPage`、`evaluatePetPage`、`sanitizeElectronEnvironment`、`splitArgs`、`isSandboxCrash`、`removeStaleSingleton` |
| 类型 | 三个端口接口及全部选项类型 |

## 数据目录

所有运行数据都落在调用方传入的 `<dataDir>/pet/` 下，与源码分离：

```
<dataDir>/pet/
  companion.json   # { enabled?, exePath?, port?, petId? }
  current.json     # 更新指针 { version, exePath, installedAt }
  owned.json       # 本进程拉起的桌宠 pid（重启后认领）
  home/            # dsh-pet 的 DSH_HOME：配置、日志、运行时状态
  appdata/         # Chromium profile
  logs/spawn.log   # 子进程 stdout/stderr
  downloads/       # 下载的 zip
  versions/<tag>/  # 解压后的各版本
```

内置桌宠页面自己的 `prefs.json` 不属于本包。

## 环境变量

`loadPetCompanionConfig` 读取以下变量（都可用 `env` 参数注入）：

| 变量 | 作用 |
| --- | --- |
| `KOTANA_PET_EXE` | 外部桌宠 exe 绝对路径，优先级最高 |
| `KOTANA_PET_BUNDLED_EXE` | 随安装包分发的 exe 路径（Rust 侧注入） |
| `KOTANA_PET_ENABLED` | 设为 `0` / `off` / `false` 时禁用 |
| `KOTANA_PET_PORT` | 期望端口，默认 3080 |
| `KOTANA_PET_ID` | 实例 id，默认 `main` |

未传 `dataDir` 时，`DshPetCompanion` 会回落到 `$DSH_HOME`，再缺省 `%USERPROFILE%\.dsh`。

## 在 kotana 中引入

已发布到 npm，按版本依赖即可：

```jsonc
// kotana-runtime/package.json
"dependencies": {
  "@ty-toolbox/pet": "^0.1.0"
}
```

需要和本地 pet 源码联调时，可临时改成 `link:../ty-toolbox/pet`；改完 pet
重新 `pnpm build` 即生效，不需要在 kotana 重装。想固定一份快照时用 `file:`，
pnpm 会把目录复制进虚拟 store，重新构建后需要再跑一次 `pnpm install`。
用 link/file 时都要先在 pet 目录执行 `pnpm build`（或在 kotana 的
`prebuild` / `pretest` 里加 `pnpm --dir ../ty-toolbox/pet build`）。

## 内置桌宠页面与素材（仅仓库，不进 npm）

`web/` 是桌面应用的 Tauri 前端：`index.html` / `pet.js` / `pet.css` 与 `settings.*`，以及 8 个 webm 动画。它会随安装包一起打包，但**不会**发布到 npm：`package.json` 的 `files` 只包含 `dist` 与文档。

素材授权见 [web/NOTICE.md](web/NOTICE.md)：大肥鱼形象为 CC BY-NC-SA 4.0，仅限非商业使用。

## 许可

自有代码 MIT。外部 dsh-pet 程序与上游素材的署名要求见 [NOTICE.md](NOTICE.md)。
