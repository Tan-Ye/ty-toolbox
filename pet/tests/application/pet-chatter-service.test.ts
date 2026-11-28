import { describe, expect, it, vi } from "vitest";
import {
  PetChatterService,
  type PetChatterTimer,
} from "../../src/application/pet-chatter-service.js";

/** 手动推进的定时器，避免测试里真的等待几分钟。 */
function createClock() {
  let task: (() => void) | undefined;
  let delay = 0;
  let cancelled = false;

  return {
    get delay() {
      return delay;
    },
    get pending() {
      return !cancelled && task !== undefined;
    },
    schedule: (next: () => void, ms: number): PetChatterTimer => {
      task = next;
      delay = ms;
      cancelled = false;
      return {
        cancel: () => {
          cancelled = true;
          task = undefined;
        },
      };
    },
    /** 触发当前定时器，并等异步的 fire 跑完。 */
    async run(): Promise<void> {
      const current = task;
      task = undefined;
      current?.();
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }
    },
  };
}

function createOptions(overrides: Record<string, unknown> = {}) {
  const clock = createClock();
  const say = vi.fn(async () => {});
  const service = new PetChatterService({
    say,
    isRunning: async () => true,
    lines: ["第一句", "第二句"],
    minDelayMs: 1_000,
    maxDelayMs: 5_000,
    random: () => 0,
    schedule: clock.schedule,
    ...overrides,
  });
  return { service, clock, say };
}

describe("PetChatterService", () => {
  it("按区间内的随机间隔安排第一次触发", () => {
    const zero = createOptions({ random: () => 0 });
    zero.service.start();
    expect(zero.clock.delay).toBe(1_000);
    zero.service.stop();

    const full = createOptions({ random: () => 0.999999 });
    full.service.start();
    expect(full.clock.delay).toBe(5_000);
    full.service.stop();
  });

  it("触发时说一句本地台词，并安排下一次", async () => {
    const { service, clock, say } = createOptions();
    service.start();
    await clock.run();

    expect(say).toHaveBeenCalledWith("第一句");
    expect(clock.pending).toBe(true);
    service.stop();
  });

  it("每隔 modelEvery 条用一次模型，其余用本地台词", async () => {
    const generate = vi.fn(async () => "模型编的一句");
    const { service, clock, say } = createOptions({
      modelEvery: 2,
      generate,
    });
    service.start();

    await clock.run();
    expect(say).toHaveBeenLastCalledWith("第一句");

    await clock.run();
    expect(generate).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenLastCalledWith("模型编的一句");

    service.stop();
  });

  it("模型生成失败时退回本地台词", async () => {
    const generate = vi.fn(async () => {
      throw new Error("网络失败");
    });
    const { service, clock, say } = createOptions({ modelEvery: 1, generate });
    service.start();

    await clock.run();
    expect(say).toHaveBeenCalledWith("第一句");
    service.stop();
  });

  it("桌宠已经不在运行时停止调度", async () => {
    const isRunning = vi.fn(async () => false);
    const { service, clock, say } = createOptions({ isRunning });
    service.start();

    await clock.run();
    expect(say).not.toHaveBeenCalled();
    expect(service.active).toBe(false);
    expect(clock.pending).toBe(false);
  });

  it("连续失败三次后停止，不再重排", async () => {
    const say = vi.fn(async () => {
      throw new Error("桌宠没有响应");
    });
    const onError = vi.fn();
    const { service, clock } = createOptions({ say, onError });
    service.start();

    await clock.run();
    await clock.run();
    expect(service.active).toBe(true);
    await clock.run();

    expect(service.active).toBe(false);
    expect(clock.pending).toBe(false);
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it("stop 之后不再说话，也不会重排", async () => {
    const { service, clock, say } = createOptions();
    service.start();
    service.stop();

    await clock.run();
    expect(say).not.toHaveBeenCalled();
    expect(service.active).toBe(false);
    expect(clock.pending).toBe(false);
  });
});
