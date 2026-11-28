import type { Memory, MemoryStatus } from "../domain/memory.js";

/** 查询记忆列表时使用的筛选条件。 */
export interface MemoryListOptions {
  /** 只返回指定生命周期状态的记忆。 */
  readonly status?: MemoryStatus;
  /** 要求记忆包含这些标签。 */
  readonly tags?: readonly string[];
}

/** 搜索本地记忆时使用的选项。 */
export interface MemorySearchOptions {
  /** 只搜索指定生命周期状态的记忆。 */
  readonly status?: MemoryStatus;
  /** 最多返回多少条匹配记忆。 */
  readonly limit?: number;
}

/**
 * 模型无关的记忆持久化端口。
 *
 * 记忆原文必须由实现持久化保存；搜索结果只能是从原始记忆派生出的结果。
 */
export interface MemoryStore {
  /** 创建新记忆，已存在相同 ID 时拒绝覆盖。 */
  create(memory: Memory): Promise<void>;

  /** 按 ID 读取记忆；不存在时返回 null。 */
  get(memoryId: string): Promise<Memory | null>;

  /** 保存记忆快照，允许新增或覆盖。 */
  save(memory: Memory): Promise<void>;

  /** 列出记忆；默认返回全部状态。 */
  list(options?: MemoryListOptions): Promise<readonly Memory[]>;

  /** 按本地确定性文本规则搜索记忆。 */
  search(
    query: string,
    options?: MemorySearchOptions,
  ): Promise<readonly Memory[]>;
}
