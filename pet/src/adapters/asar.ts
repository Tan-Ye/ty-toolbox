import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 读 Electron 的 `app.asar`。
 *
 * 桌宠自带的默认配置（`assets/config.jsonc`）就在包里。我们只读，不动包里的任何东西。
 */

/** asar 头里的文件节点。 */
export interface AsarNode {
  readonly files?: Record<string, AsarNode>;
  readonly offset?: string;
  readonly size?: number;
}

/**
 * 从 asar 里读一个文本文件。
 *
 * 结构：`[u32 头长度][u32 payload][u32 json 长度][u32 字符串长度][JSON 头][数据区]`，
 * 数据区起点是 `8 + payload`，每个文件用相对数据区的 `offset` / `size` 定位。
 */
export function readAsarEntry(asarPath: string, entryPath: string): string | null {
  try {
    const data = readFileSync(asarPath);
    if (data.length < 16) return null;

    const payloadSize = data.readUInt32LE(4);
    const headerSize = data.readUInt32LE(12);
    const header = JSON.parse(data.subarray(16, 16 + headerSize).toString("utf8")) as AsarNode;

    let node: AsarNode | undefined = header;
    for (const part of entryPath.split("/")) {
      node = node?.files?.[part];
      if (node === undefined) return null;
    }

    const offset = Number.parseInt(node.offset ?? "", 10);
    const size = typeof node.size === "number" ? node.size : Number.NaN;
    if (!Number.isFinite(offset) || !Number.isFinite(size)) return null;

    const start = 8 + payloadSize + offset;
    if (start + size > data.length) return null;
    return data.subarray(start, start + size).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * 把整个 asar 解包到目录里，返回解出的文件数。
 *
 * 只给桌宠用：Electron 43 的 `createReadStream` 打不开 asar 内的条目，
 * 素材走 HTTP 会得到空响应。解包成普通目录后它按真实文件读，问题消失。
 */
export function extractAsar(asarPath: string, targetDir: string): number {
  const data = readFileSync(asarPath);
  if (data.length < 16) throw new Error("app.asar 太小，读不出头信息");

  const payloadSize = data.readUInt32LE(4);
  const headerSize = data.readUInt32LE(12);
  const header = JSON.parse(
    data.subarray(16, 16 + headerSize).toString("utf8"),
  ) as AsarNode;
  const base = 8 + payloadSize;
  let count = 0;

  const walk = (node: AsarNode, parent: string): void => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const entryPath = parent === "" ? name : `${parent}/${name}`;
      if (child.files !== undefined) {
        walk(child, entryPath);
        continue;
      }
      const offset = Number.parseInt(child.offset ?? "", 10);
      const size = typeof child.size === "number" ? child.size : Number.NaN;
      if (!Number.isFinite(offset) || !Number.isFinite(size)) {
        throw new Error(`app.asar 条目损坏：${entryPath}`);
      }
      const target = join(targetDir, ...entryPath.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, data.subarray(base + offset, base + offset + size));
      count += 1;
    }
  };

  try {
    walk(header, "");
  } catch (error) {
    rmSync(targetDir, { recursive: true, force: true });
    throw error;
  }

  return count;
}

/**
 * 去掉 JSONC 里的注释，好让 `JSON.parse` 能读。
 *
 * 只在它真的能解析时才用；字符串里的 `//`（比如 URL）不会被误删。
 */
export function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    result += char;
  }

  // JSONC 允许尾随逗号，顺手去掉。
  return result.replace(/,(\s*[}\]])/g, "$1");
}
