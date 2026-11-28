import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
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
} from "../ports/pet-settings.js";
import { readAsarEntry, stripJsonComments } from "./asar.js";

/** 配置读写失败的原因，调用方按它给文案。 */
export class PetSettingsError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(message);
    this.name = "PetSettingsError";
    this.reason = reason;
  }
}

/** 构造参数。 */
export interface DshPetSettingsOptions {
  /** 数据目录；配置落在 `<dataDir>/pet/home/dsh-pet/main-config.jsonc`。 */
  readonly dataDir: string;
  /** 桌宠 exe 路径；给了才能从它的 app.asar 里取默认配置。 */
  readonly exePath?: string;
}

const CONFIG_DIR_PARTS = ["pet", "home", "dsh-pet"] as const;
const DISPLAY_MODES: readonly PetDisplayMode[] = ["desktop", "web", "both", "none"];
const CORNERS: readonly PetScreenCorner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

/** 没有配置文件、也读不到内置默认时用的兜底值。 */
const FALLBACK: PetSettings = {
  pets: [
    {
      id: "main",
      name: "蓝毛小女仆",
      size: 462,
      display: "desktop",
      corner: "top-right",
      marginX: 24,
      marginY: 100,
      balanceEnabled: true,
      whisperEnabled: true,
      workStatusEnabled: true,
      fixedEnabled: false,
    },
  ],
  global: {
    notificationsEnabled: true,
    notifyWhenFocused: false,
    clickSoundEnabled: true,
    whisperImageEnabled: false,
    chatImageEnabled: false,
    chatAnimationEnabled: false,
    confineToScreen: false,
    trayEnabled: true,
  },
  voice: { enabled: false, whisperEnabled: false, todoEnabled: false, notifyEnabled: false, volume: 0.8, name: "" },
  font: { family: "candy", size: 16, followPet: true },
  motion: { idle: 60, turn: 20, move: 20 },
  environment: { city: "" },
};

/**
 * 读写 dsh-pet 的用户配置。
 *
 * 只碰我们自己那份（`<dataDir>/pet/home/dsh-pet/`），并且保存时保留不认识的字段，
 * 免得把用户手改过的 animations / memes / 台词一起抹掉。
 */
export class DshPetSettingsStore implements PetSettingsStore {
  private readonly dataDir: string;
  private readonly exePath: string | undefined;
  /** 上次读到的完整配置；保存时以它为底再覆盖我们的字段。 */
  private base: Record<string, unknown> = {};

  constructor(options: DshPetSettingsOptions) {
    this.dataDir = options.dataDir;
    this.exePath = options.exePath;
  }

  /** 配置文件路径（优先已有的 .jsonc，其次 .json）。 */
  configPath(): string {
    const dir = join(this.dataDir, ...CONFIG_DIR_PARTS);
    const jsonc = join(dir, "main-config.jsonc");
    if (existsSync(jsonc)) return jsonc;
    const json = join(dir, "main-config.json");
    if (existsSync(json)) return json;
    return jsonc;
  }

  /** 读配置；文件坏了抛错，文件不在则用内置默认值。 */
  load(): PetSettings {
    const path = this.configPath();
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      try {
        this.base = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
      } catch {
        throw new PetSettingsError("invalid-config", `桌宠配置文件解析不了：${path}`);
      }
      return readSettings(this.base);
    }

    this.base = this.bundledConfig() ?? {};
    return readSettings(this.base);
  }

  /** 保存（保留未知字段）。 */
  async save(settings: PetSettings): Promise<PetSettings> {
    const path = this.configPath();
    const next: Record<string, unknown> = {
      ...this.base,
      pets: settings.pets.map(toPetRecord),
      notificationsEnabled: settings.global.notificationsEnabled,
      notifyWhenFocused: settings.global.notifyWhenFocused,
      clickSoundEnabled: settings.global.clickSoundEnabled,
      whisperImageEnabled: settings.global.whisperImageEnabled,
      chatImageEnabled: settings.global.chatImageEnabled,
      chatAnimationEnabled: settings.global.chatAnimationEnabled,
      confineToScreen: settings.global.confineToScreen,
      trayEnabled: settings.global.trayEnabled,
      voiceEnabled: settings.voice.enabled,
      voiceWhisperEnabled: settings.voice.whisperEnabled,
      voiceTodoEnabled: settings.voice.todoEnabled,
      voiceNotifyEnabled: settings.voice.notifyEnabled,
      voiceVolume: settings.voice.volume,
      voiceName: settings.voice.name,
      font: { family: settings.font.family, size: settings.font.size, followPet: settings.font.followPet },
      animationWeights: { idle: settings.motion.idle, turn: settings.motion.turn, move: settings.motion.move },
      environmentCity: settings.environment.city,
    };

    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp-kotana`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      renameSync(tmp, path);
    } catch (error) {
      throw new PetSettingsError("save-failed", `保存桌宠配置失败：${String(error)}`);
    }

    this.base = next;
    return readSettings(next);
  }

  /** 从随包的 app.asar 里取自带默认配置。 */
  private bundledConfig(): Record<string, unknown> | null {
    if (this.exePath === undefined) return null;
    const asar = join(dirname(this.exePath), "resources", "app.asar");
    const raw = readAsarEntry(asar, "assets/config.jsonc");
    if (raw === null) return null;
    try {
      return JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}

/** 从整份配置里取我们要编辑的那部分。 */
function readSettings(source: Record<string, unknown>): PetSettings {
  return {
    pets: readPets(source.pets),
    global: readGlobal(source),
    voice: readVoice(source),
    font: readFont(source.font),
    motion: readMotion(source.animationWeights),
    environment: { city: asString(source.environmentCity) },
  };
}

function readPets(value: unknown): readonly PetProfileSettings[] {
  if (!Array.isArray(value)) return FALLBACK.pets;
  const pets = value.filter((item): item is Record<string, unknown> => isRecord(item)).map(readPet);
  return pets.length === 0 ? FALLBACK.pets : pets;
}

function readPet(raw: Record<string, unknown>): PetProfileSettings {
  const position = isRecord(raw.position) ? raw.position : {};
  return {
    id: asString(raw.id) || "main",
    name: asString(raw.name) || "桌宠",
    size: clampNumber(raw.size, 80, 4_000, 462),
    display: asEnum(raw.display, DISPLAY_MODES, "desktop"),
    corner: asEnum(position.corner, CORNERS, "top-right"),
    marginX: clampNumber(position.marginX, -20_000, 20_000, 24),
    marginY: clampNumber(position.marginY, -20_000, 20_000, 100),
    balanceEnabled: asBoolean(raw.balanceEnabled, true),
    whisperEnabled: asBoolean(raw.whisperEnabled, true),
    workStatusEnabled: asBoolean(raw.workStatusEnabled, true),
    fixedEnabled: asBoolean(raw.fixedEnabled, false),
  };
}

function readGlobal(source: Record<string, unknown>): PetGlobalSettings {
  return {
    notificationsEnabled: asBoolean(source.notificationsEnabled, true),
    notifyWhenFocused: asBoolean(source.notifyWhenFocused, false),
    clickSoundEnabled: asBoolean(source.clickSoundEnabled, true),
    whisperImageEnabled: asBoolean(source.whisperImageEnabled, false),
    chatImageEnabled: asBoolean(source.chatImageEnabled, false),
    chatAnimationEnabled: asBoolean(source.chatAnimationEnabled, false),
    confineToScreen: asBoolean(source.confineToScreen, false),
    trayEnabled: asBoolean(source.trayEnabled, true),
  };
}

function readVoice(source: Record<string, unknown>): PetVoiceSettings {
  return {
    enabled: asBoolean(source.voiceEnabled, false),
    whisperEnabled: asBoolean(source.voiceWhisperEnabled, false),
    todoEnabled: asBoolean(source.voiceTodoEnabled, false),
    notifyEnabled: asBoolean(source.voiceNotifyEnabled, false),
    volume: clampNumber(source.voiceVolume, 0, 1, 0.8),
    name: asString(source.voiceName),
  };
}

function readFont(value: unknown): PetFontSettings {
  const raw = isRecord(value) ? value : {};
  return {
    family: asString(raw.family) || "candy",
    size: clampNumber(raw.size, 4, 200, 16),
    followPet: asBoolean(raw.followPet, true),
  };
}

function readMotion(value: unknown): PetMotionSettings {
  const raw = isRecord(value) ? value : {};
  return {
    idle: clampNumber(raw.idle, 0, 100, 60),
    turn: clampNumber(raw.turn, 0, 100, 20),
    move: clampNumber(raw.move, 0, 100, 20),
  };
}

function toPetRecord(pet: PetProfileSettings): Record<string, unknown> {
  return {
    id: pet.id,
    name: pet.name,
    size: pet.size,
    display: pet.display,
    balanceEnabled: pet.balanceEnabled,
    whisperEnabled: pet.whisperEnabled,
    workStatusEnabled: pet.workStatusEnabled,
    fixedEnabled: pet.fixedEnabled,
    position: { corner: pet.corner, marginX: pet.marginX, marginY: pet.marginY },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}
