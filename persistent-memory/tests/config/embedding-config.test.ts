import { describe, expect, it } from "vitest";
import { loadEmbeddingConfig } from "../../src/config/embedding-config.js";

describe("loadEmbeddingConfig", () => {
  it("没有配置 provider 时返回 undefined", () => {
    expect(loadEmbeddingConfig({ env: {} })).toBeUndefined();
    expect(
      loadEmbeddingConfig({ env: { KOTANA_EMBEDDING_PROVIDER: "none" } }),
    ).toBeUndefined();
    expect(
      loadEmbeddingConfig({ env: { KOTANA_EMBEDDING_PROVIDER: "off" } }),
    ).toBeUndefined();
  });

  it("读取默认的 KOTANA_ 变量并去除空白", () => {
    const config = loadEmbeddingConfig({
      env: {
        KOTANA_EMBEDDING_PROVIDER: " SiliconFlow ",
        KOTANA_EMBEDDING_API_KEY: " test-key ",
        KOTANA_EMBEDDING_BASE_URL: " https://example.test/v1 ",
        KOTANA_EMBEDDING_MODEL: " custom-model ",
      },
    });

    expect(config).toEqual({
      provider: "siliconflow",
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "custom-model",
    });
  });

  it("支持自定义环境变量前缀", () => {
    const config = loadEmbeddingConfig({
      prefix: "MY_MEMORY_",
      env: {
        MY_MEMORY_EMBEDDING_PROVIDER: "siliconflow",
        MY_MEMORY_EMBEDDING_API_KEY: "my-key",
      },
    });

    expect(config).toEqual({
      provider: "siliconflow",
      apiKey: "my-key",
      baseUrl: "https://api.siliconflow.cn/v1",
      model: "BAAI/bge-m3",
    });
  });

  it("启用嵌入但缺少密钥时报错", () => {
    expect(() =>
      loadEmbeddingConfig({
        env: { KOTANA_EMBEDDING_PROVIDER: "siliconflow" },
      }),
    ).toThrow("缺少 KOTANA_EMBEDDING_API_KEY");
  });

  it("不支持的 provider 会报错", () => {
    expect(() =>
      loadEmbeddingConfig({
        env: { KOTANA_EMBEDDING_PROVIDER: "openai" },
      }),
    ).toThrow("不支持的嵌入 Provider：openai");
  });
});
