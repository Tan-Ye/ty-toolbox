# 来源与许可

本包是 `kotana-runtime` 中持久化记忆与检索能力的独立抽取版。

## 1. 本包自身

- 自有代码采用 **MIT**，全文见 [LICENSE](LICENSE)；版权声明沿用来源项目。
- 抽取的源文件（来源项目路径 → 本包路径）：

| 来源（kotana-runtime） | 本包 |
| --- | --- |
| `src/domain/memory.ts` | `src/domain/memory.ts` |
| `src/domain/identity.ts` | `src/domain/identity.ts` |
| `src/domain/time.ts` | `src/domain/time.ts` |
| `src/ports/memory-store.ts` | `src/ports/memory-store.ts` |
| `src/ports/memory-ranker.ts` | `src/ports/memory-ranker.ts` |
| `src/ports/embedding-provider.ts` | `src/ports/embedding-provider.ts` |
| `src/application/memory-service.ts` | `src/application/memory-service.ts` |
| `src/application/topic-memory-ranker.ts` | `src/application/topic-memory-ranker.ts` |
| `src/application/embedding-memory-ranker.ts` | `src/application/embedding-memory-ranker.ts` |
| `src/adapters/persistence/file-memory-store.ts` | `src/adapters/persistence/file-memory-store.ts` |
| `src/adapters/persistence/file-write-queue.ts` | `src/adapters/persistence/file-write-queue.ts` |
| `src/adapters/embeddings/siliconflow-embedding-provider.ts` | `src/adapters/embeddings/siliconflow-embedding-provider.ts` |
| `src/runtime/embedding-config.ts` | `src/config/embedding-config.ts` |

- 新增 `src/index.ts` 作为公开入口，新增 `src/application/memory-retriever.ts` 作为检索编排。
- 相对来源项目的改动：
  - `FileMemoryStore` 的 `dataDir` 改为必填，不再读取 `kotana-runtime` 的运行时配置；
  - `loadEmbeddingConfig` 增加环境变量 `prefix` 选项，默认仍为 `KOTANA_`；
  - 新增 `MemoryRetriever`，把来源项目 `RuntimeService` / `RuntimeFacade` 中重复的检索编排收口到本包；
  - 为 `SiliconFlowEmbeddingProvider`、嵌入配置与检索服务补充自动化测试。

## 2. 第三方依赖与素材

- 运行时依赖：无。
- 开发依赖：`@types/node`、`typescript`、`vitest`，均按其各自许可使用。
- 不包含任何模型、向量数据库、API Key、会话记录或第三方素材。

## 3. 网络调用

启用嵌入检索后，`SiliconFlowEmbeddingProvider` 会把记忆正文（每条最多 1000 字符）发送到配置的
SiliconFlow `/embeddings` 接口；不启用时全部检索都在本地完成。
