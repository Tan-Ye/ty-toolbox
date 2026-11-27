import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Kotana 桌面端轮询的 QQ 主动推送队列；可用环境变量 BUTLER_QQ_OUTBOX 覆盖。 */
export const DEFAULT_QQ_OUTBOX = resolve(
  HERE,
  '../../../kotana-runtime/.kotana-dev/outbox/qq.jsonl',
);

/**
 * 把一条消息写进 Kotana 的 QQ outbox。
 *
 * 这里只落盘、不直接连 QQ：同一个 appId 只允许一条连接，QQ 通道归 Kotana 进程，
 * 它起来后会按 id 补发；凌晨生成日报时 Kotana 没开也不会丢。
 *
 * @param {string} text 要推送的正文
 * @param {{ outboxPath?: string }} [options]
 * @returns {Promise<{ id: string, path: string }>}
 */
export async function pushQq(text, { outboxPath } = {}) {
  const path = outboxPath ?? process.env.BUTLER_QQ_OUTBOX ?? DEFAULT_QQ_OUTBOX;
  const trimmed = String(text ?? '').trim();

  if (!trimmed) {
    throw new Error('推送内容不能为空');
  }

  const id = await nextId(path, trimmed);
  const line = `${JSON.stringify({ id, at: new Date().toISOString(), text: trimmed })}\n`;

  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, line, 'utf8');

  return { id, path };
}

/**
 * 生成稳定 id：同一天同一段文本只推一次（计划任务重复触发也不会刷屏）。
 * 已推送过的 id 直接复用，Kotana 那边会跳过。
 */
async function nextId(filePath, text) {
  const digest = createHash('sha1')
    .update(`${new Date().toISOString().slice(0, 10)}\n${text}`)
    .digest('hex')
    .slice(0, 16);

  const candidate = `butler-${digest}`;
  const sent = await readSentIds(filePath);

  if (!sent.has(candidate)) {
    return candidate;
  }

  // 同一天同样的内容推第二次时换一个 id，允许“手动再发一次”。
  return `${candidate}-${Date.now().toString(36)}`;
}

async function readSentIds(filePath) {
  const ids = new Set();

  try {
    const content = await readFile(`${filePath}.sent`, 'utf8');

    for (const line of content.split('\n')) {
      const id = line.trim();

      if (id) {
        ids.add(id);
      }
    }
  } catch {
    // 还没有 .sent 文件。
  }

  return ids;
}
