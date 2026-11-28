import { createDomainId } from "./identity.js";
import { normalizeIsoTimestamp } from "./time.js";

/** 第一阶段支持的记忆分类。 */
export type MemoryType =
  | "fact"
  | "preference"
  | "instruction"
  | "event"
  | "note";

/** 记忆的生命周期状态。 */
export type MemoryStatus = "active" | "archived";

/** 创建记忆时允许传入的字段。 */
export interface CreateMemoryInput {
  /** 测试或数据迁移时可指定稳定 ID。 */
  readonly id?: string;
  /** 记忆分类，默认是 note。 */
  readonly type?: MemoryType;
  /** 模型无关的原始记忆内容。 */
  readonly content: string;
  /** 创建时的生命周期状态，默认是 active。 */
  readonly status?: MemoryStatus;
  /** 便于人工管理和基础检索的标签。 */
  readonly tags?: readonly string[];
  /** 模型无关的扩展元数据。 */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** 测试或数据迁移时可指定创建时间。 */
  readonly createdAt?: string;
}

/** 更新记忆时允许修改的字段。 */
export interface UpdateMemoryInput {
  /** 修改后的分类。 */
  readonly type?: MemoryType;
  /** 修改后的原始记忆内容。 */
  readonly content?: string;
  /** 修改后的标签。 */
  readonly tags?: readonly string[];
  /** 替换后的模型无关扩展元数据。 */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** 测试或数据迁移时可指定更新时间。 */
  readonly updatedAt?: string;
}

/** 持久化保存的模型无关记忆领域模型。 */
export interface Memory {
  /** 记忆唯一标识。 */
  readonly id: string;
  /** 记忆分类。 */
  readonly type: MemoryType;
  /** 原始记忆内容，文件是其事实来源。 */
  readonly content: string;
  /** 当前生命周期状态。 */
  readonly status: MemoryStatus;
  /** 记忆标签。 */
  readonly tags?: readonly string[];
  /** 模型无关的扩展元数据。 */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** 记忆创建时间。 */
  readonly createdAt: string;
  /** 记忆最近一次领域变化时间。 */
  readonly updatedAt: string;
}

/** 创建一条 active 记忆。 */
export function createMemory(input: CreateMemoryInput): Memory {
  const content = input.content.trim();

  if (!content) {
    throw new Error("记忆内容不能为空");
  }

  const createdAt = normalizeIsoTimestamp(input.createdAt, "记忆创建时间");

  return {
    id: input.id?.trim() || createDomainId(),
    type: input.type ?? "note",
    content,
    status: input.status ?? "active",
    ...createOptionalTags(input.tags),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    createdAt,
    updatedAt: createdAt,
  };
}

/** 修改记忆内容，但不改变其生命周期状态。 */
export function updateMemory(
  memory: Memory,
  input: UpdateMemoryInput,
): Memory {
  const content = input.content === undefined ? memory.content : input.content.trim();

  if (!content) {
    throw new Error("记忆内容不能为空");
  }

  return {
    ...memory,
    ...(input.type === undefined ? {} : { type: input.type }),
    content,
    ...(input.tags === undefined ? {} : createOptionalTags(input.tags)),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    updatedAt: normalizeIsoTimestamp(input.updatedAt, "记忆更新时间"),
  };
}

/** 将 active 记忆归档，保留原始内容和历史字段。 */
export function archiveMemory(memory: Memory, archivedAt?: string): Memory {
  if (memory.status === "archived") {
    return memory;
  }

  return {
    ...memory,
    status: "archived",
    updatedAt: normalizeIsoTimestamp(archivedAt, "记忆归档时间"),
  };
}

/** 规范化标签并去除空标签和重复项。 */
function createOptionalTags(
  tags: readonly string[] | undefined,
): Pick<Memory, "tags"> {
  if (tags === undefined) {
    return {};
  }

  const normalizedTags = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  return normalizedTags.length > 0 ? { tags: normalizedTags } : {};
}
