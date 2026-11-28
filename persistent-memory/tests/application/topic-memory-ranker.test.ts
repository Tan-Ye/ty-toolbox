import { describe, expect, it } from "vitest";
import { TopicMemoryRanker, tokenize } from "../../src/application/topic-memory-ranker.js";
import { createMemory } from "../../src/domain/memory.js";

describe("TopicMemoryRanker", () => {
  const ranker = new TopicMemoryRanker();

  /** 构造一条固定时间的记忆，方便断言排序。 */
  function memory(content: string, tags: string[] = [], createdAt = "2026-11-01T00:00:00.000Z") {
    return createMemory({ content, tags, createdAt });
  }

  it("中文按二元组切词", () => {
    const tokens = tokenize("整理本周开发日志");

    expect(tokens.has("本周")).toBe(true);
    expect(tokens.has("开发")).toBe(true);
    expect(tokens.has("发日")).toBe(true);
  });

  it("与主题相关的记忆排在前面", async () => {
    const log = memory("用户喜欢把开发日志整理成周报");
    const coffee = memory("用户早餐喝手冲咖啡");

    const ranked = await ranker.rank([coffee, log], {
      text: "帮我整理这周的开发日志",
    });

    expect(ranked[0]?.memory.id).toBe(log.id);
    expect(ranked[0]?.score).toBeGreaterThan(0);
    expect(ranked[1]?.score).toBe(0);
  });

  it("标签命中会加权", async () => {
    const tagged = memory("一些不太相关的正文", ["日志"]);
    const plain = memory("用户写开发日志时会先列大纲");

    const ranked = await ranker.rank([plain, tagged], {
      text: "日志",
      tags: ["日志"],
    });

    expect(ranked[0]?.memory.id).toBe(tagged.id);
    expect(ranked[0]?.matched).toContain("#日志");
  });

  it("空查询按更新时间倒序", async () => {
    const older = memory("旧记忆", [], "2026-11-01T00:00:00.000Z");
    const newer = memory("新记忆", [], "2026-11-10T00:00:00.000Z");

    const ranked = await ranker.rank([older, newer], {});

    expect(ranked.map((entry) => entry.memory.id)).toEqual([newer.id, older.id]);
  });

  it("limit 会被遵守，默认最多 12 条", async () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      createMemory({ content: `记忆 ${index}`, createdAt: "2026-11-01T00:00:00.000Z" }),
    );

    expect(await ranker.rank(many, { limit: 3 })).toHaveLength(3);
    expect(await ranker.rank(many, {})).toHaveLength(12);
  });

  it("同一输入多次排序结果稳定", async () => {
    const items = [memory("开发日志"), memory("开发日志"), memory("咖啡")];

    const first = (await ranker.rank(items, { text: "日志" })).map(
      (entry) => entry.memory.id,
    );
    const second = (await ranker.rank(items, { text: "日志" })).map(
      (entry) => entry.memory.id,
    );

    expect(first).toEqual(second);
  });
});
