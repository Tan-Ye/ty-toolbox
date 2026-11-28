import { describe, expect, it } from "vitest";
import { EmbeddingMemoryRanker } from "../../src/application/embedding-memory-ranker.js";
import { createMemory } from "../../src/domain/memory.js";
import type {
  EmbeddingProvider,
  EmbeddingRequest,
} from "../../src/ports/embedding-provider.js";

/** 用固定向量表代替远程嵌入服务。 */
class FakeEmbedding implements EmbeddingProvider {
  readonly name = "fake";
  readonly calls: (readonly string[])[] = [];
  fail = false;

  private readonly vectors: Record<string, readonly number[]>;

  constructor(vectors: Record<string, readonly number[]>) {
    this.vectors = vectors;
  }

  async embed(request: EmbeddingRequest): Promise<readonly (readonly number[])[]> {
    if (this.fail) {
      throw new Error("嵌入服务不可用");
    }

    this.calls.push(request.inputs);

    return request.inputs.map((text) => this.vectors[text] ?? [0, 1, 0]);
  }
}

describe("EmbeddingMemoryRanker", () => {
  /** 构造一条固定时间的记忆。 */
  function memory(content: string, createdAt = "2026-11-01T00:00:00.000Z") {
    return createMemory({ content, createdAt });
  }

  it("语义相近的记忆排在前面", async () => {
    const log = memory("用户喜欢把开发日志整理成周报");
    const coffee = memory("用户早餐喝手冲咖啡");
    const embedding = new FakeEmbedding({
      帮我整理这周的开发日志: [1, 0, 0],
      "用户喜欢把开发日志整理成周报": [1, 0, 0],
      "用户早餐喝手冲咖啡": [0, 1, 0],
    });
    const ranker = new EmbeddingMemoryRanker({ embedding });

    const ranked = await ranker.rank([coffee, log], {
      text: "帮我整理这周的开发日志",
    });

    expect(ranked[0]?.memory.id).toBe(log.id);
    expect(ranked[0]?.score).toBe(1);
    expect(ranked[1]?.score).toBe(0);
  });

  it("低于相关度下限的记忆记 0 分", async () => {
    const partial = memory("开发日志");
    const embedding = new FakeEmbedding({
      开发日志: [0.5, 0.86, 0],
      "整理这周的开发日志": [1, 0, 0],
    });
    const ranker = new EmbeddingMemoryRanker({ embedding, minScore: 0.9 });

    const ranked = await ranker.rank([partial], { text: "整理这周的开发日志" });

    expect(ranked[0]?.score).toBe(0);
  });

  it("空查询不调用嵌入服务", async () => {
    const embedding = new FakeEmbedding({});
    const ranker = new EmbeddingMemoryRanker({ embedding });
    const older = memory("旧记忆", "2026-11-01T00:00:00.000Z");
    const newer = memory("新记忆", "2026-11-10T00:00:00.000Z");

    const ranked = await ranker.rank([older, newer], {});

    expect(embedding.calls).toHaveLength(0);
    expect(ranked.map((entry) => entry.memory.id)).toEqual([newer.id, older.id]);
  });

  it("记忆向量会被缓存，第二次只嵌入查询文本", async () => {
    const embedding = new FakeEmbedding({
      日志: [1, 0, 0],
      开发日志: [1, 0, 0],
    });
    const ranker = new EmbeddingMemoryRanker({ embedding });
    const items = [memory("开发日志")];

    await ranker.rank(items, { text: "日志" });
    await ranker.rank(items, { text: "日志" });

    expect(embedding.calls).toHaveLength(2);
    expect(embedding.calls[0]).toHaveLength(2);
    expect(embedding.calls[1]).toEqual(["日志"]);
  });

  it("嵌入失败会抛错，由上层决定是否降级", async () => {
    const embedding = new FakeEmbedding({});
    embedding.fail = true;
    const ranker = new EmbeddingMemoryRanker({ embedding });

    await expect(
      ranker.rank([memory("开发日志")], { text: "日志" }),
    ).rejects.toThrow("嵌入服务不可用");
  });
});
