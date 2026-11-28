/**
 * 桌宠更新端口。
 *
 * dsh-pet 自己**没有**更新接口（`API.md` 只有健康检查、占用锁、广播等），
 * 所以更新由 Kotana 负责：从它的 GitHub Releases 取最新独立版 zip，
 * 解压到数据目录后再把「当前使用的版本」指过去。
 *
 * 这样安装目录（可能在 Program Files，需要管理员权限）始终保持只读，
 * 更新只写 `<dataDir>/pet/`。
 */

/** 一次更新检查的结果。 */
export interface PetUpdateInfo {
  /** 当前生效的版本，例如 `v0.4.9`；未知时为 `unknown`。 */
  readonly current: string;
  /** 上游最新版本，例如 `v0.4.10`。 */
  readonly latest: string;
  /** 是否需要更新（按语义化版本比较）。 */
  readonly needsUpdate: boolean;
  /** 最新版安装包的下载地址；上游没有对应资源时为 null。 */
  readonly downloadUrl: string | null;
  /** 上游发布时间（ISO 8601），没有则为 undefined。 */
  readonly publishedAt?: string;
}

/** 安装完成后的结果。 */
export interface PetUpdateResult {
  /** 安装的版本，例如 `v0.4.10`。 */
  readonly version: string;
  /** 新版本可执行文件的绝对路径。 */
  readonly exePath: string;
}

/** 桌宠更新能力。 */
export interface PetUpdater {
  /** 检查上游是否有新版本。 */
  check(): Promise<PetUpdateInfo>;

  /** 下载并安装指定版本；不传参数时用最近一次 `check()` 的结果。 */
  install(info?: PetUpdateInfo): Promise<PetUpdateResult>;
}
