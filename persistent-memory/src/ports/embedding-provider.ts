/** 文本嵌入请求。 */
export interface EmbeddingRequest {
  /** 待转成向量的文本；返回结果必须与这里的顺序一一对应。 */
  readonly inputs: readonly string[];
  /** 取消信号；调用方取消后实现应尽快中止请求。 */
  readonly signal?: AbortSignal;
}

/**
 * 文本嵌入端口。
 *
 * Runtime 只依赖「把文本变成向量」这一能力，不依赖任何具体供应商的 SDK。
 * 更换供应商时新增一个实现该端口的适配器，并在组装层注入即可，
 * 领域层、应用层与界面都不需要修改。
 */
export interface EmbeddingProvider {
  /** 供应商的稳定标识，例如 siliconflow。 */
  readonly name: string;
  /** 供应商使用的嵌入模型名称；便于日志与界面展示。 */
  readonly model?: string;
  /** 把一批文本转成向量；实现必须保证返回数组与 inputs 等长同序。 */
  embed(request: EmbeddingRequest): Promise<readonly (readonly number[])[]>;
}
