/** 嵌入检索的运行配置；没有配置时表示继续使用本地主题词排序。 */
export interface EmbeddingConfig {
  /** 供应商标识，目前只支持 siliconflow。 */
  readonly provider: string;
  /** 供应商认证密钥；只存在于进程内，不写入数据文件。 */
  readonly apiKey: string;
  /** API 地址。 */
  readonly baseUrl: string;
  /** 嵌入模型名称。 */
  readonly model: string;
}

/** 解析嵌入配置时的可选项。 */
export interface LoadEmbeddingConfigOptions {
  /** 读取配置的环境变量；未提供时使用当前进程环境变量。 */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * 环境变量前缀，默认 `KOTANA_`。
   *
   * 变量名依次为 `<prefix>EMBEDDING_PROVIDER`、`<prefix>EMBEDDING_API_KEY`、
   * `<prefix>EMBEDDING_BASE_URL`、`<prefix>EMBEDDING_MODEL`。
   */
  readonly prefix?: string;
}

/** 默认环境变量前缀，保持与 kotana-runtime 现有 .env 兼容。 */
const DEFAULT_PREFIX = "KOTANA_";

/** 默认 API 地址。 */
const DEFAULT_BASE_URL = "https://api.siliconflow.cn/v1";

/** 默认嵌入模型。 */
const DEFAULT_MODEL = "BAAI/bge-m3";

/** 视为「关闭嵌入检索」的取值。 */
const DISABLED_VALUES = new Set(["", "none", "off", "false", "0"]);

/** 目前支持的嵌入供应商。 */
const SUPPORTED_PROVIDERS = new Set(["siliconflow"]);

/**
 * 从环境变量解析嵌入检索配置。
 *
 * 只认四个变量：`<prefix>EMBEDDING_PROVIDER`、`<prefix>EMBEDDING_API_KEY`、
 * `<prefix>EMBEDDING_BASE_URL`、`<prefix>EMBEDDING_MODEL`。默认关闭，
 * 只有显式设置 provider 才启用，避免「有 Key 就偷偷联网」；
 * 配置不完整时直接报错，否则用户会以为语义检索已经生效。
 */
export function loadEmbeddingConfig(
  options: LoadEmbeddingConfigOptions = {},
): EmbeddingConfig | undefined {
  const env = options.env ?? process.env;
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const read = (name: string): string => (env[`${prefix}${name}`] ?? "").trim();
  const provider = read("EMBEDDING_PROVIDER").toLowerCase();

  if (DISABLED_VALUES.has(provider)) {
    return undefined;
  }

  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new Error(
      `不支持的嵌入 Provider：${provider}（当前只支持 siliconflow）`,
    );
  }

  const apiKey = read("EMBEDDING_API_KEY");

  if (!apiKey) {
    throw new Error(
      `已启用嵌入检索，但缺少 ${prefix}EMBEDDING_API_KEY；请补上密钥或把 ${prefix}EMBEDDING_PROVIDER 设为 none`,
    );
  }

  return {
    provider,
    apiKey,
    baseUrl: read("EMBEDDING_BASE_URL") || DEFAULT_BASE_URL,
    model: read("EMBEDDING_MODEL") || DEFAULT_MODEL,
  };
}
