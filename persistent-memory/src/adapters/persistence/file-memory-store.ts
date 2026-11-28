import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  Memory,
  MemoryStatus,
} from "../../domain/memory.js";
import type {
  MemoryListOptions,
  MemorySearchOptions,
  MemoryStore,
} from "../../ports/memory-store.js";
import { FileWriteQueue } from "./file-write-queue.js";

/** 记忆文件使用的当前数据格式版本。 */
const MEMORY_SCHEMA_VERSION = 1;

/** 记忆文件所在的目录名称。 */
const MEMORIES_DIRECTORY_NAME = "memories";

/** 文件记忆存储的配置。 */
export interface FileMemoryStoreOptions {
  /** 共享文件写入队列；未提供时为当前实例创建独立队列。 */
  readonly writeQueue?: FileWriteQueue;
  /** 宿主数据根目录；记忆文件写入其下的 memories/ 子目录。 */
  readonly dataDir: string;
}

/** 记忆文件的外层结构，用于支持未来的数据迁移。 */
interface MemoryDocument {
  /** 文件格式版本，而不是领域模型版本。 */
  readonly schemaVersion: number;
  /** 文件中保存的领域对象类型。 */
  readonly type: "memory";
  /** 记忆领域对象。 */
  readonly memory: Memory;
}

/** 使用单个 JSON 文件保存一条原始记忆。 */
export class FileMemoryStore implements MemoryStore {
  /** 存放记忆 JSON 文件的绝对目录。 */
  private readonly memoriesDir: string;

  /** 当前文件存储实例的写入队列。 */
  private readonly writeQueue: FileWriteQueue;

  /** 创建文件记忆存储。 */
  constructor(options: FileMemoryStoreOptions) {
    const dataDir = options.dataDir.trim();

    if (!dataDir) {
      throw new Error("FileMemoryStore 的 dataDir 不能为空");
    }

    this.memoriesDir = resolve(dataDir, MEMORIES_DIRECTORY_NAME);
    this.writeQueue = options.writeQueue ?? new FileWriteQueue();
  }

  /** 创建存储目录；目录已存在时不做修改。 */
  private async ensureMemoriesDirectory(): Promise<void> {
    await mkdir(this.memoriesDir, { recursive: true });
  }

  /** 将记忆 ID 编码为安全的文件名。 */
  private getMemoryPath(memoryId: string): string {
    const normalizedId = memoryId.trim();

    if (!normalizedId) {
      throw new Error("记忆 ID 不能为空");
    }

    return resolve(
      this.memoriesDir,
      `${encodeURIComponent(normalizedId)}.json`,
    );
  }

  /** 将记忆领域对象包装成带版本的文件文档。 */
  private createDocument(memory: Memory): MemoryDocument {
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      type: "memory",
      memory,
    };
  }

  /** 解析记忆文件并检查最小结构。 */
  private parseDocument(content: string, filePath: string): Memory {
    let value: unknown;

    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new Error(`记忆文件不是有效 JSON：${filePath}`, { cause: error });
    }

    if (!isMemoryDocument(value)) {
      throw new Error(`记忆文件格式无效：${filePath}`);
    }

    return value.memory;
  }

  /** 写入临时文件后替换目标文件，避免直接写入半截 JSON。 */
  private async writeAtomically(
    filePath: string,
    document: MemoryDocument,
  ): Promise<void> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(document, null, 2)}\n`;

    try {
      await writeFile(temporaryPath, content, "utf8");
      await rename(temporaryPath, filePath);
    } finally {
      // rename 成功后临时文件已不存在；失败时清理残留临时文件。
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  /** 创建新记忆，已存在相同 ID 时拒绝覆盖。 */
  async create(memory: Memory): Promise<void> {
    return this.writeQueue.enqueue(async () => {
      await this.ensureMemoriesDirectory();
      const filePath = this.getMemoryPath(memory.id);
      const content = `${JSON.stringify(this.createDocument(memory), null, 2)}\n`;

      try {
        // wx 保证创建操作不会覆盖已有文件。
        await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if (isFileExistsError(error)) {
          throw new Error(`记忆已存在：${memory.id}`, { cause: error });
        }
        throw error;
      }
    });
  }

  /** 按 ID 读取记忆；文件不存在时返回 null。 */
  async get(memoryId: string): Promise<Memory | null> {
    await this.writeQueue.drain();
    await this.ensureMemoriesDirectory();
    const filePath = this.getMemoryPath(memoryId);

    try {
      const content = await readFile(filePath, "utf8");
      return this.parseDocument(content, filePath);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return null;
      }

      throw error;
    }
  }

  /** 保存记忆快照，允许新增或覆盖。 */
  async save(memory: Memory): Promise<void> {
    return this.writeQueue.enqueue(async () => {
      await this.ensureMemoriesDirectory();
      await this.writeAtomically(
        this.getMemoryPath(memory.id),
        this.createDocument(memory),
      );
    });
  }

  /** 列出记忆，并按文件名保持稳定顺序。 */
  async list(options: MemoryListOptions = {}): Promise<readonly Memory[]> {
    await this.writeQueue.drain();
    await this.ensureMemoriesDirectory();
    const files = (await readdir(this.memoriesDir))
      .filter((fileName) => fileName.endsWith(".json"))
      .sort();
    const memories: Memory[] = [];

    for (const fileName of files) {
      const filePath = resolve(this.memoriesDir, fileName);
      const memory = this.parseDocument(
        await readFile(filePath, "utf8"),
        filePath,
      );

      if (matchesListOptions(memory, options)) {
        memories.push(memory);
      }
    }

    return memories;
  }

  /** 按记忆内容和标签执行本地确定性文本搜索。 */
  async search(
    query: string,
    options: MemorySearchOptions = {},
  ): Promise<readonly Memory[]> {
    await this.writeQueue.drain();
    const normalizedQuery = query.trim().toLocaleLowerCase();

    if (!normalizedQuery) {
      return [];
    }

    if (
      options.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 0)
    ) {
      throw new Error("记忆搜索 limit 必须是非负整数");
    }

    const terms = extractSearchTerms(normalizedQuery);
    const memories = await this.list({
      ...(options.status ? { status: options.status } : {}),
    });
    const matches = memories
      .map((memory, index) => {
        const searchableText = [memory.content, ...(memory.tags ?? [])]
          .join(" ")
          .toLocaleLowerCase();
        const matchedTerms = terms.filter((term) => searchableText.includes(term));
        const score =
          (searchableText.includes(normalizedQuery) ? 100 : 0) +
          matchedTerms.length;

        return { memory, index, score };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map((item) => item.memory);

    return options.limit === undefined
      ? matches
      : matches.slice(0, options.limit);
  }
}

/** 从查询中提取可用于本地匹配的英文词和中文二元词。 */
function extractSearchTerms(query: string): readonly string[] {
  const terms = new Set<string>();
  const segments = query.match(/[\u3400-\u9fff]+|[a-z0-9]+/gi) ?? [];

  for (const segment of segments) {
    if (/^[\u3400-\u9fff]+$/.test(segment)) {
      terms.add(segment);

      for (let index = 0; index < segment.length - 1; index += 1) {
        terms.add(segment.slice(index, index + 2));
      }
    } else {
      terms.add(segment);
    }
  }

  return [...terms];
}

/** 判断记忆是否满足列表筛选条件。 */
function matchesListOptions(
  memory: Memory,
  options: MemoryListOptions,
): boolean {
  if (options.status !== undefined && memory.status !== options.status) {
    return false;
  }

  if (options.tags === undefined) {
    return true;
  }

  const memoryTags = new Set(memory.tags ?? []);
  return options.tags.every((tag) => memoryTags.has(tag.trim()));
}

/** 校验从 JSON 解析出的最小记忆文件结构。 */
function isMemoryDocument(value: unknown): value is MemoryDocument {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.schemaVersion === MEMORY_SCHEMA_VERSION &&
    value.type === "memory" &&
    isMemory(value.memory)
  );
}

/** 校验记忆领域模型结构。 */
function isMemory(value: unknown): value is Memory {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === "string" &&
    isMemoryType(value.type) &&
    typeof value.content === "string" &&
    isMemoryStatus(value.status) &&
    isOptionalStringArray(value.tags) &&
    isOptionalRecord(value.metadata) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

/** 判断未知值是否为合法记忆分类。 */
function isMemoryType(value: unknown): boolean {
  return (
    value === "fact" ||
    value === "preference" ||
    value === "instruction" ||
    value === "event" ||
    value === "note"
  );
}

/** 判断未知值是否为合法记忆状态。 */
function isMemoryStatus(value: unknown): value is MemoryStatus {
  return value === "active" || value === "archived";
}

/** 判断可选字段是否未设置或为字符串数组。 */
function isOptionalStringArray(
  value: unknown,
): value is readonly string[] | undefined {
  return (
    value === undefined ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

/** 判断可选字段是否未设置或为普通对象。 */
function isOptionalRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> | undefined {
  return value === undefined || isRecord(value);
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判断未知错误是否为文件已存在错误。 */
function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
  return isNodeErrorWithCode(error, "EEXIST");
}

/** 判断未知错误是否为文件不存在错误。 */
function isFileNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return isNodeErrorWithCode(error, "ENOENT");
}

/** 判断错误对象是否带有指定 Node.js 文件系统错误码。 */
function isNodeErrorWithCode(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
