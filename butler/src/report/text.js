// 文本报告渲染：给人看的输出。
import { formatClock, formatDuration, formatDate } from '../util/time.js';
import { cleanTitle, appFriendly } from '../util/text.js';

const MIN_SEGMENT_MS = 30 * 1000;

/** 终端显示宽度：中日韩全角字符算 2。 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += (ch.codePointAt(0) > 0x2e80) ? 2 : 1;
  return w;
}

function pad(s, width) {
  const str = String(s ?? '');
  const w = displayWidth(str);
  return w >= width ? str : str + ' '.repeat(width - w);
}

function pct(part, whole) {
  if (!whole || whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

function segmentLine(s) {
  const from = formatClock(s.from);
  const to = formatClock(s.to);
  const dur = formatDuration(s.to - s.from);
  const title = cleanTitle(s.title) || '（无标题）';
  const extra = s.url ? ` · ${s.url}` : '';
  const parts = s.parts && s.parts > 1 ? `（${s.parts} 段）` : '';
  return `${from}-${to}  ${pad(dur, 6)}  ${pad(appFriendly(s.app), 22)}  ${title}${parts}${extra}`;
}

/** 把相邻同应用的段合并成一行，避免游戏/浏览器内标题变化把时间线刷满。 */
function mergeAdjacent(segments) {
  const out = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && (last.app ?? '') === (s.app ?? '') && s.from - last.to <= 2000) {
      last.to = Math.max(last.to, s.to);
      last.parts = (last.parts ?? 1) + 1;
      const dur = s.to - s.from;
      if (dur >= (last.bestMs ?? 0)) {
        last.title = s.title;
        last.url = s.url;
        last.bestMs = dur;
      }
      continue;
    }
    out.push({ ...s, parts: 1, bestMs: s.to - s.from });
  }
  return out;
}

export function formatRange(result, { appFilter = null, showAll = false } = {}) {
  const lines = [];
  const span = result.to - result.from;
  lines.push(`区间 ${formatClock(result.from)}-${formatClock(result.to)}（${formatDuration(span)}）`);
  lines.push(`活跃 ${formatDuration(result.activeMs)} · 空闲 ${formatDuration(result.idleMs)} · 未记录 ${formatDuration(result.unrecordedMs)} · 切换 ${result.switches} 次 · 点击 ${result.clickCount} 次` + (appFilter ? ` · 过滤 ${appFilter}` : ''));
  lines.push('');

  lines.push('时间线');
  const visible = mergeAdjacent(result.segments).filter((s) => showAll || (s.to - s.from) >= MIN_SEGMENT_MS);
  if (visible.length === 0) {
    lines.push('  （没有符合条件的前台段）');
  } else {
    for (const s of visible) lines.push('  ' + segmentLine(s));
    const hidden = result.segments.length - visible.length;
    if (hidden > 0) lines.push(`  …… 另有 ${hidden} 段短于 30 秒未显示（--all 展开）`);
  }
  lines.push('');

  lines.push('应用时长');
  if (result.appList.length === 0) {
    lines.push('  （无）');
  } else {
    for (const a of result.appList.slice(0, 15)) {
      lines.push(`  ${pad(a.name, 22)} ${pad(formatDuration(a.ms), 10)} ${pct(a.ms, result.activeMs || result.spanMs)}`);
    }
  }

  if (result.searches.length > 0) {
    lines.push('');
    lines.push('搜索');
    for (const s of result.searches.slice(0, 20)) {
      lines.push(`  ${s.query}（${s.engine}，${formatClock(s.ts)}）`);
    }
  }

  if (result.gaps.length > 0) {
    lines.push('');
    lines.push('数据空档（超过 10 分钟没有事件，可能是采集器没运行）');
    for (const g of result.gaps.slice(-10)) {
      lines.push(`  ${formatClock(g.from)}-${formatClock(g.to)}  ${formatDuration(g.ms)}`);
    }
  }

  return lines.join('\n');
}

export function formatDaily(result, { dateMs } = {}) {
  const lines = [];
  const dateStr = dateMs ? formatDate(dateMs) : formatDate(result.from);
  lines.push(`${dateStr} 日报`);
  lines.push(`活跃 ${formatDuration(result.activeMs)} · 空闲 ${formatDuration(result.idleMs)} · 未记录 ${formatDuration(result.unrecordedMs)} · 切换 ${result.switches} 次 · 点击 ${result.clickCount} 次`);
  if (result.firstActivity) {
    lines.push(`首次活动 ${formatClock(result.firstActivity)} · 最后活动 ${formatClock(result.lastActivity)}`);
  }
  lines.push('');

  lines.push('应用时长');
  if (result.appList.length === 0) {
    lines.push('  （无）');
  } else {
    for (const a of result.appList.slice(0, 12)) {
      lines.push(`  ${pad(a.name, 22)} ${pad(formatDuration(a.ms), 10)} ${pct(a.ms, result.activeMs || result.windowMs || result.spanMs)}`);
    }
    if (result.appList.length > 12) lines.push(`  …… 另有 ${result.appList.length - 12} 个应用`);
  }

  if (result.categories.length > 0) {
    lines.push('');
    lines.push('用途分布');
    for (const c of result.categories) {
      lines.push(`  ${pad(c.category, 12)} ${pad(formatDuration(c.ms), 10)} ${pct(c.ms, result.activeMs || result.spanMs)}`);
    }
  }

  if (result.sites.length > 0) {
    lines.push('');
    lines.push('站点分布（按访问次数）');
    for (const s of result.sites.slice(0, 12)) {
      lines.push(`  ${pad(s.host, 34)} ${String(s.count).padStart(4)} 次  ${s.category}`);
    }
  }

  if (result.searches.length > 0) {
    lines.push('');
    lines.push('搜索与提问');
    for (const s of result.searches.slice(0, 20)) {
      lines.push(`  ${s.query}（${s.engine}，${formatClock(s.ts)}）`);
    }
  }

  if (result.focus.longestMs > 0) {
    lines.push('');
    lines.push('专注与碎片');
    lines.push(`  最长连续 ${result.focus.longestApp ? result.focus.longestApp : '未知'} ${formatDuration(result.focus.longestMs)}`);
    lines.push(`  平均每段 ${formatDuration(result.focus.avgSegmentMs)}，共切换 ${result.switches} 次`);
    if (result.focus.hourlySwitches.length > 0) {
      const parts = result.focus.hourlySwitches.map((h) => `${h.hour}点 ${h.count} 次`);
      lines.push(`  每小时切换：${parts.join('，')}`);
    }
  }

  if (result.gaps.length > 0) {
    lines.push('');
    lines.push('数据空档');
    for (const g of result.gaps.slice(-8)) {
      lines.push(`  ${formatClock(g.from)}-${formatClock(g.to)}  ${formatDuration(g.ms)}`);
    }
  }

  return lines.join('\n');
}
