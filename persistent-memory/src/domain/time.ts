/**
 * 将输入时间解析并统一保存为 ISO 8601 UTC 字符串。
 * 未提供时间时使用当前时间，便于创建新的领域对象。
 */
export function normalizeIsoTimestamp(
  value: string | undefined,
  fieldName = "时间",
): string {
  const timestamp = value ?? new Date().toISOString();
  const milliseconds = Date.parse(timestamp);

  if (Number.isNaN(milliseconds)) {
    throw new Error(`${fieldName}无效：${timestamp}`);
  }

  return new Date(milliseconds).toISOString();
}
