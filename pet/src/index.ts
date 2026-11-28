/**
 * `@kotana/pet` 的公开入口。
 *
 * 这里只导出宿主真正需要的东西：端口契约、可直接使用的适配器、应用服务，
 * 以及 asar / CDP 两个排查与集成工具。内部目录结构不通过 `exports` 暴露。
 */

export type {
  PetCompanion,
  PetCompanionStatus,
  PetSayOptions,
  PetWorkState,
} from "./ports/pet-companion.js";
export type {
  PetDisplayMode,
  PetEnvironmentSettings,
  PetFontSettings,
  PetGlobalSettings,
  PetMotionSettings,
  PetProfileSettings,
  PetScreenCorner,
  PetSettings,
  PetSettingsStore,
  PetVoiceSettings,
} from "./ports/pet-settings.js";
export type { PetUpdateInfo, PetUpdateResult, PetUpdater } from "./ports/pet-updater.js";

export {
  PetCompanionService,
  type PetCompanionServiceOptions,
} from "./application/pet-companion-service.js";
export {
  PET_CHATTER_LINES,
  PetChatterService,
  type PetChatterServiceOptions,
  type PetChatterTimer,
} from "./application/pet-chatter-service.js";

export {
  DshPetCompanion,
  PetCompanionError,
  isSandboxCrash,
  petStoragePaths,
  removeStaleSingleton,
  sanitizeElectronEnvironment,
  splitArgs,
  type ChildLike,
  type DshPetCompanionOptions,
  type EvaluateLike,
  type FetchLike,
  type KillTreeLike,
  type SpawnLike,
} from "./adapters/dsh-pet-companion.js";
export {
  DshPetSettingsStore,
  PetSettingsError,
  type DshPetSettingsOptions,
} from "./adapters/dsh-pet-settings.js";
export {
  DshPetUpdater,
  PetUpdateError,
  compareVersions,
  type DshPetUpdaterOptions,
  type RunCommandLike,
} from "./adapters/dsh-pet-updater.js";
export { extractAsar, readAsarEntry, stripJsonComments, type AsarNode } from "./adapters/asar.js";
export { evaluatePetPage, findPetPage } from "./adapters/cdp.js";
export {
  bundledPetVersion,
  loadPetCompanionConfig,
  readInstalledPetExe,
  type InstalledPet,
  type LoadPetCompanionConfigOptions,
  type PetCompanionConfig,
} from "./config/pet-companion-config.js";
