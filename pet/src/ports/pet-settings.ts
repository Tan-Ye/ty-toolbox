/**
 * 桌宠配置的读写端口。
 *
 * 这里只描述「Kotana 想让用户改的那部分配置」，字段名与 dsh-pet 自己的
 * `main-config.jsonc` 对齐（pets / 全局开关 / 语音 / 字体 / 动作权重 / 环境）。
 * 对话模型、长期记忆、快捷键这些属于宿主（DSH 或 Kotana）的概念，不放进来。
 */

/** 宠物显示在哪：桌面 / 浏览器 / 都显示 / 都不显示。 */
export type PetDisplayMode = "desktop" | "web" | "both" | "none";

/** 宠物贴着屏幕的哪个角。 */
export type PetScreenCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

/** 单只宠物的配置。 */
export interface PetProfileSettings {
  readonly id: string;
  /** 显示名，鼠标悬浮宠物时弹出。 */
  readonly name: string;
  /** 宽度像素；高度由 dsh-pet 按 9/16 自动算。 */
  readonly size: number;
  readonly display: PetDisplayMode;
  readonly corner: PetScreenCorner;
  /** 距所选角落的水平距离（px）。 */
  readonly marginX: number;
  /** 距所选角落的垂直距离（px）。 */
  readonly marginY: number;
  readonly balanceEnabled: boolean;
  readonly whisperEnabled: boolean;
  readonly workStatusEnabled: boolean;
  readonly fixedEnabled: boolean;
}

/** 所有宠物共用的开关。 */
export interface PetGlobalSettings {
  readonly notificationsEnabled: boolean;
  readonly notifyWhenFocused: boolean;
  readonly clickSoundEnabled: boolean;
  readonly whisperImageEnabled: boolean;
  readonly chatImageEnabled: boolean;
  readonly chatAnimationEnabled: boolean;
  readonly confineToScreen: boolean;
  readonly trayEnabled: boolean;
}

/** 语音播报。 */
export interface PetVoiceSettings {
  readonly enabled: boolean;
  readonly whisperEnabled: boolean;
  readonly todoEnabled: boolean;
  readonly notifyEnabled: boolean;
  /** 0–1 的播放音量。 */
  readonly volume: number;
  /** 音色名；空串表示用它的默认音色。 */
  readonly name: string;
}

/** 气泡外观。 */
export interface PetFontSettings {
  /** 字体键（candy / yahei / youyuan / kaiti / simsun / comic / system）。 */
  readonly family: string;
  /** 字号 4–200。 */
  readonly size: number;
  readonly followPet: boolean;
}

/** 随机动作权重（idle / turn / move；随机动作 = 100 - 三者之和）。 */
export interface PetMotionSettings {
  readonly idle: number;
  readonly turn: number;
  readonly move: number;
}

/** 环境与定位。 */
export interface PetEnvironmentSettings {
  /** 天气城市；空串表示自动定位。 */
  readonly city: string;
}

/** 一份可编辑的桌宠配置。 */
export interface PetSettings {
  readonly pets: readonly PetProfileSettings[];
  readonly global: PetGlobalSettings;
  readonly voice: PetVoiceSettings;
  readonly font: PetFontSettings;
  readonly motion: PetMotionSettings;
  readonly environment: PetEnvironmentSettings;
}

/**
 * 配置存储端口。
 *
 * 读同步（启动时就能装配），写异步（落盘可能失败，必须让调用方知道）。
 * 保存时不认识的字段要原样保留——用户可能手改过 animations、memes 等。
 */
export interface PetSettingsStore {
  load(): PetSettings;
  save(settings: PetSettings): Promise<PetSettings>;
}
