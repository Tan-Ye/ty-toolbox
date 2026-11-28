import type {
  PetCompanion,
  PetCompanionStatus,
  PetSayOptions,
  PetWorkState,
} from "../ports/pet-companion.js";
import type { PetUpdateInfo, PetUpdateResult, PetUpdater } from "../ports/pet-updater.js";

/** 桌宠应用服务的依赖。 */
export interface PetCompanionServiceOptions {
  /** 具体的桌宠实现；目前只有 dsh-pet 独立模式。 */
  readonly companion: PetCompanion;
  /** 更新器；没有接更新时可以不传。 */
  readonly updater?: PetUpdater;
}

/**
 * 桌宠应用服务。
 *
 * 这里只做「查状态 / 启停 / 说话 / 报状态」四类动作的编排，
 * 具体协议细节留在适配器里；换成别的桌宠程序时不需要改这一层。
 */
export class PetCompanionService {
  constructor(private readonly options: PetCompanionServiceOptions) {}

  /** 读取桌宠状态。 */
  async status(): Promise<PetCompanionStatus> {
    return this.options.companion.status();
  }

  /** 启动桌宠并等它可用。 */
  async start(): Promise<PetCompanionStatus> {
    return this.options.companion.start();
  }

  /** 让桌宠退出。 */
  async stop(): Promise<void> {
    await this.options.companion.stop();
  }

  /** 让桌宠说一句台词。 */
  async say(text: string, options: PetSayOptions = {}): Promise<void> {
    await this.options.companion.say(text, options);
  }

  /** 写入工作状态。 */
  async work(state: PetWorkState, task?: string | null): Promise<void> {
    await this.options.companion.work(state, task);
  }

  /** 清空工作状态。 */
  async clearWork(): Promise<void> {
    await this.options.companion.clearWork();
  }

  /** Kotana 退出时收尾：只关本进程拉起的桌宠。 */
  async shutdownOnExit(): Promise<void> {
    await this.options.companion.shutdownOnExit();
  }

  /** 点播一段动画。 */
  async play(animation: string): Promise<void> {
    await this.options.companion.play(animation);
  }

  /**
   * 检查桌宠更新。
   *
   * dsh-pet 本身没有更新接口，这里问的是 GitHub Releases。
   */
  async checkUpdate(): Promise<PetUpdateInfo> {
    const updater = this.options.updater;
    if (updater === undefined) {
      throw new Error("桌宠更新暂不可用");
    }
    return updater.check();
  }

  /** 下载并安装更新，装好后把伴侣实例指到新版本。 */
  async installUpdate(info?: PetUpdateInfo): Promise<PetUpdateResult> {
    const updater = this.options.updater;
    if (updater === undefined) {
      throw new Error("桌宠更新暂不可用");
    }

    const result = await updater.install(info);
    this.options.companion.reconfigure(result.exePath);
    return result;
  }
}
