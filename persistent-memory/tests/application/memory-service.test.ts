import { describe, expect, it } from "vitest";
import { MemoryService } from "../../src/application/memory-service.js";
import { createMemory, type Memory } from "../../src/domain/memory.js";
import type { MemoryStore } from "../../src/ports/memory-store.js";

class InMemoryMemoryStore implements MemoryStore {
  readonly memories = new Map<string, Memory>();

  async create(memory: Memory): Promise<void> {
    if (this.memories.has(memory.id)) {
      throw new Error(`记忆已存在：${memory.id}`);
    }

    this.memories.set(memory.id, memory);
  }

  async get(memoryId: string): Promise<Memory | null> {
    return this.memories.get(memoryId) ?? null;
  }

  async save(memory: Memory): Promise<void> {
    this.memories.set(memory.id, memory);
  }

  async list(): Promise<readonly Memory[]> {
    return [...this.memories.values()];
  }

  async search(): Promise<readonly Memory[]> {
    return [...this.memories.values()];
  }
}

describe("MemoryService", () => {
  it("使用领域函数创建并持久化记忆", async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService({
      memoryStore: store,
      now: () => "2026-11-21T04:00:00.000Z",
    });

    const memory = await service.create({
      id: "memory-service-001",
      type: "fact",
      content: "  用户常住上海  ",
    });

    expect(memory).toMatchObject({
      id: "memory-service-001",
      content: "用户常住上海",
      createdAt: "2026-11-21T04:00:00.000Z",
      updatedAt: "2026-11-21T04:00:00.000Z",
    });
    await expect(service.get(memory.id)).resolves.toEqual(memory);
  });

  it("更新和归档记忆时使用统一时间并保存结果", async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService({
      memoryStore: store,
      now: () => "2026-11-21T05:00:00.000Z",
    });
    await service.create({
      id: "memory-service-002",
      content: "原始内容",
      createdAt: "2026-11-21T04:00:00.000Z",
    });

    const updated = await service.update("memory-service-002", {
      content: "更新后的内容",
    });
    const archived = await service.archive("memory-service-002");

    expect(updated.content).toBe("更新后的内容");
    expect(updated.updatedAt).toBe("2026-11-21T05:00:00.000Z");
    expect(archived.status).toBe("archived");
    expect(archived.updatedAt).toBe("2026-11-21T05:00:00.000Z");
    await expect(service.get("memory-service-002")).resolves.toEqual(archived);
  });

  it("对不存在的记忆返回明确错误", async () => {
    const service = new MemoryService({
      memoryStore: new InMemoryMemoryStore(),
    });

    await expect(service.update("missing-memory", { content: "新内容" })).rejects.toThrow(
      "记忆不存在：missing-memory",
    );
    await expect(service.archive("missing-memory")).rejects.toThrow(
      "记忆不存在：missing-memory",
    );
  });

  it("归档已归档记忆时不重复写入", async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService({ memoryStore: store });
    const memory = createMemory({
      id: "memory-service-003",
      content: "已归档记忆",
      status: "archived",
      createdAt: "2026-11-21T04:00:00.000Z",
    });
    await store.create(memory);

    await expect(service.archive(memory.id)).resolves.toEqual(memory);
  });
});
