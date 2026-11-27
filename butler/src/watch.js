// 实时观察：每 60 秒看一次「现在」，命中规则就提醒。
// 不是分析器（不产出报告），是助理的感知层：只回答「此刻在干什么、有没有该说一句的事」。
import { eventsInRange } from './db.js';
import { buildTimeline } from './timeline.js';
import { appFriendly } from './util/text.js';
import { formatClock } from './util/time.js';

export const DEFAULT_WATCH = {
  intervalMs: 60_000,       // 检查间隔
  lookbackMs: 2 * 3600_000, // 每次回看 2 小时，足够算出当前段与最近 1 小时切换
  focusWarnMs: 45 * 60_000, // 同一窗口连续专注超过 45 分钟提醒
  lateFromMinute: 23 * 60 + 30, // 23:30 之后仍活跃提醒
  switchWarnCount: 30,      // 最近 1 小时切换超过 30 次提醒
  cooldownMs: 30 * 60_000,  // 同一条规则 30 分钟内只提醒一次
  activeWindowMs: 90_000,   // 最后一次事件在 90 秒内算「在用」（心跳 60 秒）
};

/**
 * 采集当下状态：当前段、是否活跃、最近一小时切换次数。
 * 复用 timeline.js，保证「现在」和「日报」对同一批事件的理解一致。
 */
export function takeSnapshot(db, now, opts = DEFAULT_WATCH) {
  const from = now - opts.lookbackMs;
  const events = eventsInRange(db, from, now + 1);
  const timeline = buildTimeline(events, { from, to: now });

  const last = events[events.length - 1] ?? null;
  const idleOpen = last?.kind === 'idle.start';
  const active = !!last && now - last.ts < opts.activeWindowMs && !idleOpen;

  let current = null;
  if (active && timeline.segments.length > 0) {
    const seg = timeline.segments[timeline.segments.length - 1];
    current = { app: seg.app, title: seg.title, from: seg.from, ms: now - seg.from };
  }

  const hourAgo = now - 3600_000;
  const hourSegs = timeline.segments.filter((s) => s.from >= hourAgo);
  let switches = 0;
  for (let i = 1; i < hourSegs.length; i++) {
    if ((hourSegs[i].app ?? '') !== (hourSegs[i - 1].app ?? '')) switches++;
  }

  return {
    now,
    active,
    idleOpen,
    current,
    switches,
    segmentCount: timeline.segments.length,
    lastEventAt: last?.ts ?? null,
    lastEventKind: last?.kind ?? null,
  };
}

/** 规则判断：返回本次命中的提醒（空数组表示没什么可说的）。 */
export function evaluateRules(snap, opts = DEFAULT_WATCH) {
  const alerts = [];
  if (!snap.active) return alerts;

  if (snap.current && snap.current.ms >= opts.focusWarnMs) {
    const name = appFriendly(snap.current.app);
    const minutes = Math.round(snap.current.ms / 60_000);
    alerts.push({
      id: 'focus',
      message: `在 ${name} 上已经连续 ${minutes} 分钟了，起来动一下？`,
    });
  }

  const d = new Date(snap.now);
  const minuteOfDay = d.getHours() * 60 + d.getMinutes();
  if (minuteOfDay >= opts.lateFromMinute || minuteOfDay < 6 * 60) {
    alerts.push({ id: 'late', message: `快 ${formatClock(snap.now)} 了，今天到这吧` });
  }

  if (snap.switches >= opts.switchWarnCount) {
    alerts.push({ id: 'fragment', message: `这一小时切了 ${snap.switches} 次，要不要收一下心？` });
  }

  return alerts;
}

/**
 * 启动观察循环。
 * @param db 只读数据库
 * @param opts 见 DEFAULT_WATCH
 * @param onAlert (alert) => Promise|void 真正「说话」的动作（演示时可以是打印）
 * @param onTick (snap, alerted) => void 每轮回调，方便打日志/调试
 * @param once 只跑一轮
 */
export async function startWatch(db, { opts = DEFAULT_WATCH, onAlert, onTick, once = false } = {}) {
  const lastAlertAt = new Map();
  let stopped = false;

  const tick = async () => {
    const now = Date.now();
    const snap = takeSnapshot(db, now, opts);
    const alerts = evaluateRules(snap, opts).filter((alert) => {
      const last = lastAlertAt.get(alert.id) ?? 0;
      return now - last >= opts.cooldownMs;
    });

    for (const alert of alerts) {
      lastAlertAt.set(alert.id, now);
      await onAlert?.(alert);
    }
    onTick?.(snap, alerts);
  };

  await tick();
  if (once) return { stop: () => {} };

  const timer = setInterval(() => {
    if (!stopped) tick().catch(() => {});
  }, opts.intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
