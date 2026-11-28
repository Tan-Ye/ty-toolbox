import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DshPetUpdater,
  PetUpdateError,
  compareVersions,
} from "../../../src/adapters/dsh-pet-updater.js";
import type { RunCommandLike } from "../../../src/adapters/dsh-pet-updater.js";

const API = "https://api.example.test/repos/pc2005-cloud/dsh-pet/releases/latest";
const ASSET_URL = "https://download.example.test/dsh-pet-win-x64.zip";

const tempDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kotana-pet-"));
  tempDirs.push(dir);
  return dir;
}

/** 假 GitHub 发布响应。 */
function releaseResponse(tag: string, withAsset = true): Response {
  return new Response(
    JSON.stringify({
      tag_name: tag,
      published_at: "2026-11-14T00:00:00Z",
      assets: withAsset
        ? [{ name: "dsh-pet-win-x64.zip", browser_download_url: ASSET_URL }]
        : [{ name: "dsh-pet-mac-arm64.zip", browser_download_url: "https://example.test/mac.zip" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** 记录调用的解压命令：在目标目录里造一个假的 dsh-pet.exe。 */
function recordingExtractor(): { run: RunCommandLike; calls: string[][] } {
  const calls: string[][] = [];
  const run: RunCommandLike = async (command, args) => {
    calls.push([command, ...args]);
    const targetIndex = args.indexOf("-C");
    const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
    if (target !== undefined) {
      await writeFile(join(target, "dsh-pet.exe"), "fake", "utf8");
    }
  };
  return { run, calls };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("compareVersions", () => {
  it("比较带 v 前缀的版本号", () => {
    expect(compareVersions("v0.4.9", "0.4.8")).toBe(1);
    expect(compareVersions("0.4.9", "v0.4.9")).toBe(0);
    expect(compareVersions("0.4.7", "0.4.9")).toBe(-1);
  });

  it("段数不同时缺位按 0", () => {
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
    expect(compareVersions("2.0.0", "1.9.9")).toBe(1);
  });
});

describe("DshPetUpdater", () => {
  it("发现新版本时给出下载地址", async () => {
    const dataDir = await makeDataDir();
    const updater = new DshPetUpdater({
      dataDir,
      releaseApi: API,
      bundledVersion: "0.4.8",
      fetchImpl: async () => releaseResponse("v0.4.9"),
    });

    const info = await updater.check();
    expect(info.current).toBe("0.4.8");
    expect(info.latest).toBe("v0.4.9");
    expect(info.needsUpdate).toBe(true);
    expect(info.downloadUrl).toBe(ASSET_URL);
  });

  it("已是最新时不提示更新", async () => {
    const dataDir = await makeDataDir();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dataDir, "pet"), { recursive: true });
    await writeFile(
      join(dataDir, "pet", "current.json"),
      JSON.stringify({
        schemaVersion: 1,
        type: "pet-install",
        version: "0.4.9",
        exePath: "/x.exe",
      }),
      "utf8",
    );

    const updater = new DshPetUpdater({
      dataDir,
      releaseApi: API,
      bundledVersion: "0.4.8",
      fetchImpl: async () => releaseResponse("v0.4.9"),
    });

    const info = await updater.check();
    expect(info.current).toBe("0.4.9");
    expect(info.needsUpdate).toBe(false);
  });

  it("上游出错时抛出可读错误", async () => {
    const dataDir = await makeDataDir();
    const updater = new DshPetUpdater({
      dataDir,
      releaseApi: API,
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });

    await expect(updater.check()).rejects.toMatchObject({ reason: "check-failed" });
  });

  it("没检查就安装会被拒绝", async () => {
    const dataDir = await makeDataDir();
    const updater = new DshPetUpdater({ dataDir, releaseApi: API, fetchImpl: async () => releaseResponse("v0.4.9") });

    await expect(updater.install()).rejects.toBeInstanceOf(PetUpdateError);
  });

  it("上游没提供对应资产时给出明确原因", async () => {
    const dataDir = await makeDataDir();
    const updater = new DshPetUpdater({
      dataDir,
      releaseApi: API,
      fetchImpl: async () => releaseResponse("v0.4.9", false),
    });

    const info = await updater.check();
    expect(info.downloadUrl).toBeNull();
    await expect(updater.install(info)).rejects.toMatchObject({ reason: "asset-missing" });
  });

  it("安装时下载、解压并写指针；重复安装不再下载", async () => {
    const dataDir = await makeDataDir();
    const { run, calls } = recordingExtractor();
    let downloads = 0;

    const updater = new DshPetUpdater({
      dataDir,
      releaseApi: API,
      bundledVersion: "0.4.8",
      runCommand: run,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === API) return releaseResponse("v0.4.9");
        downloads += 1;
        return new Response(new Uint8Array([1, 2, 3, 4]));
      },
    });

    const info = await updater.check();
    const result = await updater.install(info);

    expect(result.version).toBe("v0.4.9");
    expect(result.exePath.endsWith("dsh-pet.exe")).toBe(true);
    expect(calls[0]?.[0]).toBe("tar");
    expect(downloads).toBe(1);

    const pointer = JSON.parse(await readFile(join(dataDir, "pet", "current.json"), "utf8")) as {
      version: string;
      exePath: string;
    };
    expect(pointer.version).toBe("v0.4.9");
    expect(pointer.exePath).toBe(result.exePath);

    // 同一个版本再装一次：直接指过去，不再下载。
    const again = await updater.install(info);
    expect(again.exePath).toBe(result.exePath);
    expect(downloads).toBe(1);
  });
});
