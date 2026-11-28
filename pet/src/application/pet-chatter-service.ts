/**
 * 桌宠碎碎念：隔一段不固定的时间，让桌宠自己说一句话。
 *
 * dsh-pet 自己没有定时说话的能力，这里由 Kotana 调度：
 * 大多数时候从本地台词池里挑一句，偶尔让模型按人格现编一句。
 * 只依赖「说话」和「是否在运行」两个动作，方便测试和替换。
 */

/** 可取消的定时器。 */
export interface PetChatterTimer {
  /** 取消本次调度。 */
  cancel(): void;
}

/** 碎碎念应用的依赖。 */
export interface PetChatterServiceOptions {
  /** 让桌宠说一句；失败会抛错。 */
  readonly say: (text: string) => Promise<void>;
  /** 桌宠是否还在运行。 */
  readonly isRunning: () => Promise<boolean>;
  /** 让模型按人格生成一句；不接时只用本地台词池。 */
  readonly generate?: () => Promise<string | null>;
  /** 本地台词池；不传时用内置台词。 */
  readonly lines?: readonly string[];
  /** 两次碎碎念的最短间隔，默认 3 分钟。 */
  readonly minDelayMs?: number;
  /** 两次碎碎念的最长间隔，默认 8 分钟。 */
  readonly maxDelayMs?: number;
  /** 每隔几条用模型生成一次；0 表示从不，默认 4。 */
  readonly modelEvery?: number;
  /** 随机数来源，测试可注入。 */
  readonly random?: () => number;
  /** 定时器实现，测试可注入。 */
  readonly schedule?: (task: () => void, delayMs: number) => PetChatterTimer;
  /** 单次失败的回调；不接时静默。 */
  readonly onError?: (error: unknown) => void;
}

/** 默认台词池：短句、口语、像自言自语，不向用户提问。 */
export const PET_CHATTER_LINES: readonly string[] = [
  "今天也想吃点好的。",
  "你忙你的，我在这儿待着。",
  "有点困，但还能再撑一会儿。",
  "窗外好像没声音了。",
  "要不要歇一会儿？",
  "这事儿不急，慢慢来。",
  "我又把话咽回去了。",
  "喝口水吧。",
  "我在想晚上吃什么。",
  "刚才那句，我没接住。",
  "安静一会儿也挺好。",
  "你好像很久没动了。",
  "我是不是有点话多？",
  "今天过得还行吧。",
  "有点想发呆。",
  "别熬太晚。",
  "我在这儿，不走。",
  "这个点，该吃点东西了。",
  "刚刚走了个神。",
  "慢慢来，不着急。",
  "偶尔也想被夸一句。",
  "你继续，我眯一会儿。",
  "这屋子挺安静的。",
  "记得伸个懒腰。",
];

/** 默认最短间隔：3 分钟。 */
const DEFAULT_MIN_DELAY_MS = 3 * 60_000;

/** 默认最长间隔：8 分钟。 */
const DEFAULT_MAX_DELAY_MS = 8 * 60_000;

/** 默认每 4 条里有一条由模型生成。 */
const DEFAULT_MODEL_EVERY = 4;

/** 连续失败多少次后停止调度。 */
const MAX_FAILURES = 3;

/** 桌面宠物的碎碎念调度器。 */
export class PetChatterService {
  /** 当前是否在调度。 */
  private running = false;

  /** 下一次触发的定时器。 */
  private timer: PetChatterTimer | undefined;

  /** 已经说过的条数，用于决定何时用模型生成。 */
  private emitted = 0;

  /** 连续失败次数。 */
  private failures = 0;

  /** 台词池。 */
  private readonly lines: readonly string[];

  /** 最短间隔。 */
  private readonly minDelayMs: number;

  /** 最长间隔。 */
  private readonly maxDelayMs: number;

  /** 模型生成频率。 */
  private readonly modelEvery: number;

  /** 随机数来源。 */
  private readonly random: () => number;

  /** 定时器实现。 */
  private readonly schedule: (
    task: () => void,
    delayMs: number,
  ) => PetChatterTimer;

  constructor(private readonly options: PetChatterServiceOptions) {
    this.lines = options.lines ?? PET_CHATTER_LINES;
    this.minDelayMs = Math.max(1_000, options.minDelayMs ?? DEFAULT_MIN_DELAY_MS);
    this.maxDelayMs = Math.max(
      this.minDelayMs,
      options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    );
    this.modelEvery = Math.max(0, options.modelEvery ?? DEFAULT_MODEL_EVERY);
    this.random = options.random ?? Math.random;
    this.schedule = options.schedule ?? defaultSchedule;
  }

  /** 当前是否在调度中。 */
  get active(): boolean {
    return this.running;
  }

  /** 开始调度；重复调用无副作用。 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    this.scheduleNext();
  }

  /** 停止调度并取消待触发的定时器。 */
  stop(): void {
    this.running = false;
    this.timer?.cancel();
    this.timer = undefined;
  }

  /** 安排下一次触发。 */
  private scheduleNext(): void {
    if (!this.running || this.timer !== undefined) return;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      void this.fire();
    }, this.nextDelay());
  }

  /** 取一个落在区间内的随机间隔。 */
  private nextDelay(): number {
    const span = this.maxDelayMs - this.minDelayMs;
    const offset = Math.min(span, Math.floor(this.random() * (span + 1)));
    return this.minDelayMs + offset;
  }

  /** 触发一次：确认桌宠还在，挑一句话，发出去，再排下一次。 */
  private async fire(): Promise<void> {
    if (!this.running) return;

    try {
      if (!(await this.options.isRunning())) {
        this.stop();
        return;
      }
      const text = await this.nextLine();
      await this.options.say(text);
      this.failures = 0;
    } catch (error) {
      this.failures += 1;
      this.options.onError?.(error);
      if (this.failures >= MAX_FAILURES) {
        this.stop();
        return;
      }
    }

    this.scheduleNext();
  }

  /** 轮到模型生成时用模型，否则从本地池挑一句。 */
  private async nextLine(): Promise<string> {
    this.emitted += 1;

    const generate = this.options.generate;
    if (
      generate !== undefined &&
      this.modelEvery > 0 &&
      this.emitted % this.modelEvery === 0
    ) {
      const generated = await generate().catch(() => null);
      const trimmed = generated?.trim();
      if (trimmed) return trimmed;
    }

    const index = Math.min(
      this.lines.length - 1,
      Math.floor(this.random() * this.lines.length),
    );
    return this.lines[index] ?? "我在。";
  }
}

/** 默认定时器：允许进程在只剩碎碎念定时器时正常退出。 */
function defaultSchedule(
  task: () => void,
  delayMs: number,
): PetChatterTimer {
  const timer = setTimeout(task, delayMs);
  if (typeof timer.unref === "function") timer.unref();
  return {
    cancel: () => clearTimeout(timer),
  };
}
