import type { Memory } from "../domain/memory.js";
import type { EmbeddingProvider } from "../ports/embedding-provider.js";
import type {
  MemoryRanker,
  MemoryRankQuery,
  RankedMemory,
} from "../ports/memory-ranker.js";

/** 创建嵌入排序器所需的选项。 */
export interface EmbeddingMemoryRankerOptions {
  /** 文本嵌入实现；切换供应商时只替换这一项。 */
  readonly embedding: EmbeddingProvider;
  /** 默认最多返回多少条记忆。 */
  readonly limit?: number;
  /**
   * 低于该余弦相似度的记忆按无关处理（记 0 分）。
   *
   * bge 系列模型对完全无关的中文句子通常也给出 0.2~0.35 的相似度，
   * 所以不能直接用「大于 0」当命中条件，需要一个下限。
   */
  readonly minScore?: number;
  /** 进程内向量缓存最多保留多少条记忆的向量。 */
  readonly cacheLimit?: number;
}

/** 默认最多返回多少条记忆。 */
const DEFAULT_LIMIT = 12;

/** 默认相关度下限；对 bge-m3 是一个保守的起点。 */
const DEFAULT_MIN_SCORE = 0.35;

/** 默认缓存条目上限。 */
const DEFAULT_CACHE_LIMIT = 512;

/** 单条记忆送去做嵌入时的最大字符数，避免超长记忆浪费配额。 */
const MAX_EMBED_CHARS = 1_000;

/**
 * 基于嵌入向量的语义记忆排序器。
 *
 * 排序本身是余弦相似度；为了让本地读取不重复消耗配额，
 * 记忆向量按「id + 更新时间 + 长度」缓存在进程内，
 * 记忆内容变化后 key 自然失效。
 *
 * 这个实现不吞异常：网络失败会抛给调用方，
 * 由应用层决定是提示用户还是退回主题词排序。
 */
export class EmbeddingMemoryRanker implements MemoryRanker {
  /** 使用的嵌入实现。 */
  readonly embedding: EmbeddingProvider;

  private readonly limit: number;
  private readonly minScore: number;
  private readonly cacheLimit: number;
  private readonly cache = new Map<string, readonly number[]>();

  /** 创建嵌入排序器。 */
  constructor(options: EmbeddingMemoryRankerOptions) {
    this.embedding = options.embedding;
    this.limit = Math.max(0, options.limit ?? DEFAULT_LIMIT);
    this.minScore = options.minScore ?? DEFAULT_MIN_SCORE;
    this.cacheLimit = Math.max(1, options.cacheLimit ?? DEFAULT_CACHE_LIMIT);
  }

  /** 按语义相似度排序记忆。 */
  async rank(
    memories: readonly Memory[],
    query: MemoryRankQuery,
  ): Promise<readonly RankedMemory[]> {
    const limit = Math.max(0, query.limit ?? this.limit);
    const text = (query.text ?? "").trim();
    const ordered = [...memories].sort(compareByRecency);

    // 没有查询文本时退化为按时间倒序，不消耗嵌入配额。
    if (!text) {
      return ordered
        .slice(0, limit)
        .map((memory) => ({ memory, score: 0, matched: [] }));
    }

    if (limit === 0 || ordered.length === 0) {
      return [];
    }

    const missing = ordered.filter((memory) => !this.cache.has(cacheKey(memory)));
    const inputs = [text, ...missing.map((memory) => embedText(memory))];
    const vectors = await this.embedding.embed({ inputs });

    if (vectors.length !== inputs.length) {
      throw new Error(
        `嵌入结果数量不匹配：期望 ${inputs.length} 条，实际 ${vectors.length} 条`,
      );
    }

    const queryVector = vectors[0] ?? [];
    writeCache(this.cache, missing, vectors.slice(1), this.cacheLimit);

    const ranked = ordered.map((memory) => {
      const vector = this.cache.get(cacheKey(memory));
      const similarity = vector ? cosine(queryVector, vector) : 0;
      const score =
        similarity >= this.minScore ? round(similarity, 2) : 0;

      return { memory, score, matched: [] };
    });

    ranked.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return compareByRecency(left.memory, right.memory);
    });

    return ranked.slice(0, limit);
  }
}

/** 记忆向量的缓存键；内容变化会让旧键失效。 */
function cacheKey(memory: Memory): string {
  return `${memory.id}|${memory.updatedAt}|${memory.content.length}`;
}

/** 把向量写入缓存，并按插入顺序淘汰最旧的条目。 */
function writeCache(
  cache: Map<string, readonly number[]>,
  memories: readonly Memory[],
  vectors: readonly (readonly number[])[],
  cacheLimit: number,
): void {
  memories.forEach((memory, index) => {
    const vector = vectors[index];

    if (vector) {
      cache.set(cacheKey(memory), vector);
    }
  });

  while (cache.size > cacheLimit) {
    const oldest = cache.keys().next();

    if (oldest.done) {
      return;
    }

    cache.delete(oldest.value);
  }
}

/** 截断过长的记忆正文，只取开头部分参与向量计算。 */
function embedText(memory: Memory): string {
  return memory.content.slice(0, MAX_EMBED_CHARS);
}

/** 计算余弦相似度；任一向量为零向量时返回 0。 */
function cosine(
  left: readonly number[],
  right: readonly number[],
): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** 按更新时间倒序；同时间时按 id 保证稳定。 */
function compareByRecency(left: Memory, right: Memory): number {
  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }

  return left.id.localeCompare(right.id);
}

/** 保留指定小数位，避免浮点尾差进入界面。 */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
