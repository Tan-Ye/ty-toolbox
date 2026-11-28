# @ty-toolbox/pet

Kotana 桌宠集成层，从 `kotana-runtime` 中抽出的独立 TypeScript 包。

它负责「让外部 dsh-pet 动起来」这一层：

- 启动、停止、认领外部 `dsh-pet.exe`（Electron 独立版），通过 CDP 在页面里说话、播动作
- 读写 dsh-pet 的 `main-config.jsonc`（显示模式、大小、角落、音量、字体等）
- 从 GitHub Releases 检查、下载、解压并切换桌宠版本
- 碎碎念调度（`PetChatterService`），台词生成由宿主注入
- 桌宠配置装载（环境变量、`companion.json`、更新指针的优先级）
- asar 解包 / CDP 调用等底层工具

**不包含**：Tauri 透明窗口与 `web/public/pet/` 里的内置桌宠页面（它们是宿主 WebView 资源），
也不包含 dsh-pet 程序本体或任何美术素材。

## 安装与构建

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build      # 产出 dist/index.js 与 dist/index.d.ts
```

要求 Node.js >= 22（用到全局 `fetch` 与 `WebSocket`）。包本身没有运行时依赖。

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

## 许可

自有代码 MIT。外部 dsh-pet 程序与上游素材的署名要求见 [NOTICE.md](NOTICE.md)。
