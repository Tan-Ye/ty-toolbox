import { describe, expect, it } from "vitest";

import * as pet from "../src/index.js";

/**
 * 包的公开面是 kotana 唯一会依赖的东西，这里把它钉死：
 * 少导出一个函数，宿主升级时就会在编译期而不是运行期炸。
 */
const EXPECTED_EXPORTS = [
  "DshPetCompanion",
  "PetCompanionError",
  "DshPetSettingsStore",
  "PetSettingsError",
  "DshPetUpdater",
  "PetUpdateError",
  "PetCompanionService",
  "PetChatterService",
  "PET_CHATTER_LINES",
  "compareVersions",
  "loadPetCompanionConfig",
  "readInstalledPetExe",
  "bundledPetVersion",
  "petStoragePaths",
  "sanitizeElectronEnvironment",
  "splitArgs",
  "isSandboxCrash",
  "removeStaleSingleton",
  "readAsarEntry",
  "extractAsar",
  "stripJsonComments",
  "findPetPage",
  "evaluatePetPage",
] as const;

describe("公开 API", () => {
  it("保留 kotana 依赖的全部导出", () => {
    expect(Object.keys(pet)).toEqual(expect.arrayContaining([...EXPECTED_EXPORTS]));
  });

  it("默认台词可直接当数组用", () => {
    expect(Array.isArray(pet.PET_CHATTER_LINES)).toBe(true);
    expect(pet.PET_CHATTER_LINES.length).toBeGreaterThan(0);
  });
});
