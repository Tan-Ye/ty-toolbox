/**
 * 生成模型无关的领域 ID。
 *
 * 领域层不能依赖 Node.js 或具体桌面壳；优先使用 Web Crypto，
 * 因此同一套领域模型既可以在 Node Runtime，也可以在 Tauri WebView 中复用。
 */
export function createDomainId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();

  // 极少数旧宿主没有 Web Crypto 时使用足够区分本地对象的回退值。
  return `kotana-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
