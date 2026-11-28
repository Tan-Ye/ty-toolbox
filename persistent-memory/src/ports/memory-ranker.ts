import type { Memory } from "../domain/memory.js";

/**
 * 记忆排序查询。
 *
 * 这里刻意不出现「向量」「embedding」之类的概念：
 * 排序算法是可替换实现细节，端口只描述「用一段文本去排序一批记忆」。
 */
export interface MemoryRankQuery {
  /** 用户当前输入或检索关键词；为空时退化为按时间倒序。 */
  readonly text?: string;
  /** 期望命中的标签；命中只影响排序，不做硬过滤。 */
  readonly tags?: readonly string[];
  /** 最多返回多少条；未提供时由实现使用默认值。 */
  readonly limit?: number;
}

/** 一条带相关度的记忆。 */
export interface RankedMemory {
  /** 原始记忆对象。 */
  readonly memory: Memory;
  /** 相关度分数，越大越相关；0 表示与查询无关。 */
  readonly score: number;
  /** 命中的词或标签，便于界面解释排序理由。 */
  readonly matched: readonly string[];
}

/**
 * 记忆相关度排序端口。
 *
 * 第一阶段只有基于主题词重叠的本地实现；后续接入嵌入模型时
 * 新增一个实现该端口的适配器即可，应用层与界面都不用改。
 */
export interface MemoryRanker {
  /**
   * 按相关度排序记忆；实现必须是确定性的。
   *
   * 返回 Promise 是因为嵌入实现对每条记忆都要调用远程服务；
   * 纯本地实现直接 `return` 即可，调用方统一 `await`。
   */
  rank(
    memories: readonly Memory[],
    query: MemoryRankQuery,
  ): Promise<readonly RankedMemory[]>;
}
