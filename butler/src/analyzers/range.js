// 区间分析器：把时间线整理成「这段时间干了什么」。
import { appFriendly, appCategory, searchQuery } from '../util/text.js';

export function analyzeRange(timeline, { appFilter = null } = {}) {
  const { from, to, segments, idles, clicks, navs, gaps } = timeline;
  const spanMs = Math.max(0, to - from);

  const filtered = appFilter
    ? segments.filter((s) => (s.app ?? '').toLowerCase().includes(appFilter.toLowerCase()))
    : segments;

  // 按显示名聚合（leagueclientux.exe 与 league of legends.exe 都是"英雄联盟"）
  const appBuckets = new Map();
  for (const s of filtered) {
    const ms = s.to - s.from;
    if (ms <= 0) continue;
    const name = appFriendly(s.app);
    const bucket = appBuckets.get(name) ?? { name, ms: 0, apps: new Set() };
    bucket.ms += ms;
    bucket.apps.add(s.app ?? '未知');
    appBuckets.set(name, bucket);
  }

  const idleMs = idles.reduce((sum, i) => sum + (i.to - i.from), 0);
  // 活跃 = 前台段总时长（不含空档与空闲）；未记录 = 区间里既没有前台段也没有空闲段的空白
  const activeMs = segments.reduce((sum, s) => sum + Math.max(0, s.to - s.from), 0);
  const unrecordedMs = Math.max(0, spanMs - activeMs - idleMs);

  let switches = 0;
  for (let i = 1; i < filtered.length; i++) {
    if ((filtered[i - 1].app ?? '') !== (filtered[i].app ?? '')) switches++;
  }

  const appList = [...appBuckets.values()]
    .map((b) => ({ name: b.name, apps: [...b.apps], category: appCategory([...b.apps][0]), ms: b.ms }))
    .sort((a, b) => b.ms - a.ms);

  const searches = [];
  const seen = new Set();
  for (const n of navs) {
    const q = searchQuery(n.url);
    if (!q) continue;
    const key = `${q.engine}|${q.query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    searches.push({ ts: n.ts, engine: q.engine, query: q.query });
  }

  return {
    from,
    to,
    spanMs,
    activeMs,
    idleMs,
    unrecordedMs,
    appList,
    switches,
    clickCount: clicks.length,
    searches,
    gaps,
    segments: filtered,
    navs,
  };
}
