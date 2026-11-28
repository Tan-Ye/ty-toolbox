/**
 * 通过 Chrome DevTools Protocol 操作桌宠自己的渲染页面。
 *
 * 绿色版 dsh-pet 是 Electron 应用：它的 `/dsh-pet-7340` 接口除了校验 Host，
 * 还要求渲染端协商出来的令牌（`installDesktopAuth` 只给同一页面的请求注入）。
 * 因此 Kotana 不能直接 curl，只能连它的调试端口，在页面里用带令牌的 `fetch` 说话。
 *
 * 这里只做最小实现：找到桌宠页面、连上 WebSocket、执行一次 `Runtime.evaluate`。
 * 不引入 WebSocket 依赖，使用 Node 自带的全局 `WebSocket`（Node 22+）。
 */

/** 桌宠页面在 `/json/list` 里的特征：路径里带 electron-helper。 */
const PET_PAGE_HINT = "electron-helper";

/** 单次调试请求的超时。 */
const EVALUATE_TIMEOUT_MS = 10_000;

/** 找页面时的轮询间隔。 */
const POLL_INTERVAL_MS = 200;

/** 等一张页面出现时的最多等待时长。 */
const FIND_TIMEOUT_MS = 10_000;

/** 最小可用的 WebSocket 形状，避免依赖 DOM 的类型定义。 */
interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** 带调试地址的页面。 */
interface PetPageTarget {
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

/** 从 `/json/list` 里挑出桌宠的渲染页面。 */
function pickPetPage(payload: unknown): PetPageTarget | null {
  if (!Array.isArray(payload)) return null;
  for (const item of payload) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const url = typeof record.url === "string" ? record.url : "";
    const socket = typeof record.webSocketDebuggerUrl === "string" ? record.webSocketDebuggerUrl : "";
    if (record.type !== "page" || socket.length === 0) continue;
    if (!url.includes(PET_PAGE_HINT)) continue;
    return { url, webSocketDebuggerUrl: socket };
  }
  return null;
}

/** 简单等待，避免引入额外依赖。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 等桌宠页面出现并返回它的调试地址。
 *
 * 返回 null 表示在超时内没找到——桌宠可能还在加载，或者调试端口没开。
 */
export async function findPetPage(
  debugPort: number,
  timeoutMs: number = FIND_TIMEOUT_MS,
): Promise<PetPageTarget | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const target = pickPetPage(await response.json());
        if (target !== null) return target;
      }
    } catch {
      // 端口还没起来或页面还没建好，继续等。
    }

    if (Date.now() >= deadline) break;
    await delay(POLL_INTERVAL_MS);
  } while (Date.now() < deadline);

  return null;
}

/** 在页面的 `main` 世界里执行一段表达式，并取回结构化结果。 */
export async function evaluatePetPage<T>(
  debugPort: number,
  expression: string,
  timeoutMs: number = EVALUATE_TIMEOUT_MS,
): Promise<T> {
  const target = await findPetPage(debugPort, Math.min(timeoutMs, FIND_TIMEOUT_MS));
  if (target === null) {
    throw new Error(`连不上桌宠的调试端口（${debugPort}），它可能还在加载。`);
  }

  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (Ctor === undefined) {
    throw new Error("当前 Node 没有全局 WebSocket，无法通过调试协议操作桌宠。");
  }

  const socket = new Ctor(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接桌宠调试端口超时。")), Math.min(timeoutMs, 3_000));
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("连接桌宠调试端口失败。"));
    };
  });

  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等待桌宠页面返回结果超时。")), timeoutMs);
      socket.onmessage = (event: { data: unknown }) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(String(event.data)) as Record<string, unknown>;
        } catch {
          return;
        }

        if (message.id !== 1) return;
        clearTimeout(timer);

        if (typeof message.error === "object" && message.error !== null) {
          const reason = (message.error as { message?: unknown }).message;
          reject(new Error(typeof reason === "string" ? reason : "桌宠调试协议返回错误。"));
          return;
        }

        const result = message.result as
          | {
              exceptionDetails?: { exception?: { description?: unknown } };
              result?: { value?: unknown };
            }
          | undefined;

        if (result?.exceptionDetails !== undefined) {
          const description = result.exceptionDetails.exception?.description;
          reject(
            new Error(typeof description === "string" ? description : "桌宠页面里的脚本执行失败。"),
          );
          return;
        }

        resolve(result?.result?.value as T);
      };

      socket.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          },
        }),
      );
    });
  } finally {
    try {
      socket.close();
    } catch {
      // 关不掉就算了，连接会随进程回收。
    }
  }
}
