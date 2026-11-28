import { describe, expect, it } from "vitest";
import { MemoryRetriever } from "../../src/application/memory-retriever.js";
import { TopicMemoryRanker } from "../../src/application/topic-memory-ranker.js";
import { createMemory, type Memory } from "../../src/domain/memory.js";
import type {
  MemoryRanker,
  MemoryRankQuery,
  RankedMemory,
} from "../../src/ports/memory-ranker.js";
import type {
  MemoryListOptions,
  MemoryStore,
} from "../../src/ports/memory-store.js";

/** 只保留 list 行为的记忆存储，方便断言检索服务的查询条件。 */
class FakeStore implements MemoryStore {
  readonly listCalls: (MemoryListOptions | undefined)[] = [];

  constructor(private readonly items: readonly Memory[]) {}

  async create(): Promise<void> {}

  async get(): Promise<Memory | null> {
    return null;
  }

  async save(): Promise<void> {}

  async list(options?: MemoryListOptions): Promise<readonly Memory[]> {
    this.listCalls.push(options);

    return this.items.filter(
      (memory) => options?.status === undefined || memory.status === options.status,
    );
  }

  async search(): Promise<readonly Memory[]> {
    return [];
  }
}

/** 用固定分数表代替真实排序器；failure 用于模拟嵌入服务失败。 */
class FakeRanker implements MemoryRanker {
  readonly queries: MemoryRankQuery[] = [];

  constructor(
    private readonly scores: Readonly<Record<string, number>>,
    private readonly failure?: Error,
  ) {}

  async rank(
    memories: readonly Memory[],
    query: MemoryRankQuery,
  ): Promise<readonly RankedMemory[]> {
    this.queries.push(query);

    if (this.failure) {
      throw this.failure;
    }

    return memories
      .map((memory) => ({
        memory,
        score: this.scores[memory.id] ?? 0,
        matched: [],
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, query.limit ?? 12);
  }
}

/** 构造一条固定时间的记忆。 */
function memory(
  id: string,
  content: string,
  createdAt = "2026-11-01T00:00:00.000Z",
): Memory {
  return createMemory({ id, content, createdAt });
}

describe("MemoryRetriever", () => {
  it("只检索 active 记忆，并把查询条件转给排序器", async () => {
    const active = memory("active", "用户喜欢把开发日志整理成周报");
    const archived = createMemory({
      id: "archived",
      content: "用户曾经把开发日志整理成周报",
      status: "archived",
      createdAt: "2026-11-01T00:00:00.000Z",
    });
    const store = new FakeStore([archived, active]);
    const ranker = new FakeRanker({ active: 1, archived: 1 });
    const retriever = new MemoryRetriever({ memoryStore: store, ranker });

    const result = await retriever.retrieve({
      text: "开发日志",
      tags: ["工作"],
      limit: 5,
    });

    expect(result.memories.map((entry) => entry.memory.id)).toEqual(["active"]);
    expect(result.degraded).toBe(false);
    expect(store.listCalls).toEqual([{ status: "active" }]);
    expect(ranker.queries).toEqual([
      { text: "开发日志", tags: ["工作"], limit: 5 },
    ]);
  });

  it("默认在没有任何命中时返回空结果", async () => {
    const store = new FakeStore([memory("a", "用户早餐喝咖啡")]);
    const ranker = new FakeRanker({ a: 0 });
    const retriever = new MemoryRetriever({ memoryStore: store, ranker });

    const result = await retriever.retrieve({ text: "开发日志" });

    expect(result.memories).toEqual([]);
    expect(result.degraded).toBe(false);
  });

  it("recentOnMiss 为 true 时退回排序器给出的全部结果", async () => {
    const store = new FakeStore([
      memory("a", "用户早餐喝咖啡"),
      memory("b", "用户喜欢散步"),
    ]);
    const ranker = new FakeRanker({});
    const retriever = new MemoryRetriever({ memoryStore: store, ranker });

    const result = await retriever.retrieve({
      text: "开发日志",
      recentOnMiss: true,
    });

    expect(result.memories.map((entry) => entry.memory.id)).toEqual(["a", "b"]);
  });

  it("主排序器失败时用主题词排序兜底并标记降级", async () => {
    const relevant = memory("relevant", "用户喜欢把开发日志整理成周报");
    const unrelated = memory("unrelated", "用户早餐喝手冲咖啡");
    const store = new FakeStore([unrelated, relevant]);
    const primary = new FakeRanker({}, new Error("嵌入服务不可用"));
    const retriever = new MemoryRetriever({
      memoryStore: store,
      ranker: primary,
      fallbackRanker: new TopicMemoryRanker(),
    });

    const result = await retriever.retrieve({ text: "开发日志" });

    expect(result.degraded).toBe(true);
    expect(result.degradationReason).toBe("嵌入服务不可用");
    expect(result.memories.map((entry) => entry.memory.id)).toEqual(["relevant"]);
    expect(result.memories[0]?.score).toBeGreaterThan(0);
  });

  it("空查询按更新时间倒序", async () => {
    const older = memory("older", "旧记忆", "2026-11-01T00:00:00.000Z");
    const newer = memory("newer", "新记忆", "2026-11-10T00:00:00.000Z");
    const store = new FakeStore([older, newer]);
    const retriever = new MemoryRetriever({
      memoryStore: store,
      ranker: new TopicMemoryRanker(),
    });

    const result = await retriever.retrieve();

    expect(result.memories.map((entry) => entry.memory.id)).toEqual([
      "newer",
      "older",
    ]);
    expect(result.degraded).toBe(false);
  });

  it("拒绝负数或小数 limit", async () => {
    const retriever = new MemoryRetriever({
      memoryStore: new FakeStore([]),
      ranker: new FakeRanker({}),
    });

    await expect(retriever.retrieve({ limit: -1 })).rejects.toThrow(
      "检索 limit 必须是非负整数",
    );
    await expect(retriever.retrieve({ limit: 1.5 })).rejects.toThrow(
      "检索 limit 必须是非负整数",
    );
  });

  it("limit 为 0 时不查询存储", async () => {
    const store = new FakeStore([memory("a", "记忆")]);
    const retriever = new MemoryRetriever({
      memoryStore: store,
      ranker: new FakeRanker({}),
    });

    const result = await retriever.retrieve({ limit: 0 });

    expect(result.memories).toEqual([]);
    expect(store.listCalls).toEqual([]);
  });
});
