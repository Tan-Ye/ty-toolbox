import type {
  EmbeddingProvider,
  EmbeddingRequest,
} from "../../ports/embedding-provider.js";

/** 创建 SiliconFlow 嵌入适配器所需的选项。 */
export interface SiliconFlowEmbeddingOptions {
  /** 供应商 API Key；只保留在进程内，不写入任何数据文件。 */
  readonly apiKey: string;
  /** API 地址，默认 https://api.siliconflow.cn/v1。 */
  readonly baseUrl?: string;
  /** 嵌入模型名称，默认 BAAI/bge-m3。 */
  readonly model?: string;
  /** 单次请求超时时间，单位为毫秒。 */
  readonly timeoutMs?: number;
  /** 失败后最多重试次数，不包含第一次请求。 */
  readonly maxRetries?: number;
  /** 重试基础等待时间，单位为毫秒。 */
  readonly retryDelayMs?: number;
  /** 注入 fetch 实现，便于离线测试；默认使用全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

/** 默认 API 地址。 */
const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";

/** 默认嵌入模型。 */
const DEFAULT_MODEL = "BAAI/bge-m3";

/** 默认请求超时时间。 */
const DEFAULT_TIMEOUT_MS = 15_000;

/** 默认最多重试次数。 */
const DEFAULT_MAX_RETRIES = 1;

/** 默认重试基础等待时间。 */
const DEFAULT_RETRY_DELAY_MS = 400;

/** 单次请求最多携带多少条文本，避免超过供应商的批量上限。 */
const MAX_BATCH_SIZE = 32;

/** SiliconFlow 嵌入调用失败时抛出的错误。 */
export class SiliconFlowEmbeddingError extends Error {
  /** HTTP 状态码；网络层失败时为 undefined。 */
  readonly status: number | undefined;

  /** 创建嵌入调用错误。 */
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SiliconFlowEmbeddingError";
    this.status = status;
  }
}

/**
 * SiliconFlow 兼容 OpenAI 协议的嵌入适配器。
 *
 * 只做三件事：把文本分批 POST 到 `/embeddings`、按 index 还原顺序、
 * 把网络错误转成可读的中文错误。任何重试都由这里内部完成，
 * 上层只需要处理「最终失败」这一种情况。
 */
export class SiliconFlowEmbeddingProvider implements EmbeddingProvider {
  /** 供应商标识。 */
  readonly name = "siliconflow";

  /** 使用的嵌入模型名称。 */
  readonly model: string;

  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly fetchImpl: typeof fetch;

  /** 创建 SiliconFlow 嵌入适配器。 */
  constructor(options: SiliconFlowEmbeddingOptions) {
    const apiKey = options.apiKey.trim();

    if (!apiKey) {
      throw new Error("SiliconFlow 嵌入适配器需要 apiKey");
    }

    this.apiKey = apiKey;
    this.endpoint = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.model = options.model?.trim() || DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 把一批文本转成向量。 */
  async embed(
    request: EmbeddingRequest,
  ): Promise<readonly (readonly number[])[]> {
    const inputs = request.inputs.map((input) => input.trim());

    if (inputs.length === 0) {
      return [];
    }

    const vectors: (readonly number[])[] = [];

    for (let start = 0; start < inputs.length; start += MAX_BATCH_SIZE) {
      const chunk = inputs.slice(start, start + MAX_BATCH_SIZE);
      vectors.push(...(await this.embedChunk(chunk, request.signal)));
    }

    return vectors;
  }

  /** 请求单批文本的向量。 */
  private async embedChunk(
    chunk: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<readonly (readonly number[])[]> {
    let attempt = 0;

    for (;;) {
      const signals = [AbortSignal.timeout(this.timeoutMs)];

      if (signal) {
        signals.push(signal);
      }

      try {
        const response = await this.fetchImpl(`${this.endpoint}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            input: chunk,
            encoding_format: "float",
          }),
          signal: AbortSignal.any(signals),
        });

        if (!response.ok) {
          const detail = await readErrorDetail(response);
          const retryable = response.status === 429 || response.status >= 500;

          if (retryable && attempt < this.maxRetries) {
            attempt += 1;
            await this.wait(attempt);
            continue;
          }

          throw new SiliconFlowEmbeddingError(
            `嵌入请求失败（HTTP ${response.status}）：${detail}`,
            response.status,
          );
        }

        const payload: unknown = await response.json();
        return parseEmbeddings(payload, chunk.length);
      } catch (error) {
        if (error instanceof SiliconFlowEmbeddingError) {
          throw error;
        }

        if (isAbortError(error)) {
          throw new Error(`嵌入请求超时（${this.timeoutMs} 毫秒）`);
        }

        if (attempt < this.maxRetries) {
          attempt += 1;
          await this.wait(attempt);
          continue;
        }

        throw new SiliconFlowEmbeddingError(
          `嵌入请求失败：${readErrorMessage(error)}`,
        );
      }
    }
  }

  /** 按指数退避等待。 */
  private wait(attempt: number): Promise<void> {
    const delay = this.retryDelayMs * 2 ** (attempt - 1);

    return new Promise((resolve) => {
      setTimeout(resolve, delay);
    });
  }
}

/** 解析 OpenAI 兼容的嵌入响应，并按 index 还原顺序。 */
function parseEmbeddings(
  payload: unknown,
  expected: number,
): readonly (readonly number[])[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new SiliconFlowEmbeddingError("嵌入响应格式不正确：缺少 data 数组");
  }

  const items = payload.data.map((item, position) => {
    if (!isRecord(item) || !Array.isArray(item.embedding)) {
      throw new SiliconFlowEmbeddingError(
        `嵌入响应格式不正确：第 ${position} 条缺少 embedding`,
      );
    }

    const forwarding = item.embedding.every(
      (value) => typeof value === "number" && Number.isFinite(value),
    );

    if (!forwarding || item.embedding.length === 0) {
      throw new SiliconFlowEmbeddingError(
        `嵌入响应格式不正确：第 ${position} 条向量不是数字数组`,
      );
    }

    const index = typeof item.index === "number" ? item.index : position;

    return { index, vector: item.embedding as number[] };
  });

  if (items.length !== expected) {
    throw new SiliconFlowEmbeddingError(
      `嵌入响应数量不匹配：期望 ${expected} 条，实际 ${items.length} 条`,
    );
  }

  items.sort((left, right) => left.index - right.index);

  return items.map((item) => Object.freeze(item.vector));
}

/** 读取错误响应体，最多保留 200 个字符。 */
async function readErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text ? text.slice(0, 200) : "无响应正文";
  } catch {
    return "无法读取响应正文";
  }
}

/** 判断错误是否为取消或超时。 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** 读取错误的可读描述。 */
function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
