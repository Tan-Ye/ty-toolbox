import {
  archiveMemory as archiveMemoryDomain,
  createMemory as createMemoryDomain,
  updateMemory as updateMemoryDomain,
  type CreateMemoryInput,
  type Memory,
  type UpdateMemoryInput,
} from "../domain/memory.js";
import type {
  MemoryListOptions,
  MemorySearchOptions,
  MemoryStore,
} from "../ports/memory-store.js";

/** MemoryService 的依赖项。 */
export interface MemoryServiceOptions {
  /** 记忆持久化端口。 */
  readonly memoryStore: MemoryStore;
  /** 当前时间函数，测试时可以注入固定时间。 */
  readonly now?: () => string;
}

/** 创建记忆时由应用服务接收的输入。 */
export type CreateMemoryCommand = CreateMemoryInput;

/** 更新记忆时由应用服务接收的输入。 */
export type UpdateMemoryCommand = UpdateMemoryInput;

/**
 * 记忆应用服务。
 *
 * 该服务负责串联领域规则和记忆存储端口：领域函数负责生成或变更
 * 合法的记忆对象，MemoryStore 负责保存原始记忆文件。
 */
export class MemoryService {
  /** 应用服务依赖。 */
  private readonly options: MemoryServiceOptions;

  /** 创建记忆应用服务。 */
  constructor(options: MemoryServiceOptions) {
    this.options = options;
  }

  /** 创建并持久化一条新记忆。 */
  async create(input: CreateMemoryCommand): Promise<Memory> {
    const memory = createMemoryDomain({
      ...input,
      createdAt: input.createdAt ?? this.now(),
    });

    await this.options.memoryStore.create(memory);
    return memory;
  }

  /** 按 ID 读取记忆；不存在时返回 null。 */
  async get(memoryId: string): Promise<Memory | null> {
    return this.options.memoryStore.get(memoryId);
  }

  /** 更新并持久化一条已有记忆。 */
  async update(
    memoryId: string,
    input: UpdateMemoryCommand,
  ): Promise<Memory> {
    const memory = await this.getRequiredMemory(memoryId);
    const updated = updateMemoryDomain(memory, {
      ...input,
      updatedAt: input.updatedAt ?? this.now(),
    });

    await this.options.memoryStore.save(updated);
    return updated;
  }

  /** 归档并持久化一条已有记忆。 */
  async archive(memoryId: string): Promise<Memory> {
    const memory = await this.getRequiredMemory(memoryId);
    const archived = archiveMemoryDomain(memory, this.now());

    if (archived !== memory) {
      await this.options.memoryStore.save(archived);
    }

    return archived;
  }

  /** 按条件列出原始记忆。 */
  async list(options?: MemoryListOptions): Promise<readonly Memory[]> {
    return this.options.memoryStore.list(options);
  }

  /** 按本地确定性规则搜索原始记忆。 */
  async search(
    query: string,
    options?: MemorySearchOptions,
  ): Promise<readonly Memory[]> {
    return this.options.memoryStore.search(query, options);
  }

  /** 读取必须存在的记忆，并统一生成应用层错误。 */
  private async getRequiredMemory(memoryId: string): Promise<Memory> {
    const memory = await this.get(memoryId);

    if (!memory) {
      throw new Error(`记忆不存在：${memoryId.trim()}`);
    }

    return memory;
  }

  /** 获取当前时间。 */
  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))();
  }
}
