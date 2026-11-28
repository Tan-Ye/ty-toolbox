import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { PetUpdateInfo, PetUpdateResult, PetUpdater } from "../ports/pet-updater.js";

/** 上游默认发布信息地址。 */
const DEFAULT_RELEASE_API = "https://api.github.com/repos/PC2005-cloud/dsh-pet/releases/latest";

/** 我们取哪个资源：Windows x64 独立版。 */
const DEFAULT_ASSET_NAME = "dsh-pet-win-x64.zip";

/** 下载与解压的超时时间，207 MB 的包需要给够。 */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1_000;

/** 桌宠更新失败。 */
export class PetUpdateError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "PetUpdateError";
    this.reason = reason;
  }
}

/** 执行外部命令（解压用）。 */
export type RunCommandLike = (command: string, args: readonly string[]) => Promise<void>;

/** 更新器依赖。 */
export interface DshPetUpdaterOptions {
  /** Kotana 数据目录；更新写在这里，不碰安装目录。 */
  readonly dataDir: string;
  /** 上游发布信息地址，测试或镜像时覆盖。 */
  readonly releaseApi?: string;
  /** 资源名，默认 `dsh-pet-win-x64.zip`。 */
  readonly assetName?: string;
  /** 随包分发的桌宠版本；没有安装过更新时用它作为当前版本。 */
  readonly bundledVersion?: string;
  /** 注入 fetch，便于测试。 */
  readonly fetchImpl?: typeof fetch;
  /** 注入命令执行器，便于测试。 */
  readonly runCommand?: RunCommandLike;
}

/**
 * 基于 GitHub Releases 的桌宠更新器。
 *
 * 流程：查 releases/latest → 下载 zip 到 `<dataDir>/pet/downloads` →
 * 解压到 `<dataDir>/pet/versions/<tag>` → 写指针 `<dataDir>/pet/current.json`。
 * 安装目录始终保持原样，所以更新不需要管理员权限。
 */
export class DshPetUpdater implements PetUpdater {
  private readonly dataDir: string;
  private readonly releaseApi: string;
  private readonly assetName: string;
  private readonly bundledVersion: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly runCommand: RunCommandLike;
  private lastInfo: PetUpdateInfo | null = null;

  constructor(options: DshPetUpdaterOptions) {
    this.dataDir = options.dataDir;
    this.releaseApi = options.releaseApi ?? DEFAULT_RELEASE_API;
    this.assetName = options.assetName ?? DEFAULT_ASSET_NAME;
    this.bundledVersion = options.bundledVersion;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runCommand = options.runCommand ?? defaultRunCommand;
  }

  async check(): Promise<PetUpdateInfo> {
    const response = await this.fetchImpl(this.releaseApi, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "kotana-runtime",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new PetUpdateError(
        "check-failed",
        `检查桌宠更新失败（HTTP ${response.status}），可能是网络或 GitHub 限流。`,
      );
    }

    const release = (await response.json()) as {
      tag_name?: unknown;
      published_at?: unknown;
      assets?: unknown;
    };
    const latest = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
    if (latest.length === 0) {
      throw new PetUpdateError("check-failed", "上游发布信息里没有版本号。");
    }

    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find(
      (item): item is { name: string; browser_download_url: string } =>
        typeof item === "object" &&
        item !== null &&
        (item as { name?: unknown }).name === this.assetName &&
        typeof (item as { browser_download_url?: unknown }).browser_download_url === "string",
    );

    const current = await this.currentVersion();
    const info: PetUpdateInfo = {
      current,
      latest,
      needsUpdate: compareVersions(latest, current) > 0,
      downloadUrl: asset?.browser_download_url ?? null,
      ...(typeof release.published_at === "string" ? { publishedAt: release.published_at } : {}),
    };
    this.lastInfo = info;
    return info;
  }

  async install(target?: PetUpdateInfo): Promise<PetUpdateResult> {
    const info = target ?? this.lastInfo;
    if (info === null) {
      throw new PetUpdateError("not-checked", "还没有检查过更新，请先点「检查更新」。");
    }
    if (info.downloadUrl === null) {
      throw new PetUpdateError(
        "asset-missing",
        `上游版本 ${info.latest} 没有提供 ${this.assetName}，可能还在打包。`,
      );
    }

    const version = info.latest;
    const versionsDir = resolve(this.dataDir, "pet", "versions");
    const targetDir = join(versionsDir, sanitizeVersion(version));
    await mkdir(versionsDir, { recursive: true });

    const existing = await findExe(targetDir);
    if (existing !== null) {
      // 已经装过同一个版本：直接指过去，不重复下载 200 MB。
      return this.activate(version, existing);
    }

    const zipPath = join(resolve(this.dataDir, "pet", "downloads"), `${sanitizeVersion(version)}.zip`);
    await mkdir(dirname(zipPath), { recursive: true });
    await this.download(info.downloadUrl, zipPath);

    await mkdir(targetDir, { recursive: true });
    await this.extract(zipPath, targetDir);

    const exePath = await findExe(targetDir);
    if (exePath === null) {
      throw new PetUpdateError(
        "extract-failed",
        `解压完成但没找到 dsh-pet.exe，请手动检查 ${targetDir}。`,
      );
    }

    return this.activate(version, exePath);
  }

  /** 写指针文件，后续启动优先用它。 */
  private async activate(version: string, exePath: string): Promise<PetUpdateResult> {
    const pointer = resolve(this.dataDir, "pet", "current.json");
    const payload = {
      schemaVersion: 1,
      type: "pet-install",
      version,
      exePath,
      installedAt: new Date().toISOString(),
    };
    const temp = `${pointer}.tmp`;
    await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await rename(temp, pointer);
    return { version, exePath };
  }

  /** 下载到本地文件；用流写盘，避免把 200 MB 全塞进内存。 */
  private async download(url: string, target: string): Promise<void> {
    const response = await this.fetchImpl(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new PetUpdateError(
        "download-failed",
        `下载桌宠安装包失败（HTTP ${response.status}）。`,
      );
    }
    if (response.body === null) {
      throw new PetUpdateError("download-failed", "下载响应没有内容。");
    }

    const temp = `${target}.part`;
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(temp),
    );
    await rename(temp, target);
  }

  /** 解压：优先用 Windows 自带的 tar，失败再退回 PowerShell。 */
  private async extract(zipPath: string, targetDir: string): Promise<void> {
    try {
      await this.runCommand("tar", ["-xf", zipPath, "-C", targetDir]);
      return;
    } catch {
      await this.runCommand("powershell", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${targetDir}' -Force`,
      ]);
    }
  }

  /** 当前生效版本：已安装的指针优先，其次随包版本。 */
  private async currentVersion(): Promise<string> {
    try {
      const raw = await readFile(resolve(this.dataDir, "pet", "current.json"), "utf8");
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
        return parsed.version.trim();
      }
    } catch {
      // 文件不存在或损坏都按「没装过更新」处理。
    }
    return this.bundledVersion?.trim() || "unknown";
  }
}

/** 默认命令执行器。 */
async function defaultRunCommand(command: string, args: readonly string[]): Promise<void> {
  const { execFile } = await import("node:child_process");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(command, [...args], { windowsHide: true, timeout: DOWNLOAD_TIMEOUT_MS }, (error) => {
      if (error) {
        rejectPromise(error);
        return;
      }
      resolvePromise();
    });
  });
}

/** 在目录及下一层里找 dsh-pet.exe（上游 zip 可能带一层版本目录）。 */
async function findExe(dir: string): Promise<string | null> {
  const direct = join(dir, "dsh-pet.exe");
  if (await isFile(direct)) return direct;

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const nested = join(dir, entry, "dsh-pet.exe");
    if (await isFile(nested)) return nested;
  }
  return null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

/** 版本目录名只保留安全字符。 */
function sanitizeVersion(version: string): string {
  return version.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/**
 * 比较两个版本号，返回 -1 / 0 / 1。
 *
 * 只处理常见的 `v1.2.3` / `1.2.3` 形式；两边都解析不出数字时按字符串相等处理。
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 把 `v0.4.9` 解析成 [0, 4, 9]。 */
function parseVersion(value: string): number[] {
  return value
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}
