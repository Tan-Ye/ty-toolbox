import type { MemoryStatus } from "../domain/memory.js";
import type {
  MemoryRanker,
  MemoryRankQuery,
  RankedMemory,
} from "../ports/memory-ranker.js";
import type { MemoryStore } from "../ports/memory-store.js";
import { TopicMemoryRanker } from "./topic-memory-ranker.js";

/** 默认最多返回多少条记忆，与两个排序器的默认值保持一致。 */
const DEFAULT_LIMIT = 12;

/** 创建记忆检索服务所需的依赖。 */
export interface MemoryRetrieverOptions {
  /** 记忆持久化端口。 */
  readonly memoryStore: MemoryStore;
  /** 主排序器；通常是嵌入排序器，失败时降级到 fallbackRanker。 */
  readonly ranker: MemoryRanker;
  /** 降级排序器；未提供时使用本地主题词排序。 */
  readonly fallbackRanker?: MemoryRanker;
}

/** 单次检索的选项。 */
export interface RetrieveMemoriesOptions {
  /** 查询文本；为空时按更新时间倒序。 */
  readonly text?: string;
  /** 期望命中的标签；只影响排序，不做硬过滤。 */
  readonly tags?: readonly string[];
  /** 最多返回多少条，缺省 12。 */
  readonly limit?: number;
  /** 只检索该状态的记忆，缺省 active。 */
  readonly status?: MemoryStatus;
  /**
   * 查询文本非空但没有任何记忆得分大于 0 时，是否退回排序器给出的全部结果。
   *
   * 缺省 false：检索接口如实返回空；prompt 装配等场景需要「宁可给最近的记忆，
   * 也不要空白」时传 true。
   */
  readonly recentOnMiss?: boolean;
}

/** 一次检索的结果。 */
export interface MemoryRetrievalResult {
  /** 排序后的记忆；带分数和命中的词，便于调用方解释排序理由。 */
  readonly memories: readonly RankedMemory[];
  /** 主排序器是否失败并使用了降级排序器。 */
  readonly degraded: boolean;
  /** 降级原因；未降级时不存在。 */
  readonly degradationReason?: string;
}

/**
 * 记忆检索应用服务。
 *
 * 把「列出 active 记忆 → 排序 → 主排序器失败时降级 → 按命中过滤」这段编排
 * 从宿主运行时收口到这里，宿主只负责传入排序器和决定无命中时是否退回最近记忆。
 */
export class MemoryRetriever {
  private readonly memoryStore: MemoryStore;
  private readonly ranker: MemoryRanker;
  private readonly fallbackRanker: MemoryRanker;

  /** 创建记忆检索服务。 */
  constructor(options: MemoryRetrieverOptions) {
    this.memoryStore = options.memoryStore;
    this.ranker = options.ranker;
    this.fallbackRanker = options.fallbackRanker ?? new TopicMemoryRanker();
  }

  /** 检索记忆；主排序器失败时自动降级，降级排序器自身失败时仍会抛错。 */
  async retrieve(
    options: RetrieveMemoriesOptions = {},
  ): Promise<MemoryRetrievalResult> {
    const limit = options.limit ?? DEFAULT_LIMIT;

    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("检索 limit 必须是非负整数");
    }

    if (limit === 0) {
      return { memories: [], degraded: false };
    }

    const status = options.status ?? "active";
    const memories = await this.memoryStore.list({ status });

    if (memories.length === 0) {
      return { memories: [], degraded: false };
    }

    const query: MemoryRankQuery = {
      ...(options.text === undefined ? {} : { text: options.text }),
      ...(options.tags === undefined ? {} : { tags: options.tags }),
      limit,
    };
    let ranked: readonly RankedMemory[];
    let degraded = false;
    let degradationReason: string | undefined;

    try {
      ranked = await this.ranker.rank(memories, query);
    } catch (error) {
      degraded = true;
      degradationReason = error instanceof Error ? error.message : String(error);
      ranked = await this.fallbackRanker.rank(memories, query);
    }

    const text = (options.text ?? "").trim();
    const matched = text
      ? ranked.filter((entry) => entry.score > 0)
      : ranked;
    const chosen =
      matched.length === 0 && text && options.recentOnMiss ? ranked : matched;

    return {
      memories: chosen,
      degraded,
      ...(degradationReason === undefined ? {} : { degradationReason }),
    };
  }
}
