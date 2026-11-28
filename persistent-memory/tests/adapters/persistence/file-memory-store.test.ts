import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileMemoryStore } from "../../../src/adapters/persistence/file-memory-store.js";
import { archiveMemory, createMemory } from "../../../src/domain/memory.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createTemporaryDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "persistent-memory-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("FileMemoryStore", () => {
  it("支持创建、读取、更新和重启后恢复记忆", async () => {
    const dataDir = await createTemporaryDataDirectory();
    const store = new FileMemoryStore({ dataDir });
    const memory = createMemory({
      id: "memory-001",
      type: "fact",
      content: "用户常住上海",
      tags: ["用户", "地点"],
      createdAt: "2026-11-20T04:00:00.000Z",
    });

    await store.create(memory);
    await expect(new FileMemoryStore({ dataDir }).get(memory.id)).resolves.toEqual(
      memory,
    );

    const archived = archiveMemory(memory, "2026-11-20T05:00:00.000Z");
    await store.save(archived);
    await expect(store.get(memory.id)).resolves.toEqual(archived);
  });

  it("按 active 状态和内容执行确定性搜索", async () => {
    const dataDir = await createTemporaryDataDirectory();
    const store = new FileMemoryStore({ dataDir });
    const matching = createMemory({
      id: "memory-002",
      content: "用户喜欢喝茶",
      tags: ["饮食"],
      createdAt: "2026-11-20T04:00:00.000Z",
    });
    const archived = archiveMemory(
      createMemory({
        id: "memory-003",
        content: "用户曾经喜欢喝茶",
        createdAt: "2026-11-20T04:00:00.000Z",
      }),
      "2026-11-20T05:00:00.000Z",
    );

    await store.create(matching);
    await store.create(archived);

    await expect(
      store.search("用户喜欢喝茶", { status: "active", limit: 5 }),
    ).resolves.toEqual([matching]);
    await expect(store.list({ status: "archived" })).resolves.toEqual([archived]);
  });

  it("使用带版本的原始记忆文件格式", async () => {
    const dataDir = await createTemporaryDataDirectory();
    const memory = createMemory({
      id: "memory-004",
      content: "原始记忆",
      createdAt: "2026-11-20T04:00:00.000Z",
    });
    const store = new FileMemoryStore({ dataDir });

    await store.create(memory);

    const content = await readFile(
      join(dataDir, "memories", "memory-004.json"),
      "utf8",
    );
    expect(JSON.parse(content)).toEqual({
      schemaVersion: 1,
      type: "memory",
      memory,
    });
  });

  it("发现损坏的 JSON 文件时抛出错误", async () => {
    const dataDir = await createTemporaryDataDirectory();
    const memoriesDir = join(dataDir, "memories");
    await mkdir(memoriesDir, { recursive: true });
    await writeFile(join(memoriesDir, "broken.json"), "不是 JSON", "utf8");

    await expect(new FileMemoryStore({ dataDir }).list()).rejects.toThrow(
      "记忆文件不是有效 JSON",
    );
  });

  it("dataDir 为空时拒绝创建", () => {
    expect(() => new FileMemoryStore({ dataDir: "   " })).toThrow(
      "dataDir 不能为空",
    );
  });
});
