# 变更记录

## 0.1.0 — 2026-11-28

首个独立版本，从 `kotana-runtime` 抽出持久化记忆与检索能力。

### 新增

- 记忆领域模型：`MemoryType`、`MemoryStatus`、创建/更新/归档与时间校验。
- `MemoryService`：创建、读取、更新、归档、列表与本地确定性搜索。
- `FileMemoryStore` + `FileWriteQueue`：每条记忆一个 JSON 文件，原子写入，重启后可恢复。
- `TopicMemoryRanker`：中文二元组 + 英文词、标签加权的本地排序。
- `EmbeddingMemoryRanker` + `SiliconFlowEmbeddingProvider`：语义排序、向量缓存、分批、重试与超时。
- `MemoryRetriever`：统一「排序 → 主排序器失败降级 → 命中过滤 → 可选退回最近记忆」，并返回 `degraded` 状态。
- `loadEmbeddingConfig`：支持 `env` 注入与 `prefix`（默认 `KOTANA_`）。

### 与来源项目的差异

- `FileMemoryStore` 的 `dataDir` 改为必填，不再依赖 kotana 的运行时配置。
- `loadEmbeddingConfig` 增加 `prefix` 选项。
- 新增 `MemoryRetriever`，收口 `RuntimeService` / `RuntimeFacade` 中重复的检索编排。
- 记忆文件格式保持 `schemaVersion: 1`，兼容 kotana 已有数据。
