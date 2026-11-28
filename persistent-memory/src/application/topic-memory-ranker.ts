import type { Memory } from "../domain/memory.js";
import type {
  MemoryRanker,
  MemoryRankQuery,
  RankedMemory,
} from "../ports/memory-ranker.js";

/** 默认最多返回多少条记忆。 */
const DEFAULT_LIMIT = 12;

/** 英文、数字与下划线组成的词。 */
const LATIN_PATTERN = /[a-z0-9_]+/g;

/** 连续中文片段。 */
const CJK_PATTERN = /[\u3400-\u9fff]+/g;

/** 标签命中时的加权倍数。 */
const TAG_WEIGHT = 1.5;

/**
 * 基于主题词的本地记忆排序器。
 *
 * 打分规则刻意保持简单可解释：
 * 1. 中文按二元组切词（「本周日志」→ 本周、周日、日志），英文按单词切；
 * 2. 内容命中记 1 分，标签命中记 1.5 分；
 * 3. 用 sqrt(词数) 归一，避免长记忆只因为字多就赢；
 * 4. 同分时新的记忆在前，保证结果稳定。
 *
 * 这个实现不假装自己是语义检索：它只处理字面重叠，
 * 真正的语义排序留给未来实现同一端口的嵌入适配器。
 */
export class TopicMemoryRanker implements MemoryRanker {
  /** 按主题词重叠度排序记忆。 */
  async rank(
    memories: readonly Memory[],
    query: MemoryRankQuery,
  ): Promise<readonly RankedMemory[]> {
    const tokens = new Set(tokenize(query.text ?? ""));
    const tagFilters = (query.tags ?? [])
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
    const limit = Math.max(0, query.limit ?? DEFAULT_LIMIT);

    const ranked = memories.map((memory) => {
      const matched: string[] = [];
      let score = 0;

      if (tokens.size > 0) {
        const memoryTokens = tokenize(memory.content);
        let hits = 0;

        for (const token of tokens) {
          if (memoryTokens.has(token)) {
            hits += 1;
            matched.push(token);
          }
        }

        score += hits / Math.sqrt(memoryTokens.size || 1);
      }

      const memoryTags = (memory.tags ?? []).map((tag) => tag.toLowerCase());

      for (const tag of tagFilters) {
        if (memoryTags.includes(tag)) {
          score += TAG_WEIGHT;
          matched.push(`#${tag}`);
        }
      }

      if (tokens.size > 0) {
        for (const tag of memoryTags) {
          for (const token of tokens) {
            if (tag.includes(token) && !matched.includes(`#${tag}`)) {
              score += TAG_WEIGHT * 0.5;
              matched.push(`#${tag}`);
              break;
            }
          }
        }
      }

      return { memory, score: round(score), matched };
    });

    ranked.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.memory.updatedAt !== right.memory.updatedAt) {
        return right.memory.updatedAt.localeCompare(left.memory.updatedAt);
      }
      return left.memory.id.localeCompare(right.memory.id);
    });

    return ranked.slice(0, limit);
  }
}

/** 把一段文本切成用于比较的主题词集合。 */
export function tokenize(text: string): ReadonlySet<string> {
  const normalized = text.toLowerCase();
  const tokens = new Set<string>();

  for (const word of normalized.match(LATIN_PATTERN) ?? []) {
    if (word.length >= 2) {
      tokens.add(word);
    }
  }

  for (const run of normalized.match(CJK_PATTERN) ?? []) {
    if (run.length === 1) {
      tokens.add(run);
      continue;
    }

    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.add(run.slice(index, index + 2));
    }
  }

  return tokens;
}

/** 保留两位小数，避免浮点尾差进入日志和测试。 */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
