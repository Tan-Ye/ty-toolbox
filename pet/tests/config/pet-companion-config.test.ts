import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadPetCompanionConfig } from "../../src/config/pet-companion-config.js";

/** 每个用例一个临时数据目录，避免读到真实数据。 */
const dirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kotana-pet-config-"));
  dirs.push(dir);
  return dir;
}

/** 用固定环境变量表构造读取函数。 */
function envOf(pairs: Record<string, string>): (name: string) => string | undefined {
  return (name) => pairs[name];
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadPetCompanionConfig", () => {
  it("没有配置时保持未启用", async () => {
    const config = loadPetCompanionConfig({ dataDir: await makeDataDir(), env: envOf({}) });

    expect(config.enabled).toBe(false);
    expect(config.exePath).toBeUndefined();
    expect(config.port).toBe(3080);
    expect(config.petId).toBe("main");
  });

  it("随包分发的路径能让桌宠默认可用", async () => {
    const config = loadPetCompanionConfig({
      dataDir: await makeDataDir(),
      env: envOf({ KOTANA_PET_BUNDLED_EXE: "C:/Kotana/resources/_up_/dsh-pet/dsh-pet.exe" }),
    });

    expect(config.enabled).toBe(true);
    expect(config.exePath).toBe("C:/Kotana/resources/_up_/dsh-pet/dsh-pet.exe");
  });

  it("KOTANA_PET_EXE 覆盖随包路径", async () => {
    const config = loadPetCompanionConfig({
      dataDir: await makeDataDir(),
      env: envOf({
        KOTANA_PET_EXE: "D:/tools/dsh-pet/dsh-pet.exe",
        KOTANA_PET_BUNDLED_EXE: "C:/Kotana/resources/_up_/dsh-pet/dsh-pet.exe",
      }),
    });

    expect(config.exePath).toBe("D:/tools/dsh-pet/dsh-pet.exe");
  });

  it("配置文件里的路径优先于随包路径", async () => {
    const dataDir = await makeDataDir();
    await mkdir(join(dataDir, "pet"), { recursive: true });
    await writeFile(
      join(dataDir, "pet", "companion.json"),
      JSON.stringify({ exePath: "E:/pets/dsh-pet.exe" }),
      "utf8",
    );

    const config = loadPetCompanionConfig({
      dataDir,
      env: envOf({ KOTANA_PET_BUNDLED_EXE: "C:/Kotana/resources/_up_/dsh-pet/dsh-pet.exe" }),
    });

    expect(config.exePath).toBe("E:/pets/dsh-pet.exe");
  });

  it("配置文件损坏时按未配置处理，但随包路径仍然可用", async () => {
    const dataDir = await makeDataDir();
    await mkdir(join(dataDir, "pet"), { recursive: true });
    await writeFile(join(dataDir, "pet", "companion.json"), "{ 这不是 JSON", "utf8");

    const withBundled = loadPetCompanionConfig({
      dataDir,
      env: envOf({ KOTANA_PET_BUNDLED_EXE: "C:/Kotana/resources/_up_/dsh-pet/dsh-pet.exe" }),
    });
    const without = loadPetCompanionConfig({ dataDir, env: envOf({}) });

    expect(withBundled.exePath).toBe("C:/Kotana/resources/_up_/dsh-pet/dsh-pet.exe");
    expect(without.enabled).toBe(false);
  });
});
