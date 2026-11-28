import { describe, expect, it } from "vitest";

import * as persistentMemory from "../src/index.js";

/**
 * 包的公开面是宿主唯一会依赖的东西，这里把它钉死：
 * 少导出一个函数，宿主升级时就会在编译期而不是运行期炸。
 */
const EXPECTED_EXPORTS = [
  "archiveMemory",
  "createMemory",
  "updateMemory",
  "MemoryService",
  "MemoryRetriever",
  "TopicMemoryRanker",
  "EmbeddingMemoryRanker",
  "FileMemoryStore",
  "FileWriteQueue",
  "SiliconFlowEmbeddingProvider",
  "SiliconFlowEmbeddingError",
  "loadEmbeddingConfig",
] as const;

describe("公开 API", () => {
  it("保留宿主依赖的全部运行时导出", () => {
    expect(Object.keys(persistentMemory)).toEqual(
      expect.arrayContaining([...EXPECTED_EXPORTS]),
    );
  });

  it("不泄漏内部模块", () => {
    const expected: readonly string[] = EXPECTED_EXPORTS;

    for (const key of Object.keys(persistentMemory)) {
      expect(expected).toContain(key);
    }
  });
});
