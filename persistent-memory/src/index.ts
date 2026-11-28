/**
 * `@ty-toolbox/persistent-memory` 的公开入口。
 *
 * 这里只导出宿主真正需要的东西：记忆领域模型、存储/排序/嵌入端口、
 * 应用服务、文件存储与 SiliconFlow 嵌入适配器，以及嵌入配置装载。
 * 内部目录结构不通过 `exports` 暴露。
 */

export {
  archiveMemory,
  createMemory,
  updateMemory,
  type CreateMemoryInput,
  type Memory,
  type MemoryStatus,
  type MemoryType,
  type UpdateMemoryInput,
} from "./domain/memory.js";

export type {
  EmbeddingProvider,
  EmbeddingRequest,
} from "./ports/embedding-provider.js";
export type {
  MemoryListOptions,
  MemorySearchOptions,
  MemoryStore,
} from "./ports/memory-store.js";
export type {
  MemoryRanker,
  MemoryRankQuery,
  RankedMemory,
} from "./ports/memory-ranker.js";

export {
  MemoryService,
  type CreateMemoryCommand,
  type MemoryServiceOptions,
  type UpdateMemoryCommand,
} from "./application/memory-service.js";
export {
  MemoryRetriever,
  type MemoryRetrievalResult,
  type MemoryRetrieverOptions,
  type RetrieveMemoriesOptions,
} from "./application/memory-retriever.js";
export { TopicMemoryRanker } from "./application/topic-memory-ranker.js";
export {
  EmbeddingMemoryRanker,
  type EmbeddingMemoryRankerOptions,
} from "./application/embedding-memory-ranker.js";

export {
  FileMemoryStore,
  type FileMemoryStoreOptions,
} from "./adapters/persistence/file-memory-store.js";
export { FileWriteQueue } from "./adapters/persistence/file-write-queue.js";
export {
  SiliconFlowEmbeddingError,
  SiliconFlowEmbeddingProvider,
  type SiliconFlowEmbeddingOptions,
} from "./adapters/embeddings/siliconflow-embedding-provider.js";
export {
  loadEmbeddingConfig,
  type EmbeddingConfig,
  type LoadEmbeddingConfigOptions,
} from "./config/embedding-config.js";
