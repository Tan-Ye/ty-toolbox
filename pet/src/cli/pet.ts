#!/usr/bin/env node
import { readFileSync } from "node:fs";

const VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const BASE_URL = (() => {
  const explicit = process.env.PET_HTTP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const port = process.env.PET_HTTP_PORT?.trim() || "7340";
  return `http://127.0.0.1:${port}`;
})();

type Json = Record<string, unknown>;

function help(): string {
  return `Pet 桌宠 CLI ${VERSION}

用法：
  pet status                 查看运行状态
  pet say <文字> [--duration 6000]
                             让桌宠说一句话
  pet work <状态> [任务]      显示工作状态
                             状态：thinking/working/result/waiting/success/error
  pet clear                  清除工作状态
  pet play <动画>             播放动画
                             动画：idle/look/drag/click-happy/click-shy/click-wave/sleep/walk
  pet show                   显示桌宠
  pet hide                   隐藏桌宠
  pet settings               打开设置窗口
  pet prefs                  读取偏好设置
  pet prefs set '<json>'     合并保存偏好（也可从 stdin 读 JSON）
  pet quit                   退出 Pet

环境变量：
  PET_HTTP_URL               完整接口地址，例如 http://127.0.0.1:7340
  PET_HTTP_PORT              接口端口，默认 7340
`;
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5000),
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `连接不上 Pet（${BASE_URL}）。它没在运行，或端口不是 7340。\n底层错误：${message}`,
    );
  }
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as Json).error)
        : text || response.statusText;
    throw new Error(`接口返回 ${response.status}：${detail}`);
  }
  return payload;
}

function post(path: string, body: Json = {}): Promise<unknown> {
  return call(path, { method: "POST", body: JSON.stringify(body) });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(help());
    return 0;
  }
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (command === "status") {
    const payload = (await call("/status")) as Json;
    process.stdout.write(
      `运行中 · ${payload.visible ? "桌宠可见" : "桌宠隐藏"} · 端口 ${payload.httpPort} · 版本 ${payload.version}\n`,
    );
    process.stdout.write(`数据目录 ${payload.dataDir}\n`);
    return 0;
  }

  if (command === "say") {
    const words: string[] = [];
    let durationMs: number | undefined;
    for (let index = 0; index < rest.length; index += 1) {
      const item = rest[index]!;
      if (item === "--duration") {
        const raw = rest[index + 1];
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--duration 需要正整数毫秒");
        durationMs = parsed;
        index += 1;
      } else if (item.startsWith("--duration=")) {
        const parsed = Number(item.slice("--duration=".length));
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--duration 需要正整数毫秒");
        durationMs = parsed;
      } else {
        words.push(item);
      }
    }
    const text = words.join(" ").trim() || (await readStdin()).trim();
    if (!text) throw new Error("要说点什么：pet say <文字>");
    await post("/say", durationMs ? { text, durationMs } : { text });
    process.stdout.write("已发送\n");
    return 0;
  }

  if (command === "work") {
    const state = rest[0];
    if (!state) throw new Error("用法：pet work <状态> [任务]");
    const task = rest.slice(1).join(" ").trim();
    await post("/work", task ? { state, task } : { state });
    process.stdout.write(`已切换到 ${state}\n`);
    return 0;
  }

  if (command === "clear") {
    await post("/work/clear");
    process.stdout.write("已清除工作状态\n");
    return 0;
  }

  if (command === "play") {
    const animation = rest[0];
    if (!animation) throw new Error("用法：pet play <动画>");
    await post("/play", { animation });
    process.stdout.write(`播放 ${animation}\n`);
    return 0;
  }

  if (command === "show" || command === "hide") {
    await post(`/${command}`);
    process.stdout.write(command === "show" ? "已显示\n" : "已隐藏\n");
    return 0;
  }

  if (command === "settings") {
    await post("/settings");
    process.stdout.write("已打开设置\n");
    return 0;
  }

  if (command === "prefs") {
    if (rest[0] !== "set") {
      process.stdout.write(`${JSON.stringify(await call("/prefs"), null, 2)}\n`);
      return 0;
    }
    const raw = rest.slice(1).join(" ").trim() || (await readStdin()).trim();
    if (!raw) throw new Error("用法：pet prefs set '<json>'");
    const parsed = JSON.parse(raw) as Json;
    const payload = (await call("/prefs", { method: "PUT", body: JSON.stringify(parsed) })) as Json;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  if (command === "quit") {
    await post("/quit");
    process.stdout.write("已退出\n");
    return 0;
  }

  throw new Error(`未知命令：${command}\n\n${help()}`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
