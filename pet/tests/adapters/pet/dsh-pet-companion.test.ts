import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DshPetCompanion,
  PetCompanionError,
  petStoragePaths,
  type DshPetCompanionOptions,
} from "../../../src/adapters/dsh-pet-companion.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

/**
 * 造一个假的 DSH_HOME。
 *
 * 适配器在没有 `dataDir` 时用它当桌宠的配置目录；
 * 有 `dataDir` 时只用它来避免读到真实用户目录。
 */
function fakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "kotana-pet-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  cleanups.push(() => {
    if (previous === undefined) {
      delete process.env.DSH_HOME;
    } else {
      process.env.DSH_HOME = previous;
    }
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

/** 造一个数据目录，并登记清理。 */
function fakeDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), "kotana-pet-data-"));
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

/** 写一份 Kotana 自己记的 owned.json。 */
function writeOwned(
  dataDir: string,
  state: { pid: number; debugPort?: number; port?: number | null },
): string {
  const file = join(dataDir, "pet", "owned.json");
  mkdirSync(join(dataDir, "pet"), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      pid: state.pid,
      debugPort: state.debugPort ?? 9333,
      port: state.port ?? null,
      startedAt: new Date().toISOString(),
    }),
    "utf8",
  );
  return file;
}

/** 带默认注入的 companion，减少每个用例的重复配置。 */
function makeCompanion(options: DshPetCompanionOptions = {}): DshPetCompanion {
  return new DshPetCompanion({
    exePath: "C:/tools/dsh-pet.exe",
    settleMs: 0,
    portWaitMs: 0,
    debugPort: 9333,
    spawnImpl: () => ({ kill: () => true, exitCode: null }),
    evaluateImpl: async () => {
      throw new Error("这个用例不该访问桌宠页面");
    },
    ...options,
  });
}

describe("DshPetCompanion", () => {
  it("未配置程序路径时只能读状态", async () => {
    fakeHome();
    const companion = new DshPetCompanion();

    const status = await companion.status();

    expect(status.configured).toBe(false);
    expect(status.running).toBe(false);
    expect(status.port).toBeNull();
    expect(status.message).toBe("还没有设置桌宠程序路径。");
  });

  it("owned.json 里的进程还活着就算运行中，并报出真实端口", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    writeOwned(dataDir, { pid: process.pid, port: 55_543 });

    const companion = makeCompanion({ dataDir, isPidAliveImpl: () => true });
    const status = await companion.status();

    expect(status.running).toBe(true);
    expect(status.port).toBe(55_543);
    expect(status.message).toContain("端口 55543");
  });

  it("owned.json 里的进程已经不在就清掉记录并视为未运行", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    const file = writeOwned(dataDir, { pid: 999_999 });

    const companion = makeCompanion({ dataDir, isPidAliveImpl: () => false });
    const status = await companion.status();

    expect(status.running).toBe(false);
    expect(status.port).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it("启动只拉起进程并带上调试端口，不等健康检查", async () => {
    fakeHome();
    const spawned: string[] = [];
    const companion = makeCompanion({
      spawnImpl: (command, args) => {
        spawned.push(`${command} ${args.join(" ")}`);
        return { kill: () => true, exitCode: null, pid: 4_242 };
      },
    });

    const status = await companion.start();

    expect(spawned).toEqual([
      "C:/tools/dsh-pet.exe --port 3080 --remote-debugging-port=9333",
    ]);
    expect(status.running).toBe(true);
    expect(status.message).toContain("桌宠已拉起");
  });

  it("启动后从页面 configUrl 取真实端口，并写进 owned.json", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    const seen: number[] = [];
    const companion = makeCompanion({
      dataDir,
      spawnImpl: () => ({ kill: () => true, exitCode: null, pid: 4_242 }),
      portWaitMs: 1_000,
      evaluateImpl: async (debugPort, expression) => {
        seen.push(debugPort);
        if (expression.includes("configUrl")) return 55_543;
        throw new Error(`不该执行：${expression}`);
      },
      isPidAliveImpl: () => true,
    });

    const status = await companion.start();

    expect(seen).toEqual([9333]);
    expect(status.port).toBe(55_543);
    expect(status.message).toContain("端口 55543");
    const owned = JSON.parse(readFileSync(join(dataDir, "pet", "owned.json"), "utf8")) as {
      pid: number;
      debugPort: number;
      port: number | null;
    };
    expect(owned.pid).toBe(4_242);
    expect(owned.debugPort).toBe(9333);
    expect(owned.port).toBe(55_543);
  });

  it("宿主重启后按 owned.json 认领，不会重复拉起", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    writeOwned(dataDir, { pid: 4_242, port: 55_543 });
    const spawned: string[] = [];

    const companion = makeCompanion({
      dataDir,
      isPidAliveImpl: () => true,
      spawnImpl: (command, args) => {
        spawned.push(command);
        return { kill: () => true, exitCode: null };
      },
    });

    const status = await companion.start();

    expect(spawned).toEqual([]);
    expect(status.running).toBe(true);
    expect(status.port).toBe(55_543);
    expect(status.message).toContain("已经在运行");
  });

  it("关闭时结束整棵进程树，并清掉 owned.json", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    const file = writeOwned(dataDir, { pid: 4_242 });
    let alive = true;
    const killed: number[] = [];

    const companion = makeCompanion({
      dataDir,
      isPidAliveImpl: () => alive,
      killTreeImpl: async (pid) => {
        killed.push(pid);
        alive = false;
        return true;
      },
    });

    await expect(companion.stop()).resolves.toBeUndefined();

    expect(killed).toEqual([4_242]);
    expect(existsSync(file)).toBe(false);
  });

  it("进程树没杀掉时报 stop-failed，但不谎称成功", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    writeOwned(dataDir, { pid: 4_242 });

    const companion = makeCompanion({
      dataDir,
      isPidAliveImpl: () => true,
      killTreeImpl: async () => false,
    });

    await expect(companion.stop()).rejects.toMatchObject({ reason: "stop-failed" });
  });

  it("桌宠的 home 与 profile 都落在数据目录下", () => {
    const paths = petStoragePaths(join("D:", "kotana-data"));

    expect(paths.home).toBe(join("D:", "kotana-data", "pet", "home"));
    expect(paths.appData).toBe(join("D:", "kotana-data", "pet", "appdata"));
  });

  it("拉起桌宠时给它独立的 DSH_HOME 与 APPDATA", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    const seen: Array<{ env?: NodeJS.ProcessEnv } | undefined> = [];
    const companion = makeCompanion({
      dataDir,
      spawnImpl: (command, args, options) => {
        seen.push(options);
        return { kill: () => true, exitCode: null };
      },
    });

    await companion.start();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.env?.DSH_HOME).toBe(join(dataDir, "pet", "home"));
    expect(seen[0]?.env?.APPDATA).toBe(join(dataDir, "pet", "appdata"));
    expect(existsSync(join(dataDir, "pet", "home", "dsh-pet"))).toBe(true);
  });

  it("拉起桌宠时去掉会让 Electron 变成 Node 的环境变量", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    const previousRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.ELECTRON_RUN_AS_NODE = "1";
    process.env.NODE_OPTIONS = "--require D:/nope.js";

    const seen: Array<{ env?: NodeJS.ProcessEnv } | undefined> = [];
    const companion = makeCompanion({
      dataDir,
      spawnImpl: (command, args, options) => {
        seen.push(options);
        return { kill: () => true, exitCode: null };
      },
    });

    try {
      await companion.start();

      expect(seen).toHaveLength(1);
      // 一旦继承，dsh-pet.exe 会当成 node 跑，秒退且没有任何输出。
      expect(seen[0]?.env?.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(seen[0]?.env?.NODE_OPTIONS).toBeUndefined();
      expect(seen[0]?.env?.DSH_HOME).toBe(join(dataDir, "pet", "home"));
    } finally {
      if (previousRunAsNode === undefined) {
        delete process.env.ELECTRON_RUN_AS_NODE;
      } else {
        process.env.ELECTRON_RUN_AS_NODE = previousRunAsNode;
      }
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
    }
  });

  it("KOTANA_PET_ARGS 里的参数会追加给桌宠", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    const seen: Array<readonly string[]> = [];
    const companion = makeCompanion({
      dataDir,
      extraArgs: ["--disable-gpu-sandbox", "--disable-gpu"],
      spawnImpl: (command, args) => {
        seen.push(args);
        return { kill: () => true, exitCode: null };
      },
    });

    await companion.start();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.slice(0, 2)).toEqual(["--port", "3080"]);
    expect(seen[0]).toEqual(
      expect.arrayContaining([
        "--remote-debugging-port=9333",
        "--disable-gpu-sandbox",
        "--disable-gpu",
      ]),
    );
    // 同时会带上自己的 Chromium profile，避免和别的实例抢单实例锁。
    expect(seen[0]?.some((arg) => arg.startsWith("--user-data-dir="))).toBe(true);
  });

  it("沙箱崩溃（0x80000003）时自动用 --no-sandbox 重试一次", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    const attempts: Array<readonly string[]> = [];
    const companion = makeCompanion({
      dataDir,
      spawnImpl: (command, args) => {
        attempts.push(args);
        // 第一次模拟 Chromium 沙箱崩溃，第二次（带 --no-sandbox）存活。
        return attempts.length === 1
          ? { kill: () => true, exitCode: -2147483645 }
          : { kill: () => true, exitCode: null };
      },
    });

    const status = await companion.start();

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).not.toContain("--no-sandbox");
    expect(attempts[1]).toContain("--no-sandbox");
    expect(status.running).toBe(true);
    expect(status.message).toContain("兼容模式");
  });

  it("子进程立刻退出时报启动失败", async () => {
    fakeHome();
    const companion = makeCompanion({
      spawnImpl: () => ({ kill: () => true, exitCode: 1 }),
    });

    await expect(companion.start()).rejects.toMatchObject({
      reason: "start-failed",
    });
  });

  it("启动前把宠物 display 改成 desktop，并留下备份", async () => {
    const home = fakeHome();
    const directory = join(home, "dsh-pet");
    mkdirSync(directory, { recursive: true });
    const configPath = join(directory, "main-config.jsonc");
    writeFileSync(
      configPath,
      JSON.stringify({
        pets: [{ id: "main", name: "蓝毛小女仆", display: "none" }],
        trayEnabled: true,
      }),
      "utf8",
    );

    const companion = makeCompanion();

    await companion.start();

    const rewritten = JSON.parse(readFileSync(configPath, "utf8")) as {
      pets: Array<{ display: string }>;
    };
    expect(rewritten.pets[0]?.display).toBe("desktop");
    expect(existsSync(`${configPath}.bak-kotana`)).toBe(true);
  });

  it("启动失败时把日志尾巴带进错误信息", async () => {
    const home = fakeHome();
    const directory = join(home, "dsh-pet");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "logs.txt"),
      ["第一行", "无桌面宠物（display 均为 web/none），已跳过桌面 Helper 启动"].join("\n"),
      "utf8",
    );

    const companion = makeCompanion({
      spawnImpl: () => ({ kill: () => true, exitCode: 1 }),
    });

    await expect(companion.start()).rejects.toThrowError(/已跳过桌面 Helper 启动/u);
  });

  it("退出收尾只关自己拉起的桌宠", async () => {
    fakeHome();
    const killed: number[] = [];
    const companion = makeCompanion({
      spawnImpl: () => ({
        kill: () => true,
        exitCode: null,
        pid: 4_242,
      }),
      killTreeImpl: async (pid) => {
        killed.push(pid);
        return true;
      },
      isPidAliveImpl: () => true,
    });

    await companion.start();
    await companion.shutdownOnExit();

    expect(killed).toEqual([4_242]);
  });

  it("没有拉起过的桌宠不跟着退出", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    writeOwned(dataDir, { pid: 999_999 });
    const killed: number[] = [];

    const companion = makeCompanion({
      dataDir,
      isPidAliveImpl: () => false,
      killTreeImpl: async (pid) => {
        killed.push(pid);
        return true;
      },
    });

    await expect(companion.shutdownOnExit()).resolves.toBeUndefined();
    expect(killed).toEqual([]);
  });

  it("说话走桌宠页面里的 fetch，令牌由它自己注入", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    writeOwned(dataDir, { pid: process.pid, port: 55_543 });
    const expressions: string[] = [];
    const debugPorts: number[] = [];

    const companion = makeCompanion({
      dataDir,
      isPidAliveImpl: () => true,
      evaluateImpl: async (debugPort, expression) => {
        debugPorts.push(debugPort);
        expressions.push(expression);
        return { ok: true };
      },
    });

    await companion.say("今天先休息吧。", { durationMs: 3_000, animate: false });

    expect(debugPorts).toEqual([9333]);
    expect(expressions).toHaveLength(1);
    const expression = expressions[0] ?? "";
    expect(expression).toContain("/dsh-pet-7340/broadcast");
    expect(expression).toContain("今天先休息吧。");
    expect(expression).toContain('"duration":3000');
    expect(expression).toContain('"anim":false');
    expect(expression).toContain("/dsh-pet-7340/lock");
  });

  it("桌宠拒绝说话时把原因透传出来", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    writeOwned(dataDir, { pid: process.pid });

    const companion = makeCompanion({
      dataDir,
      isPidAliveImpl: () => true,
      evaluateImpl: async () => ({
        ok: false,
        reason: "locked",
        message: "桌宠正忙。",
      }),
    });

    await expect(companion.say("喂")).rejects.toMatchObject({
      reason: "locked",
      message: "桌宠正忙。",
    });
  });

  it("桌宠没在运行时说话会明确报 not-running", async () => {
    fakeHome();
    const companion = makeCompanion();

    await expect(companion.say("喂")).rejects.toMatchObject({
      reason: "not-running",
    });
  });

  it("空白台词直接拒绝", async () => {
    fakeHome();
    const companion = makeCompanion();

    await expect(companion.say("   ")).rejects.toBeInstanceOf(PetCompanionError);
  });

  it("工作状态用 POST 写入、DELETE 清空", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    writeOwned(dataDir, { pid: process.pid });
    const expressions: string[] = [];

    const companion = makeCompanion({
      dataDir,
      isPidAliveImpl: () => true,
      evaluateImpl: async (_debugPort, expression) => {
        expressions.push(expression);
        return { ok: true };
      },
    });

    await companion.work("working", "整理日志");
    await companion.clearWork();

    expect(expressions).toHaveLength(2);
    expect(expressions[0]).toContain("/dsh-pet-7340/work-status");
    expect(expressions[0]).toContain("POST");
    expect(expressions[0]).toContain("整理日志");
    expect(expressions[1]).toContain("DELETE");
  });

  it("未知动画的失败原因会透传", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    writeOwned(dataDir, { pid: process.pid });

    const companion = makeCompanion({
      dataDir,
      isPidAliveImpl: () => true,
      evaluateImpl: async () => ({
        ok: false,
        reason: "unknown-animation",
        message: "动画池里没有这个动画。",
      }),
    });

    await expect(companion.play("wave")).rejects.toMatchObject({
      reason: "unknown-animation",
    });
  });

  it("没有用户配置时用程序包自带的默认配置创建一份", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    const exeDir = makeFakePetInstall(
      JSON.stringify({
        pets: [{ id: "main", name: "蓝毛小女仆", size: 462, display: "both" }],
        trayEnabled: true,
      }),
    );

    const companion = makeCompanion({
      exePath: join(exeDir, "dsh-pet.exe"),
      dataDir,
    });

    await companion.start();

    const configPath = join(dataDir, "pet", "home", "dsh-pet", "main-config.jsonc");
    expect(existsSync(configPath)).toBe(true);
    const seeded = JSON.parse(readFileSync(configPath, "utf8")) as {
      pets: Array<{ display: string }>;
    };
    expect(seeded.pets[0]?.display).toBe("desktop");
  });

  it("程序包已解包成 resources/app 时从目录里读默认配置", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    const exeDir = makeFakePetInstall(
      JSON.stringify({ pets: [{ id: "main", name: "蓝毛小女仆", display: "none" }] }),
    );
    const resources = join(exeDir, "resources");
    // 模拟 Kotana 解包后的目录：有 app/，app.asar 被改名备份。
    const assets = join(resources, "app", "assets");
    mkdirSync(assets, { recursive: true });
    writeFileSync(
      join(assets, "config.jsonc"),
      JSON.stringify({ pets: [{ id: "main", name: "蓝毛小女仆", display: "web" }] }),
      "utf8",
    );
    rmSync(join(resources, "app.asar"), { force: true });

    const companion = makeCompanion({
      exePath: join(exeDir, "dsh-pet.exe"),
      dataDir,
    });

    await companion.start();

    const configPath = join(dataDir, "pet", "home", "dsh-pet", "main-config.jsonc");
    const seeded = JSON.parse(readFileSync(configPath, "utf8")) as {
      pets: Array<{ display: string }>;
    };
    expect(seeded.pets[0]?.display).toBe("desktop");
  });

  it("启动前把 app.asar 解包成 resources/app 并停用原包", async () => {
    fakeHome();
    const dataDir = fakeDataDir();
    const exeDir = makeFakePetInstall(
      JSON.stringify({ pets: [{ id: "main", name: "蓝毛小女仆", display: "desktop" }] }),
    );
    const resources = join(exeDir, "resources");

    const companion = makeCompanion({
      exePath: join(exeDir, "dsh-pet.exe"),
      dataDir,
    });

    await companion.start();

    expect(existsSync(join(resources, "app", "assets", "config.jsonc"))).toBe(true);
    expect(existsSync(join(resources, "app.asar"))).toBe(false);
    expect(existsSync(join(resources, "app.asar.bak-kotana"))).toBe(true);
  });

  it("程序包里读不到默认配置时只说明情况，不抛错", async () => {
    fakeHome();
    const dataDir = fakeDataDir();

    const companion = makeCompanion({ dataDir });

    await expect(companion.start()).resolves.toMatchObject({ running: true });
    expect(existsSync(join(dataDir, "pet", "home", "dsh-pet", "main-config.jsonc"))).toBe(false);
  });

  it("把子进程输出写进数据目录下的 spawn.log", async () => {
    fakeHome();
    const dataDir = fakeDataDir();

    const companion = makeCompanion({
      dataDir,
      settleMs: 10,
      spawnImpl: () => {
        const stdout = {
          listeners: [] as Array<(chunk: Buffer) => void>,
          on(_event: "data", listener: (chunk: Buffer) => void) {
            this.listeners.push(listener);
            listener(Buffer.from("gpu process crashed\n", "utf8"));
          },
        };
        return { kill: () => true, exitCode: null, stdout, stderr: null };
      },
    });

    await companion.start();

    const log = readFileSync(join(dataDir, "pet", "logs", "spawn.log"), "utf8");
    expect(log).toContain("gpu process crashed");
  });
});

/** 造一个只有 `dsh-pet.exe` 与 `resources/app.asar` 的最小安装目录。 */
function makeFakePetInstall(configJsonc: string): string {
  const root = mkdtempSync(join(tmpdir(), "kotana-pet-exe-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const resources = join(root, "resources");
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(root, "dsh-pet.exe"), "", "utf8");

  // 按 asar 的 pickle 布局拼一份最小包：头 + JSON 头 + 数据区。
  const header = {
    files: { assets: { files: { "config.jsonc": { size: Buffer.byteLength(configJsonc), offset: "0" } } } },
  };
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const head = Buffer.alloc(16);
  head.writeUInt32LE(4, 0);
  head.writeUInt32LE(8 + json.length, 4);
  head.writeUInt32LE(json.length + 4, 8);
  head.writeUInt32LE(json.length, 12);
  writeFileSync(join(resources, "app.asar"), Buffer.concat([head, json, Buffer.from(configJsonc)]));

  return root;
}
