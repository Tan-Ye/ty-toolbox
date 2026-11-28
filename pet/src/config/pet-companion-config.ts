import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 桌宠伴侣的运行配置。 */
export interface PetCompanionConfig {
  /** 是否启用外部桌宠（取代内置大肥鱼窗口）。 */
  readonly enabled: boolean;
  /** dsh-pet.exe 的绝对路径；未配置时不能启动。 */
  readonly exePath?: string;
  /** 期望端口，默认 3080。 */
  readonly port: number;
  /** 桌宠实例 id，默认 `main`。 */
  readonly petId: string;
}

/** 读取配置时的依赖。 */
export interface LoadPetCompanionConfigOptions {
  /** Kotana 数据目录。 */
  readonly dataDir: string;
  /** 环境变量读取函数，测试时可注入。 */
  readonly env?: (name: string) => string | undefined;
}

/** 默认端口，与 dsh-pet 独立模式一致。 */
const DEFAULT_PORT = 3_080;

/** 配置文件相对数据目录的位置。 */
const CONFIG_PATH = ["pet", "companion.json"];

/** 更新指针相对数据目录的位置。 */
const INSTALL_POINTER = ["pet", "current.json"];

/** 随包目录名里带版本号，例如 `dsh-pet-0.4.9-win-x64`。 */
const BUNDLED_VERSION_PATTERN = /dsh-pet-(\d+\.\d+\.\d+[^/\\]*)/i;

/** 环境变量里的空值写法。 */
const EMPTY_VALUES = new Set(["", "none", "off", "false", "0"]);

/**
 * 读取桌宠伴侣配置。
 *
 * 优先级：环境变量 > `<dataDir>/pet/companion.json` > 内置默认。
 * 配置文件损坏时按「未配置」处理：桌宠是可选件，不值得让 Runtime 起不来。
 */
export function loadPetCompanionConfig(
  options: LoadPetCompanionConfigOptions,
): PetCompanionConfig {
  const env = options.env ?? ((name: string) => process.env[name]);
  const file = readJson(resolve(options.dataDir, ...CONFIG_PATH));

  const fileExe = typeof file?.exePath === "string" ? file.exePath : undefined;
  const envExe = env("KOTANA_PET_EXE");
  // 随安装包分发时由 Rust 传入 KOTANA_PET_BUNDLED_EXE，用户不必再手填路径。
  const bundledExe = env("KOTANA_PET_BUNDLED_EXE");
  // 更新装在数据目录里，装过之后指针优先于随包版本。
  const installed = readInstalledPetExe(options.dataDir);
  const exePath =
    cleanPath(envExe) ?? cleanPath(fileExe) ?? installed?.exePath ?? cleanPath(bundledExe);

  const enabledFlag = env("KOTANA_PET_ENABLED");
  const enabled =
    enabledFlag === undefined
      ? (file?.enabled ?? true) && exePath !== undefined
      : !EMPTY_VALUES.has(enabledFlag.trim().toLowerCase());

  return {
    enabled,
    ...(exePath === undefined ? {} : { exePath }),
    port: readPort(env("KOTANA_PET_PORT") ?? file?.port),
    petId: readPetId(env("KOTANA_PET_ID") ?? file?.petId),
  };
}

/** 读取并解析 JSON；不存在或损坏都返回 null。 */
function readJson(file: string): Record<string, unknown> | null {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(content) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 空串按未配置处理。 */
function cleanPath(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/** 端口必须是 1~65535 的整数，否则回落默认值。 */
function readPort(value: unknown): number {
  const port = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : DEFAULT_PORT;
}

/** 宠物 id 只接受简单标识符，避免拼出奇怪的查询参数。 */
function readPetId(value: unknown): string {
  if (typeof value !== "string") return "main";
  const trimmed = value.trim();
  return /^[a-zA-Z0-9._-]{1,40}$/.test(trimmed) ? trimmed : "main";
}

/** 已安装更新的指针内容。 */
export interface InstalledPet {
  readonly version: string;
  readonly exePath: string;
}

/**
 * 读取 `<dataDir>/pet/current.json`。
 *
 * 更新器写完这个文件后，启动时优先用它；文件缺失或损坏都当作「没装过更新」。
 */
export function readInstalledPetExe(dataDir: string): InstalledPet | null {
  const record = readJson(resolve(dataDir, ...INSTALL_POINTER));
  const exePath = cleanPath(typeof record?.exePath === "string" ? record.exePath : undefined);
  const version = cleanPath(typeof record?.version === "string" ? record.version : undefined);
  if (exePath === undefined || version === undefined) return null;
  return { version, exePath };
}

/**
 * 从随包目录路径里解析版本号，例如 `.../dsh-pet-0.4.9-win-x64/dsh-pet.exe` → `0.4.9`。
 *
 * 解析不出来时返回 undefined，更新器会把当前版本显示成「未安装」。
 */
export function bundledPetVersion(exePath: string | undefined): string | undefined {
  if (exePath === undefined) return undefined;
  const matched = BUNDLED_VERSION_PATTERN.exec(exePath);
  return matched?.[1];
}
