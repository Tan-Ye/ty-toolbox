/**
 * 桌宠伴侣端口。
 *
 * Kotana 自己不画宠物了：把「动起来」这件事交给外部桌宠程序（dsh-pet 独立模式），
 * 我们只负责「说什么」和「现在是什么状态」。这条边界让桌宠可以随时换掉，
 * 而人设、台词、记忆始终留在 Kotana。
 */

/** 桌宠工作状态档位，与 dsh-pet 的 work-status 六档一一对应。 */
export type PetWorkState =
  | "thinking"
  | "working"
  | "result"
  | "waiting"
  | "success"
  | "error";

/** 桌宠程序当前状态。 */
export interface PetCompanionStatus {
  /** 配置里是否给了程序路径；没有就别尝试启动。 */
  readonly configured: boolean;
  /** 健康检查是否通过。 */
  readonly running: boolean;
  /** 实际探测到的端口；未运行时为 null。 */
  readonly port: number | null;
  /** 桌宠实例 id，一般是 `main`。 */
  readonly petId: string;
  /** 给界面看的一句话说明。 */
  readonly message: string;
}

/** 说一句话时的可选参数。 */
export interface PetSayOptions {
  /** 气泡显示时长（毫秒）；0 表示只播动画不弹气泡。 */
  readonly durationMs?: number;
  /** 是否联动一次说话动画，默认 true。 */
  readonly animate?: boolean;
}

/** 桌宠伴侣能力。 */
export interface PetCompanion {
  /** 读取当前状态，不启动进程。 */
  status(): Promise<PetCompanionStatus>;
  /** 启动桌宠程序并等待健康检查通过。 */
  start(): Promise<PetCompanionStatus>;
  /** 通知桌宠退出。 */
  stop(): Promise<void>;
  /** 让桌宠说一句我们生成的台词。 */
  say(text: string, options?: PetSayOptions): Promise<void>;
  /** 写入工作状态（思考 / 工作 / 完成 / 出错）。 */
  work(state: PetWorkState, task?: string | null): Promise<void>;
  /** 清空工作状态，回到空闲。 */
  clearWork(): Promise<void>;
  /** 点播一段动画（名字取自桌宠自己的动画池）。 */
  play(animation: string): Promise<void>;
  /**
   * 换一个可执行文件路径。
   *
   * 桌宠更新装在数据目录里，装完要让正在运行的伴侣实例指向新路径，
   * 否则重启后仍会拉起旧版本。
   */
  reconfigure(exePath: string | undefined): void;
  /**
   * Kotana 退出时收尾。
   *
   * 只处理「本进程拉起来的」那只桌宠：用户自己开的实例不属于我们，
   * 不该替他关掉。实现必须尽力而为，失败也不能阻塞退出。
   */
  shutdownOnExit(): Promise<void>;
}
