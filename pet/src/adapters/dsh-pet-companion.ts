import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { extractAsar, readAsarEntry, stripJsonComments } from "./asar.js";
import { evaluatePetPage } from "./cdp.js";
import type {
  PetCompanion,
  PetCompanionStatus,
  PetSayOptions,
  PetWorkState,
} from "../ports/pet-companion.js";

/** dsh-pet 注册在自己的 Web 服务上的路由前缀。 */
const API_PREFIX = "/dsh-pet-7340";

/** 独立模式默认端口；真实端口由页面里的 configUrl 决定。 */
const DEFAULT_PORT = 3_080;

/** 取锁时长；一次「说话」几秒内必完，取 60 秒足够且不会长期占着。 */
const LOCK_TTL_MS = 60_000;

/** 拉起后只观察这么久，看它有没有立刻退出；不等健康检查。 */
const START_SETTLE_MS = 1_500;

/** 等页面把真实端口告诉我们；超过这个时间就先当作「还在加载」。 */
const PORT_WAIT_MS = 15_000;

/** 等进程退出的轮询间隔。 */
const KILL_POLL_MS = 150;

/** 结束进程后最多等这么久，确认它真的退出。 */
const KILL_WAIT_MS = 3_000;

/** 记录「这一只是 Kotana 拉起的」，宿主重启后靠它认领。 */
const OWNED_FILE_NAME = "owned.json";

/** 当前记录格式的版本号。 */
const OWNED_SCHEMA_VERSION = 1;

/** 调用方自己注入的 fetch，便于测试。 */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** 调用方自己注入的进程启动函数，便于测试。 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options?: { readonly env?: NodeJS.ProcessEnv },
) => ChildLike;

/** 只要能用 kill 结束，就够本适配器用了。 */
export interface ChildLike {
  kill(signal?: NodeJS.Signals): boolean;
  readonly exitCode: number | null;
  /** 子进程 pid；测试里的假进程可以不提供。 */
  readonly pid?: number | undefined;
  /** 子进程输出；测试里的假进程可以不提供。 */
  readonly stdout?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
  readonly stderr?: { on(event: "data", listener: (chunk: Buffer) => void): void } | null;
}

/** 在桌宠页面里执行表达式；默认实现走 CDP。 */
export type EvaluateLike = (debugPort: number, expression: string) => Promise<unknown>;

/** 结束整棵进程树；返回是否成功发出结束信号。 */
export type KillTreeLike = (pid: number) => Promise<boolean>;

/** 桌宠程序返回的业务失败（HTTP 200 + `ok: false`）。 */
export class PetCompanionError extends Error {
  constructor(
    /** 机器可读的失败原因，例如 `unknown-pet`、`locked`。 */
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "PetCompanionError";
  }
}

/** dsh-pet 独立模式适配器的配置。 */
export interface DshPetCompanionOptions {
  /** 桌宠程序路径；未配置时只能读状态，不能启动。 */
  readonly exePath?: string;
  /** 期望端口，默认 3080。 */
  readonly port?: number;
  /** 桌宠实例 id，默认 `main`。 */
  readonly petId?: string;
  /** 注入的进程启动实现。 */
  readonly spawnImpl?: SpawnLike;
  /**
   * Kotana 的数据目录。
   *
   * 给 dsh-pet 单独准备 `<dataDir>/pet/home` 与 `<dataDir>/pet/appdata`：
   * 配置、日志、运行时状态和 Chromium profile 都落在 Kotana 自己的目录里，
   * 不会和用户另外安装的 dsh-pet（DSH 那套，用 `~/.dsh` 与 `%APPDATA%\dsh-pet`）互相抢。
   */
  readonly dataDir?: string;
  /** 拉起后观察多久算「没有立刻退出」，默认 1.5 秒。 */
  readonly settleMs?: number;
  /**
   * 追加给桌宠的命令行参数。
   *
   * 默认取环境变量 `KOTANA_PET_ARGS`（空格分隔），用来在个别机器上
   * 传 Chromium 开关（例如 `--disable-gpu-sandbox`）排查启动问题。
   */
  readonly extraArgs?: readonly string[];
  /** 固定的调试端口；不传时每次启动挑一个空闲端口。主要给测试用。 */
  readonly debugPort?: number;
  /** 注入的页面执行器；默认走 CDP。 */
  readonly evaluateImpl?: EvaluateLike;
  /** 注入的进程树结束实现；默认 Windows 用 taskkill /T /F。 */
  readonly killTreeImpl?: KillTreeLike;
  /** 注入的进程存活判断；默认 `process.kill(pid, 0)`。 */
  readonly isPidAliveImpl?: (pid: number) => boolean;
  /** 启动后等页面报端口的时长；默认 15 秒，测试可以传 0。 */
  readonly portWaitMs?: number;
}

/** Kotana 记录下来的、由自己拉起的桌宠。 */
interface OwnedPetState {
  readonly schemaVersion: number;
  readonly pid: number;
  readonly debugPort: number;
  readonly port: number | null;
  readonly startedAt: string;
}

/** 环境变量里常见的空值写法。 */
const EMPTY_VALUES = new Set(["", "none", "off", "false", "0"]);

/**
 * 桌宠在 Kotana 数据目录里的两个位置。
 *
 * `home` 给 dsh-pet 当 `DSH_HOME`（配置、日志、运行时状态），
 * `appData` 给它当 `APPDATA`（Chromium profile）。
 * 两者都在 `KOTANA_DATA_DIR` 之下，跟着运行数据一起迁移或清理。
 */
export function petStoragePaths(dataDir: string): {
  readonly home: string;
  readonly appData: string;
} {
  const petRoot = join(dataDir, "pet");
  return { home: join(petRoot, "home"), appData: join(petRoot, "appdata") };
}

/**
 * 必须从桌宠子进程环境里去掉的变量。
 *
 * - `ELECTRON_RUN_AS_NODE`：会让 `dsh-pet.exe` 退化成纯 node 进程，秒退且没有输出；
 * - `ELECTRON_NO_ATTACH_CONSOLE`：影响 Electron 附加控制台的行为；
 * - `NODE_OPTIONS`：可能带 `--require` 之类的 Node 参数，Electron 启动时同样会读，
 *   一旦指向桌面环境不存在的模块就会启动失败。
 */
const ELECTRON_STRIPPED_KEYS = [
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "NODE_OPTIONS",
] as const;

/** 复制一份环境变量，并去掉只对 Node 有意义的那些。 */
export function sanitizeElectronEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of ELECTRON_STRIPPED_KEYS) {
    delete next[key];
  }
  return next;
}

/**
 * 把 `KOTANA_PET_ARGS` 拆成参数数组。
 *
 * 只按空白切分（够用就行），空串返回空数组。
 * 它存在的意义是让个别机器能临时加 Chromium 开关排查启动问题，不改变默认行为。
 */
export function splitArgs(raw: string | undefined): string[] {
  const trimmed = raw?.trim() ?? "";
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

/** 环境变量里的「开」怎么判断：只要不是空 / none / off / false / 0 就算开。 */
function isTruthyValue(raw: string | undefined): boolean {
  const trimmed = raw?.trim() ?? "";
  return trimmed.length > 0 && !EMPTY_VALUES.has(trimmed.toLowerCase());
}

/**
 * 是否是 Chromium 沙箱起不来导致的崩溃。
 *
 * `0x80000003` 是 STATUS_BREAKPOINT：非管理员账号下沙箱初始化失败时，
 * Electron 会在建窗口之前这样退出（用户实测管理员身份可以正常启动）。
 */
export function isSandboxCrash(exitCode: number): boolean {
  return (exitCode >>> 0) === 0x80000003;
}

/**
 * 清掉上一次崩溃残留的 Chromium 单实例锁。
 *
 * 正常退出时 Chromium 会自己删；进程被强杀就会留下锁文件，
 * 下一次启动会报 "Lock file can not be created" 或直接当作已有实例退出。
 */
export function removeStaleSingleton(profileDir: string): void {
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
    try {
      unlinkSync(join(profileDir, name));
    } catch {
      // 不存在就算了。
    }
  }
}

/**
 * 把 dsh-pet 的独立模式当成外部伴侣进程使用。
 *
 * 它是别人的程序：我们只负责「拉起进程」和调用它公开的 `/dsh-pet-7340` 接口，
 * 不校验它什么时候算启动完成，也不读写它的素材与记忆。
 *
 * 绿色版 dsh-pet 是 Electron 应用，写接口要求渲染端令牌；Kotana 通过它自己的
 * 调试端口在页面里代发请求（见 cdp.ts），进程则按自己记录的 pid 收尾。
 */
export class DshPetCompanion implements PetCompanion {
  private exePath: string | undefined;

  private readonly petId: string;

  private readonly spawnImpl: SpawnLike;

  private readonly settleMs: number;

  /** Kotana 给桌宠准备的 DSH_HOME；未配置数据目录时为 undefined。 */
  private readonly homeDir: string | undefined;

  /** Kotana 给桌宠准备的 Chromium profile 根目录；未配置时为 undefined。 */
  private readonly appDataDir: string | undefined;

  /** Kotana 存桌宠诊断日志（子进程输出）的目录；未配置时为 undefined。 */
  private readonly logDir: string | undefined;

  /** 追加给桌宠的命令行参数（`KOTANA_PET_ARGS` 或显式传入）。 */
  private readonly extraArgs: readonly string[];

  /** Kotana 的数据目录；用来放 owned.json。 */
  private readonly dataDir: string | undefined;

  /** 注入的页面执行器。 */
  private readonly evaluateImpl: EvaluateLike;

  /** 注入的进程树结束实现。 */
  private readonly killTreeImpl: KillTreeLike;

  /** 注入的进程存活判断。 */
  private readonly isPidAliveImpl: (pid: number) => boolean;

  /** 启动后等端口的时间。 */
  private readonly portWaitMs: number;

  /** 固定调试端口；不传则每次启动挑空闲端口。 */
  private readonly fixedDebugPort: number | undefined;

  /** 最近一次已知的服务端口；真实值由页面里的 configUrl 决定。 */
  private port: number;

  /** 最近一次使用的调试端口。 */
  private debugPort: number | undefined;

  /** 从 owned.json 认领的 pid（宿主重启后没有 child 句柄）。 */
  private ownedPid: number | undefined;

  /** 本进程启动的子进程；外部启动的为 null。 */
  private child: ChildLike | null = null;

  /** 是否由本进程拉起；退出时只关自己拉起的，用户自己开的不动。 */
  private ownsChild = false;

  constructor(options: DshPetCompanionOptions = {}) {
    const exePath = options.exePath?.trim() ?? "";
    this.exePath = EMPTY_VALUES.has(exePath.toLowerCase()) ? undefined : exePath;
    this.petId = options.petId?.trim() || "main";
    this.port = options.port ?? DEFAULT_PORT;
    const dataDir = options.dataDir?.trim();
    this.dataDir =
      dataDir === undefined || dataDir.length === 0 ? undefined : dataDir;
    const storage =
      this.dataDir === undefined ? undefined : petStoragePaths(this.dataDir);
    this.homeDir = storage?.home;
    this.appDataDir = storage?.appData;
    this.logDir =
      this.dataDir === undefined ? undefined : join(this.dataDir, "pet", "logs");
    this.spawnImpl =
      options.spawnImpl ??
      ((command, args, spawnOptions) =>
        spawn(command, [...args], {
          stdio: ["ignore", "pipe", "pipe"],
          ...(spawnOptions?.env === undefined ? {} : { env: spawnOptions.env }),
        }) as ChildProcess);
    this.settleMs = options.settleMs ?? START_SETTLE_MS;
    this.extraArgs = options.extraArgs ?? splitArgs(process.env.KOTANA_PET_ARGS);
    this.debugPort = undefined;
    this.fixedDebugPort = options.debugPort;
    this.evaluateImpl =
      options.evaluateImpl ??
      ((debugPort, expression) => evaluatePetPage(debugPort, expression));
    this.killTreeImpl = options.killTreeImpl ?? killProcessTree;
    this.isPidAliveImpl = options.isPidAliveImpl ?? isPidAlive;
    this.portWaitMs = options.portWaitMs ?? PORT_WAIT_MS;
  }

  async status(): Promise<PetCompanionStatus> {
    const running = this.isRunning();
    return {
      configured: this.exePath !== undefined,
      running,
      port: running && this.portKnown ? this.port : null,
      petId: this.petId,
      message: this.describeStatus(running),
    };
  }

  async start(): Promise<PetCompanionStatus> {
    if (this.exePath === undefined) {
      throw new PetCompanionError(
        "not-configured",
        "还没有设置桌宠程序路径。请在设置里填入 dsh-pet.exe 的绝对路径。",
      );
    }

    if (this.isRunning()) {
      return {
        configured: true,
        running: true,
        port: this.portKnown ? this.port : null,
        petId: this.petId,
        message: this.portKnown
          ? `桌宠已经在运行（端口 ${this.port}）。`
          : "桌宠已经在运行，正在等它加载完成。",
      };
    }

    this.prepareBundle();
    const configNote = this.ensureDesktopDisplay();
    const debugPort = this.fixedDebugPort ?? (await findFreePort());
    this.debugPort = debugPort;
    const baseArgs = this.chromiumArgs(debugPort);
    const forceNoSandbox =
      isTruthyValue(process.env.KOTANA_PET_NO_SANDBOX) || baseArgs.includes("--no-sandbox");

    let exitCode = await this.launch(forceNoSandbox ? [...baseArgs, "--no-sandbox"] : baseArgs);
    let sandboxFallback = false;

    // 非管理员账号下 Chromium 的沙箱偶尔起不来，表现就是 0x80000003（STATUS_BREAKPOINT）。
    // 用户实测「以管理员身份运行就能起来」，所以这里自动用 --no-sandbox 再试一次。
    if (exitCode !== null && !forceNoSandbox && isSandboxCrash(exitCode)) {
      this.child = null;
      sandboxFallback = true;
      exitCode = await this.launch([...baseArgs, "--no-sandbox"]);
    }

    if (exitCode !== null) {
      this.child = null;
      throw new PetCompanionError(
        "start-failed",
        `桌宠程序启动后立刻退出（退出码 ${exitCode}）。${this.describeStartFailure(configNote)}`,
      );
    }

    // 启动后从渲染页面里拿真实服务端口；拿不到也不阻塞启动，
    // 后续说话时再通过调试端口重试。
    const realPort = await this.waitForPort(debugPort);
    if (realPort !== null) {
      this.port = realPort;
      this.portKnown = true;
    }

    this.ownsChild = true;
    const pid = this.child?.pid;
    if (pid !== undefined) {
      this.ownedPid = pid;
      this.writeOwned({
        schemaVersion: OWNED_SCHEMA_VERSION,
        pid,
        debugPort,
        port: this.portKnown ? this.port : null,
        startedAt: new Date().toISOString(),
      });
    }

    const loaded = this.portKnown;
    return {
      configured: true,
      running: true,
      port: loaded ? this.port : null,
      petId: this.petId,
      message: `${sandboxFallback ? "桌宠已拉起（兼容模式，关闭了 Chromium 沙箱）" : "桌宠已拉起"}${
        loaded ? `（端口 ${this.port}），加载完成后就能说话。` : "，还在加载，稍后再试说一句。"
      }`,
    };
  }

  /**
   * 拉起桌宠用的参数。
   *
   * `--user-data-dir` 是给 Chromium 的：dsh-pet 自己按 `%APPDATA%` 一系列路径找 profile，
   * 如果那个目录被别的实例（尤其是以管理员身份启动过的那只）建过，
   * 普通权限就拿不到 Chromium 的单实例锁，日志里会出现
   * `process_singleton_win.cc … Lock file can not be created! Error code: 5`，
   * 表现就是「启动后立刻退出（退出码 0）」。明确指定 profile 目录后，
   * Kotana 的桌宠只用自己数据目录里的那一份，也不再和别的实例互相锁死。
   *
   * `--remote-debugging-port` 是本适配器新增的：绿色版 dsh-pet 的写接口要求
   * 渲染端协商出的令牌，只有页面里的 `fetch` 会带上；Kotana 用它代发指令。
   */
  private chromiumArgs(debugPort: number): string[] {
    const args = [
      "--port",
      String(this.port),
      `--remote-debugging-port=${debugPort}`,
      ...this.extraArgs,
    ];
    if (this.appDataDir !== undefined) {
      const profile = join(this.appDataDir, "profile");
      try {
        mkdirSync(profile, { recursive: true });
        removeStaleSingleton(profile);
      } catch {
        // 建不出来就让 dsh-pet 自己报错，失败信息里会有日志。
      }
      args.push(`--user-data-dir=${profile}`);
    }
    return args;
  }

  /** 拉起一次并等 settle：返回退出码，没退出返回 null。 */
  private async launch(args: readonly string[]): Promise<number | null> {
    if (this.exePath === undefined) {
      return null;
    }

    this.child = this.spawnImpl(this.exePath, args, { env: this.childEnvironment() });
    this.captureSpawnOutput(this.child);

    // 只确认它没有立刻崩溃；Electron 加载多久是它自己的事。
    await delay(this.settleMs);
    return this.child?.exitCode ?? null;
  }

  /**
   * 结束桌宠：连同它的 Electron 子进程一起杀。
   *
   * 绿色版没有可用的 `/shutdown` 令牌，所以不再走 HTTP；只结束 Kotana
   * 自己拉起的整棵进程树（Windows 上是 `taskkill /T /F`）。
   * 已经退出时是幂等的，不抛错。
   */
  async stop(): Promise<void> {
    const owned = this.readOwned();
    const pid = owned?.pid ?? this.ownedPid ?? this.child?.pid;
    this.clearOwned();
    this.ownedPid = undefined;

    if (pid === undefined) {
      this.killChild();
      return;
    }

    const aliveBefore = this.isPidAliveImpl(pid);
    await this.killTreeImpl(pid).catch(() => false);
    await this.waitForExit(pid);
    this.killChild();

    if (aliveBefore && this.isPidAliveImpl(pid)) {
      throw new PetCompanionError(
        "stop-failed",
        `没能结束桌宠进程（PID ${pid}），请在任务管理器里关掉它。`,
      );
    }

    this.portKnown = false;
  }

  async say(text: string, options: PetSayOptions = {}): Promise<void> {
    const content = text.trim();
    if (content.length === 0) {
      throw new PetCompanionError("empty-text", "要说的内容是空的。");
    }

    await this.runInPage(
      this.lockedExpression("broadcast", {
        text: content,
        duration: options.durationMs ?? 8_000,
        anim: options.animate ?? true,
      }),
    );
  }

  async work(state: PetWorkState, task?: string | null): Promise<void> {
    const body: Record<string, unknown> = { state };
    if (task !== undefined) body.task = task;

    await this.runInPage(this.commandExpression("POST", "work-status", body));
  }

  async clearWork(): Promise<void> {
    await this.runInPage(this.commandExpression("DELETE", "work-status"));
  }

  async play(animation: string): Promise<void> {
    const name = animation.trim();
    if (name.length === 0) {
      throw new PetCompanionError("empty-animation", "动画名是空的。");
    }

    await this.runInPage(this.lockedExpression("anim", { name }));
  }

  /** 更新装好后指向新版本；下次启动就用它。 */
  reconfigure(exePath: string | undefined): void {
    const trimmed = exePath?.trim() ?? "";
    this.exePath =
      trimmed.length === 0 || EMPTY_VALUES.has(trimmed.toLowerCase()) ? undefined : trimmed;
  }

  /** 最近一次已知的端口是否可信。 */
  private portKnown = false;

  /**
   * 页面里取配置、算宠物和 surface 的公共前缀。
   *
   * 这段代码在桌宠自己的渲染页面里执行：`fetch` 会由 dsh-pet 的
   * `installDesktopAuth` 自动补上 `x-dsh-pet-token`，Kotana 拿不到令牌也能说话。
   */
  private pagePreamble(): string {
    return `const configUrl = new URLSearchParams(location.search).get('configUrl');
  if (!configUrl) return { ok: false, reason: 'no-config-url', message: '桌宠页面没有配置地址。' };
  const base = new URL(configUrl).origin;
  const config = await (await fetch(base + '${API_PREFIX}/config')).json();
  // 绿色版返回的是按宠物 id 分组的对象（每项里带自己的 pets 数组），
  // 旧形态则是顶层 pets 数组；两种都认。
  const pets = Array.isArray(config.pets)
    ? config.pets
    : Object.values(config).flatMap((entry) =>
        entry && Array.isArray(entry.pets) ? entry.pets : entry && entry.id ? [entry] : []
      );
  const petId = ${JSON.stringify(this.petId)};
  const pet = pets.find((item) => item && item.id === petId) || pets[0];
  if (!pet) return { ok: false, reason: 'unknown-pet', message: '桌宠里没有可以说话的宠物。' };
  const surface = pet.display === 'web' ? 'web' : pet.display === 'both' ? 'both' : 'desktop';
  const query = (extra) => {
    const params = new URLSearchParams({ pet: String(pet.id), surface });
    for (const key of Object.keys(extra || {})) params.set(key, extra[key]);
    return params.toString();
  };
  const headers = { 'content-type': 'application/json' };`;
  }

  /** 先取锁、再执行动作、最后释放锁；用于广播和播动画。 */
  private lockedExpression(action: string, body: Record<string, unknown>): string {
    return `(async () => {
  ${this.pagePreamble()}
  const lock = await (await fetch(base + '${API_PREFIX}/lock?' + query({}), {
    method: 'POST', headers, body: JSON.stringify({ ttl: ${LOCK_TTL_MS} })
  })).json();
  if (lock.ok === false) {
    return { ok: false, reason: lock.reason || 'lock-failed', message: lock.message || '桌宠没有把占用锁交给 Kotana。' };
  }
  try {
    return await (await fetch(base + '${API_PREFIX}/${action}?' + query({ lock: lock.lockId }), {
      method: 'POST', headers, body: JSON.stringify(${JSON.stringify(body)})
    })).json();
  } finally {
    await fetch(base + '${API_PREFIX}/lock/release?' + query({}), {
      method: 'POST', headers, body: JSON.stringify({ lockId: lock.lockId })
    }).catch(() => undefined);
  }
})()`;
  }

  /** 不需要锁的动作（工作状态等）。 */
  private commandExpression(
    method: "POST" | "DELETE",
    action: string,
    body?: Record<string, unknown>,
  ): string {
    const payload =
      body === undefined ? "" : `, body: JSON.stringify(${JSON.stringify(body)})`;
    return `(async () => {
  const configUrl = new URLSearchParams(location.search).get('configUrl');
  if (!configUrl) return { ok: false, reason: 'no-config-url', message: '桌宠页面没有配置地址。' };
  const base = new URL(configUrl).origin;
  const url = base + '${API_PREFIX}/${action}?pet=' + encodeURIComponent(${JSON.stringify(this.petId)});
  const response = await fetch(url, {
    method: '${method}',
    headers: { 'content-type': 'application/json' }${payload}
  });
  return await response.json();
})()`;
  }

  /** 在页面里执行表达式，并把 `ok: false` 转成异常。 */
  private async runInPage<T extends { ok?: unknown; reason?: unknown; message?: unknown }>(
    expression: string,
  ): Promise<T> {
    const debugPort = this.requireDebugPort();

    let result: unknown;
    try {
      result = await this.evaluateImpl(debugPort, expression);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PetCompanionError("not-running", `桌宠没有响应：${detail}`);
    }

    if (typeof result !== "object" || result === null) {
      throw new PetCompanionError("invalid-response", "桌宠返回了无法解析的结果。");
    }

    const data = result as { ok?: unknown; reason?: unknown; message?: unknown };
    if (data.ok === false) {
      const reason = typeof data.reason === "string" ? data.reason : "pet-error";
      const message =
        typeof data.message === "string" ? data.message : `桌宠拒绝了请求：${reason}`;
      throw new PetCompanionError(reason, message);
    }

    return data as T;
  }

  /** 说话/播动画需要调试端口；没有就说明它没在运行。 */
  private requireDebugPort(): number {
    const owned = this.readOwned();
    if (owned !== null && this.isPidAliveImpl(owned.pid)) {
      this.debugPort = owned.debugPort;
      return owned.debugPort;
    }
    if (this.child !== null && this.child.exitCode === null && this.debugPort !== undefined) {
      return this.debugPort;
    }
    if (this.debugPort !== undefined && this.portKnown) {
      return this.debugPort;
    }
    throw new PetCompanionError(
      "not-running",
      "桌宠没有在运行。请先在设置里启动桌宠。",
    );
  }

  /** 它是否在运行：优先看 Kotana 自己记的 pid，其次看本进程拉起的子进程。 */
  private isRunning(): boolean {
    const owned = this.readOwned();
    if (owned !== null) {
      if (this.isPidAliveImpl(owned.pid)) {
        this.ownedPid = owned.pid;
        this.debugPort = owned.debugPort;
        if (owned.port !== null) {
          this.port = owned.port;
          this.portKnown = true;
        }
        return true;
      }
      // 进程已经不在了：清掉陈旧记录，避免下次误判。
      this.clearOwned();
    }

    if (this.child === null) return false;
    const alive =
      this.child.pid === undefined
        ? this.child.exitCode === null
        : this.isPidAliveImpl(this.child.pid);
    if (!alive) return false;

    if (this.child.pid !== undefined) this.ownedPid = this.child.pid;
    return true;
  }

  /** 等页面把真实端口报出来；超时返回 null。 */
  private async waitForPort(debugPort: number): Promise<number | null> {
    if (this.portWaitMs <= 0) return null;

    const deadline = Date.now() + this.portWaitMs;
    do {
      try {
        const value = await this.evaluateImpl(debugPort, this.portExpression());
        const port = typeof value === "number" ? value : Number(value);
        if (Number.isInteger(port) && port > 0) return port;
      } catch {
        // 页面还没加载好，继续等。
      }
      if (Date.now() >= deadline) break;
      await delay(KILL_POLL_MS);
    } while (Date.now() < deadline);

    return null;
  }

  /** 从页面 URL 的 configUrl 里读真实端口。 */
  private portExpression(): string {
    return `(() => {
  const configUrl = new URLSearchParams(location.search).get('configUrl');
  if (!configUrl) return 0;
  try { return Number(new URL(configUrl).port); } catch { return 0; }
})()`;
  }

  /** 等进程退出；最多等 KILL_WAIT_MS。 */
  private async waitForExit(pid: number): Promise<void> {
    const deadline = Date.now() + KILL_WAIT_MS;
    while (Date.now() < deadline) {
      if (!this.isPidAliveImpl(pid)) return;
      await delay(KILL_POLL_MS);
    }
  }

  /** 读 Kotana 自己记的桌宠进程。 */
  private readOwned(): OwnedPetState | null {
    const file = this.ownedFilePath();
    if (file === undefined) return null;

    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as {
        pid?: unknown;
        debugPort?: unknown;
        port?: unknown;
        startedAt?: unknown;
      };
      if (typeof raw.pid !== "number") return null;
      if (typeof raw.debugPort !== "number") return null;

      return {
        schemaVersion: OWNED_SCHEMA_VERSION,
        pid: raw.pid,
        debugPort: raw.debugPort,
        port: typeof raw.port === "number" ? raw.port : null,
        startedAt: typeof raw.startedAt === "string" ? raw.startedAt : "",
      };
    } catch {
      return null;
    }
  }

  /** 记录 Kotana 拉起的桌宠；宿主重启后靠它认领。 */
  private writeOwned(state: OwnedPetState): void {
    const file = this.ownedFilePath();
    if (file === undefined) return;

    try {
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.tmp-kotana`;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
      renameSync(temporary, file);
    } catch {
      // 写不进去只影响跨宿主认领，不影响本次运行。
    }
  }

  /** 清掉自己记的桌宠进程。 */
  private clearOwned(): void {
    const file = this.ownedFilePath();
    if (file === undefined) return;
    try {
      unlinkSync(file);
    } catch {
      // 本来就不存在。
    }
  }

  /** owned.json 的位置。 */
  private ownedFilePath(): string | undefined {
    return this.dataDir === undefined ? undefined : join(this.dataDir, "pet", OWNED_FILE_NAME);
  }

  /** dsh-pet 的 home 目录：Kotana 自己那份优先，否则 `$DSH_HOME`，再缺省 `%USERPROFILE%\.dsh`。 */
  private dshHome(): string {
    if (this.homeDir !== undefined) {
      return this.homeDir;
    }
    const configured = process.env.DSH_HOME?.trim();
    if (configured !== undefined && configured.length > 0) {
      return configured;
    }
    return join(process.env.USERPROFILE ?? homedir(), ".dsh");
  }

  /**
   * 子进程环境。
   *
   * 把 `DSH_HOME` 和 `APPDATA` 都指到 Kotana 数据目录下：配置、日志、运行时状态
   * 写到 `<dataDir>/pet/home`，Chromium profile 写到 `<dataDir>/pet/appdata`。
   * 这样即使同时开着用户自己安装的 dsh-pet（DSH 那套），两者也不会抢同一个 profile。
   *
   * 另外必须先洗掉 `ELECTRON_RUN_AS_NODE` 这类变量：一旦被继承，
   * `dsh-pet.exe` 会把自己当成 node 跑（`--help` 打印的是 node 的用法），
   * 既不建窗口也不写日志，直接退出。
   */
  private childEnvironment(): NodeJS.ProcessEnv {
    if (this.homeDir === undefined || this.appDataDir === undefined) {
      return sanitizeElectronEnvironment(process.env);
    }

    for (const directory of [this.homeDir, this.appDataDir, join(this.homeDir, "dsh-pet")]) {
      try {
        mkdirSync(directory, { recursive: true });
      } catch {
        // 建不出来就让 dsh-pet 自己处理，失败信息里会有日志。
      }
    }

    return sanitizeElectronEnvironment({
      ...process.env,
      DSH_HOME: this.homeDir,
      APPDATA: this.appDataDir,
    });
  }

  /** dsh-pet 的日志文件；启动失败时用它说明原因。 */
  private logFilePath(): string {
    return join(this.dshHome(), "dsh-pet", "logs.txt");
  }

  /**
   * 把随包的 `app.asar` 解包成 `resources/app`。
   *
   * Electron 43 的 `createReadStream` 打不开 asar 里的文件，桌宠的素材接口
   * 会直接断开连接（桌宠全透明）。它优先加载 `resources/app`，所以解包后
   * 再把 `app.asar` 改名备份，就固定走真实文件了。已经解包过就什么都不做。
   */
  private prepareBundle(): void {
    if (this.exePath === undefined) return;
    const resources = join(dirname(this.exePath), "resources");
    const asarPath = join(resources, "app.asar");
    if (!existsSync(asarPath)) return;

    const appDir = join(resources, "app");
    const staging = join(resources, "app.kotana-extracting");
    const previous = join(resources, "app.before-kotana");

    try {
      rmSync(staging, { recursive: true, force: true });
      extractAsar(asarPath, staging);
      rmSync(previous, { recursive: true, force: true });
      if (existsSync(appDir)) renameSync(appDir, previous);
      renameSync(staging, appDir);
      rmSync(previous, { recursive: true, force: true });
    } catch (error) {
      throw new PetCompanionError(
        "unpack-failed",
        `桌宠素材包解包失败（${error instanceof Error ? error.message : String(error)}）。请确认 ${resources} 可写，或用 KOTANA_PET_EXE 指向可写目录里的 dsh-pet.exe。`,
      );
    }

    // 只有把 asar 挪走，Electron 才会用解包目录；挪不动就明确失败，别让它继续读坏包。
    try {
      rmSync(`${asarPath}.bak-kotana`, { force: true });
      renameSync(asarPath, `${asarPath}.bak-kotana`);
    } catch (error) {
      throw new PetCompanionError(
        "unpack-failed",
        `桌宠素材包解包了，但没法备份 app.asar（${error instanceof Error ? error.message : String(error)}）。桌宠可能正在运行，请先关掉它再启动。`,
      );
    }
  }

  /**
   * 确保目标宠物真的会画在桌面上。
   *
   * dsh-pet 的 `display` 决定它在哪里出现：`desktop` 是桌面挂件，
   * `web` / `none` 就只是后台进程或网页挂件。用户手里那份配置
   * 常见是 `none`（从 DSH 网页端改成桌面端之前留下的），这时即使
   * 进程跑起来也看不见任何形象，所以启动前先把目标宠物改成 `desktop`。
   *
   * 只在能安全解析时改；解析不了就原样留着，不破坏用户手写的 JSONC。
   */
  private ensureDesktopDisplay(): string {
    const file = this.userConfigPath();
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return this.seedUserConfig(file);
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
    } catch {
      // 带注释或写法很花哨的 JSONC 不硬改，用户自己配。
      return `${file} 解析不了（可能是手写 JSONC），没有改动它。`;
    }

    const pets = config.pets;
    if (!Array.isArray(pets)) return `${file} 里没有 pets 列表。`;

    let changed = false;
    for (const pet of pets) {
      if (typeof pet !== "object" || pet === null) continue;
      const record = pet as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "main";
      if (id !== this.petId && pets.length > 1) continue;
      // `both` 也会画桌面形象，只有 web / none 才是真的看不见。
      if (record.display === "desktop" || record.display === "both") continue;
      record.display = "desktop";
      changed = true;
    }

    if (!changed) return `${file} 里宠物已经会显示在桌面上。`;

    try {
      writeFileSync(`${file}.bak-kotana`, raw, "utf8");
      const temporary = `${file}.tmp-kotana`;
      writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      renameSync(temporary, file);
      return `已把 ${file} 里的 display 改成 desktop（原文件备份为 .bak-kotana）。`;
    } catch (error) {
      // 写不进去就退回原样：看不见形象总比启动失败好。
      return `想改 ${file} 但写不进去（${String(error)}）。`;
    }
  }

  /** 用户配置文件：优先 `main-config.jsonc`，旧版本是 `main-config.json`。 */
  private userConfigPath(): string {
    const dir = join(this.dshHome(), "dsh-pet");
    const modern = join(dir, "main-config.jsonc");
    try {
      readFileSync(modern, "utf8");
      return modern;
    } catch {
      const legacy = join(dir, "main-config.json");
      try {
        readFileSync(legacy, "utf8");
        return legacy;
      } catch {
        // 两个都没有：返回新文件名，供首次写入使用。
        return modern;
      }
    }
  }

  /**
   * 第一次启动时把程序自带的默认配置落到 Kotana 自己的数据目录。
   *
   * dsh-pet 没写用户配置时不会自己生成一份，而 Kotana 又给它换了
   * 独立的 `DSH_HOME`，于是它读不到任何配置。这里直接从它的
   * `resources/app.asar` 里取出 `assets/config.jsonc`（自带默认值），
   * 把宠物设成会画在桌面上，再写到 `<DSH_HOME>/dsh-pet/main-config.jsonc`。
   * 这样写出来的格式一定和它自己的解析器一致，不靠我们猜字段。
   */
  private seedUserConfig(file: string): string {
    const template = this.bundledConfigTemplate();
    if (template === null) {
      return `没有找到 ${file}，也没能从程序包里读出默认配置；它可能仍会用内置默认值启动。`;
    }

    try {
      mkdirSync(join(this.dshHome(), "dsh-pet"), { recursive: true });
      writeFileSync(file, template, "utf8");
    } catch (error) {
      return `想为桌宠创建 ${file} 但写不进去（${String(error)}）。`;
    }
    return `已按程序包自带的默认配置创建 ${file}（宠物会画在桌面上）。`;
  }

  /** 从程序包里读出自带默认配置（解包目录优先，其次 app.asar），并保证宠物是 desktop。 */
  private bundledConfigTemplate(): string | null {
    if (this.exePath === undefined) return null;
    const resources = join(dirname(this.exePath), "resources");
    let raw: string | null = null;
    try {
      raw = readFileSync(join(resources, "app", "assets", "config.jsonc"), "utf8");
    } catch {
      raw = readAsarEntry(join(resources, "app.asar"), "assets/config.jsonc");
    }
    if (raw === null) return null;

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
    } catch {
      return null;
    }

    const pets = config.pets;
    if (!Array.isArray(pets) || pets.length === 0) return null;
    for (const pet of pets) {
      if (typeof pet !== "object" || pet === null) continue;
      const record = pet as Record<string, unknown>;
      if (record.display !== "desktop") record.display = "desktop";
    }
    return `${JSON.stringify(config, null, 2)}\n`;
  }

  /** 把子进程输出写进 `<dataDir>/pet/logs/spawn.log`，崩溃时好查原因。 */
  private captureSpawnOutput(child: ChildLike): void {
    if (this.logDir === undefined) return;
    const logPath = join(this.logDir, "spawn.log");
    try {
      mkdirSync(this.logDir, { recursive: true });
      appendFileSync(logPath, `\n--- 启动 ${new Date().toISOString()}（端口 ${this.port}）---\n`, "utf8");
    } catch {
      return;
    }

    const forward = (stream: ChildLike["stdout"]): void => {
      stream?.on("data", (chunk: Buffer) => {
        try {
          appendFileSync(logPath, chunk);
        } catch {
          // 日志写不进去不影响桌宠本身。
        }
      });
    };
    forward(child.stdout);
    forward(child.stderr);
  }

  /** 读 spawn.log 末尾几行，作为启动失败时的证据。 */
  private readSpawnLogTail(lines: number): string[] {
    if (this.logDir === undefined) return [];
    try {
      const raw = readFileSync(join(this.logDir, "spawn.log"), "utf8");
      return raw
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .slice(-lines)
        .map((line) => line.trim().slice(0, 200));
    } catch {
      return [];
    }
  }

  /** 启动失败时补充可核查的原因：配置文件改没改、日志尾巴。 */
  private describeStartFailure(configNote: string): string {
    const hints: string[] = [configNote];

    const spawnTail = this.readSpawnLogTail(6);
    if (spawnTail.length > 0) {
      hints.push(`进程输出：${spawnTail.join(" / ")}`);
    }

    const tail = this.readLogTail(6);
    if (tail.length > 0) {
      hints.push(`它自己的日志：${tail.join(" / ")}`);
    }

    hints.push(
      "Kotana 用自己的数据目录跑桌宠，不和你另外安装的 dsh-pet 抢配置；它跑起来之后也可以用它的 /dsh-pet-7340/config 接口改配置。如果它起不来，多半是程序包里缺少运行库或被杀毒软件拦了。",
    );
    return hints.join(" ");
  }

  /** 读日志末尾几行；读不到就返回空。 */
  private readLogTail(lines: number): string[] {
    try {
      const raw = readFileSync(this.logFilePath(), "utf8");
      return raw
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .slice(-lines)
        .map((line) => line.trim().slice(0, 160));
    } catch {
      return [];
    }
  }

  /** Kotana 退出时收尾：只关本进程拉起的桌宠，尽力而为。 */
  async shutdownOnExit(): Promise<void> {
    const owned = this.readOwned();
    const ownsRunning =
      this.ownsChild ||
      this.child !== null ||
      (owned !== null && this.isPidAliveImpl(owned.pid));
    if (!ownsRunning) return;

    await this.stop().catch(() => undefined);
  }

  /** 结束本进程拉起的子进程；外部启动的进程不动。 */
  private killChild(): void {
    if (this.child === null) return;
    try {
      this.child.kill();
    } catch {
      // 已经退出就别再报错。
    }
    this.child = null;
    this.ownsChild = false;
  }

  /** 给界面看的状态说明。 */
  private describeStatus(running: boolean): string {
    if (this.exePath === undefined) {
      return "还没有设置桌宠程序路径。";
    }
    if (!running) {
      return "桌宠程序未运行。";
    }
    return this.portKnown ? `桌宠运行中（端口 ${this.port}）。` : "桌宠正在加载，端口还没就绪。";
  }
}

/** 进程还在不在。 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 结束整棵进程树。
 *
 * Windows 上必须用 `taskkill /T`：dsh-pet 的主进程下挂着 GPU、渲染和
 * utility 子进程，只 kill 主进程会留下一堆孤儿。
 */
async function killProcessTree(pid: number): Promise<boolean> {
  if (process.platform === "win32") {
    try {
      const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  try {
    process.kill(-pid, "SIGKILL");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      return false;
    }
  }
}

/** 挑一个空闲的回环端口给桌宠的调试协议用。 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("没有挑到空闲端口。"));
      });
    });
  });
}

/** 简单等待，避免引入额外依赖。 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
