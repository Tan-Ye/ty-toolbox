# 内置桌宠页面素材说明

本目录复制自 kotana-runtime 的 `web/public/pet/`（源仓库提交 `53001ac`，2026-11-28），包含内置桌宠页面与 8 个 webm 动画。

**本目录不进入 npm 包**：`package.json` 的 `files` 只列 `dist`、`README.md`、`LICENSE`、`NOTICE.md`，`web/` 仅随 git 仓库分发。

## 动画素材

`assets/*.webm`：

| 文件 | 用途 |
| --- | --- |
| idle.webm | 空闲 |
| look.webm | 张望 |
| walk.webm | 走动 |
| drag.webm | 拖拽 |
| click-happy.webm | 点击回应（开心） |
| click-shy.webm | 点击回应（害羞） |
| click-wave.webm | 点击回应（挥手） |
| sleep.webm | 睡觉 |

- 形象：社区二创的 DeepSeek「大肥鱼」（鲸鱼娘），非 DeepSeek 官方形象
- 原型「溟月」：B 站 @上善无形
- DeepSeek 版设计：B 站 @ZipZipPipe
- 授权：**CC BY-NC-SA 4.0**（署名 · 非商业性使用 · 相同方式共享）
- 约束：
  - 不得用于商业用途；
  - 再分发需保留署名、注明 CC BY-NC-SA 4.0，并以相同方式共享；
  - 不得声称是 DeepSeek 官方产品。
- 上游参考：`YunYueSama/codex-deepseek-pet` 的 `assets/whale/portrait.png`

本目录动画使用同一「大肥鱼」形象；如与 kotana-runtime 根目录 `NOTICE.md` 冲突，以该文件为准。
