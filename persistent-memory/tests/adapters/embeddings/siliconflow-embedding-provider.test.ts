import { describe, expect, it } from "vitest";
import {
  SiliconFlowEmbeddingError,
  SiliconFlowEmbeddingProvider,
} from "../../../src/adapters/embeddings/siliconflow-embedding-provider.js";

/** 捕获请求体，便于断言分批、模型和编码格式。 */
interface CapturedRequest {
  readonly url: string;
  readonly body: {
    readonly model: string;
    readonly input: readonly string[];
    readonly encoding_format: string;
  };
}

/** 构造一个返回固定向量的成功响应。 */
function embeddingResponse(vectors: readonly (readonly number[])[]): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ index, embedding })),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** 创建可注入的 fetch，并记录每次调用。 */
function createFetch(
  handler: (body: CapturedRequest["body"]) => Response,
): { fetchImpl: typeof fetch; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)) as CapturedRequest["body"];
    calls.push({ url: String(input), body });
    return handler(body);
  };

  return { fetchImpl, calls };
}

/** 创建一个使用测试密钥的适配器。 */
function createProvider(fetchImpl: typeof fetch): SiliconFlowEmbeddingProvider {
  return new SiliconFlowEmbeddingProvider({
    apiKey: "test-key",
    fetchImpl,
    retryDelayMs: 0,
  });
}

describe("SiliconFlowEmbeddingProvider", () => {
  it("每 32 条分批请求并保持输入顺序", async () => {
    const { fetchImpl, calls } = createFetch((body) =>
      embeddingResponse(body.input.map((text) => [text.length, 1])),
    );
    const provider = createProvider(fetchImpl);
    const inputs = Array.from({ length: 33 }, (_, index) => `文本${index}`);

    const vectors = await provider.embed({ inputs });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.input).toHaveLength(32);
    expect(calls[1]?.body.input).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.siliconflow.cn/v1/embeddings");
    expect(calls[0]?.body).toMatchObject({
      model: "BAAI/bge-m3",
      encoding_format: "float",
    });
    expect(vectors).toHaveLength(33);
    expect(vectors[0]).toEqual([inputs[0]!.length, 1]);
    expect(vectors[32]).toEqual([inputs[32]!.length, 1]);
  });

  it("按响应里的 index 还原顺序", async () => {
    const { fetchImpl } = createFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { index: 2, embedding: [3] },
              { index: 0, embedding: [1] },
              { index: 1, embedding: [2] },
            ],
          }),
          { status: 200 },
        ),
    );
    const provider = createProvider(fetchImpl);

    const vectors = await provider.embed({ inputs: ["a", "b", "c"] });

    expect(vectors).toEqual([[1], [2], [3]]);
  });

  it("对 500 响应重试一次后成功", async () => {
    let attempts = 0;
    const { fetchImpl } = createFetch(() => {
      attempts += 1;
      return attempts === 1
        ? new Response("server error", { status: 500 })
        : embeddingResponse([[1]]);
    });
    const provider = createProvider(fetchImpl);

    await expect(provider.embed({ inputs: ["x"] })).resolves.toEqual([[1]]);
    expect(attempts).toBe(2);
  });

  it("4xx 不重试，抛出带状态码的错误", async () => {
    let attempts = 0;
    const { fetchImpl } = createFetch(() => {
      attempts += 1;
      return new Response("bad request", { status: 400 });
    });
    const provider = createProvider(fetchImpl);

    const error = await provider.embed({ inputs: ["x"] }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SiliconFlowEmbeddingError);
    expect((error as SiliconFlowEmbeddingError).status).toBe(400);
    expect(attempts).toBe(1);
  });

  it("把 AbortError 转成超时错误", async () => {
    const fetchImpl: typeof fetch = async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    };
    const provider = createProvider(fetchImpl);

    await expect(provider.embed({ inputs: ["x"] })).rejects.toThrow(
      "嵌入请求超时（15000 毫秒）",
    );
  });

  it("空输入不发起请求", async () => {
    const { fetchImpl, calls } = createFetch(() => embeddingResponse([]));
    const provider = createProvider(fetchImpl);

    await expect(provider.embed({ inputs: [] })).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
