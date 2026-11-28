// 把事件流变成时间线：前台段、空闲段、点击、导航、空档。
// 只依赖 kinds 注册表提供的语义对象，不直接认识任何 kind 字符串。
import { parseEvent } from './kinds/index.js';

const BROWSER_RE = /chrome|msedge|firefox|opera|brave|vivaldi/i;
const GAP_THRESHOLD_MS = 10 * 60 * 1000;
const MERGE_GAP_MS = 2000;

export function isBrowserApp(app) {
  return !!app && BROWSER_RE.test(app);
}

/**
 * @param events 已按 ts 升序的事件（normalizeEvent 后的数组）
 * @param range { from, to }
 */
export function buildTimeline(events, { from, to }) {
  const segments = [];
  const idles = [];
  const clicks = [];
  const wheels = [];
  const navs = [];
  const lifecycles = [];

  let current = null;
  let currentIdle = null;

  // 段结束时间不超过「段内最后一次确认 + 10 分钟」：
  // 长时间没有事件时（采集器停了/人离开了），不能把整段空白都算成前台活跃。
  const closeSegment = (ts) => {
    if (!current) return;
    const cap = (current.lastConfirm ?? current.from) + GAP_THRESHOLD_MS;
    current.to = Math.max(current.from, Math.min(ts, cap));
    segments.push(current);
    current = null;
  };

  const touch = (ts) => {
    if (current) current.lastConfirm = ts;
  };

  for (const event of events) {
    const ts = event.ts;
    const sem = parseEvent(event);
    if (!sem) continue;

    if (sem.type === 'focus') {
      const same = current
        && current.app === sem.app
        && current.title === sem.title
        && (current.url ?? null) === (sem.url ?? null);
      if (same) {
        touch(ts);
        continue;
      }
      closeSegment(ts);
      current = {
        from: ts,
        to: null,
        app: sem.app,
        title: sem.title,
        url: sem.url,
        fullscreen: sem.data?.fullscreen ?? false,
        lastConfirm: ts,
      };
    } else if (sem.type === 'browser') {
      navs.push({ ts, phase: sem.phase, url: sem.url, title: sem.title, host: sem.host });
      if (current && isBrowserApp(current.app)) {
        if ((current.url ?? null) === sem.url) {
          touch(ts);
          continue;
        }
        const app = current.app;
        const fullscreen = current.fullscreen;
        closeSegment(ts);
        current = {
          from: ts,
          to: null,
          app,
          title: sem.title,
          url: sem.url,
          fullscreen,
          lastConfirm: ts,
        };
      }
    } else if (sem.type === 'click') {
      clicks.push({ ts, app: sem.app });
      touch(ts);
    } else if (sem.type === 'wheel') {
      wheels.push({ ts, direction: sem.direction });
      touch(ts);
    } else if (sem.type === 'idle-start') {
      closeSegment(ts);
      currentIdle = { from: ts, to: null, idleMs: sem.idleMs, thresholdS: sem.thresholdS };
    } else if (sem.type === 'idle-end') {
      if (currentIdle) {
        currentIdle.to = Math.max(ts, currentIdle.from);
        idles.push(currentIdle);
        currentIdle = null;
      }
    } else if (sem.type === 'lifecycle') {
      lifecycles.push({ ts, phase: sem.phase, app: sem.app ?? null });
      if (sem.phase === 'collector-stop' || sem.phase === 'collector-start') {
        // 采集器退出/重启后前台状态不可知，前后两段不能连起来
        closeSegment(ts);
      }
    }
  }

  closeSegment(to);
  if (currentIdle) {
    currentIdle.to = Math.max(to, currentIdle.from);
    idles.push(currentIdle);
  }

  // 事件空档：采集器没运行或没有窗口变化，超过 10 分钟标出来（含区间首尾空档）
  const gaps = [];
  if (events.length === 0) {
    if (to - from > GAP_THRESHOLD_MS) {
      gaps.push({ from, to, ms: to - from });
    }
  } else {
    if (events[0].ts - from > GAP_THRESHOLD_MS) {
      gaps.push({ from, to: events[0].ts, ms: events[0].ts - from });
    }
    for (let i = 1; i < events.length; i++) {
      const delta = events[i].ts - events[i - 1].ts;
      if (delta > GAP_THRESHOLD_MS) {
        gaps.push({ from: events[i - 1].ts, to: events[i].ts, ms: delta });
      }
    }
    const tail = to - events[events.length - 1].ts;
    if (tail > GAP_THRESHOLD_MS) {
      gaps.push({ from: events[events.length - 1].ts, to, ms: tail });
    }
  }

  return {
    from,
    to,
    events,
    segments: denoiseSegments(segments),
    idles,
    clicks,
    wheels,
    navs,
    lifecycles,
    gaps,
  };
}

/**
 * 段级去抖：采集器在窗口切换瞬间会连续记录同一秒内的多个窗口，
 * 短于 minMs 的段视为噪声，吸收进前一段。合并与吸收都不跨越空档。
 */
export function denoiseSegments(segments, minMs = 3000, maxGapMs = MERGE_GAP_MS) {
  const merged = [];
  for (const s of segments) {
    const last = merged[merged.length - 1];
    const contiguous = last && s.from - last.to <= maxGapMs;
    if (contiguous && (last.app ?? '') === (s.app ?? '') && (last.title ?? '') === (s.title ?? '')) {
      last.to = Math.max(last.to, s.to);
      continue;
    }
    merged.push({ ...s });
  }

  const out = [];
  for (const s of merged) {
    const dur = s.to - s.from;
    const prev = out[out.length - 1];
    const contiguous = prev && s.from - prev.to <= maxGapMs;
    if (dur < minMs && contiguous) {
      prev.to = Math.max(prev.to, s.to);
      continue;
    }
    out.push({ ...s });
  }
  return out;
}
