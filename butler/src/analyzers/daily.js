// 日报分析器：在区间分析之上做用途归类、站点分布、专注碎片、作息。
import { analyzeRange } from './range.js';
import { siteCategory, appFriendly } from '../util/text.js';

export function analyzeDaily(timeline) {
  const base = analyzeRange(timeline);

  // 用途归类：按应用时长聚合分类
  const categoryMs = new Map();
  for (const { category, ms } of base.appList) {
    categoryMs.set(category, (categoryMs.get(category) ?? 0) + ms);
  }
  const categories = [...categoryMs.entries()]
    .map(([category, ms]) => ({ category, ms }))
    .sort((a, b) => b.ms - a.ms);

  // 站点分布：按导航次数（同 URL 连续重复只算一次）
  const hostCounts = new Map();
  let prevUrl = null;
  for (const n of timeline.navs) {
    if (n.url === prevUrl) continue;
    prevUrl = n.url;
    hostCounts.set(n.host, (hostCounts.get(n.host) ?? 0) + 1);
  }
  const sites = [...hostCounts.entries()]
    .map(([host, count]) => ({ host, count, category: siteCategory(host) }))
    .sort((a, b) => b.count - a.count);

  // 专注：同一应用连续占用（标题变化不打断、空档才算断开）的最长一段
  let longest = 0;
  let longestApp = null;
  let runMs = 0;
  let runApp = null;
  let prevTo = null;
  for (const s of base.segments) {
    const ms = s.to - s.from;
    if (ms <= 0) continue;
    const contiguous = prevTo !== null && s.from - prevTo <= 2000;
    if (s.app === runApp && contiguous) {
      runMs += ms;
    } else {
      if (runMs > longest) {
        longest = runMs;
        longestApp = runApp;
      }
      runApp = s.app;
      runMs = ms;
    }
    prevTo = s.to;
  }
  if (runMs > longest) {
    longest = runMs;
    longestApp = runApp;
  }

  // 每小时切换次数（按本地小时）
  const hourly = new Map();
  for (let i = 1; i < base.segments.length; i++) {
    const a = base.segments[i - 1];
    const b = base.segments[i];
    if ((a.app ?? '') === (b.app ?? '') && (a.title ?? '') === (b.title ?? '')) continue;
    const hour = new Date(b.from).getHours();
    hourly.set(hour, (hourly.get(hour) ?? 0) + 1);
  }
  const hourlySwitches = [...hourly.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, count]) => ({ hour, count }));

  // 作息：第一个与最后一个有前台段的时间
  const firstActivity = base.segments.length > 0 ? base.segments[0].from : null;
  const lastActivity = base.segments.length > 0 ? base.segments[base.segments.length - 1].to : null;

  return {
    ...base,
    categories,
    sites,
    focus: {
      longestMs: longest,
      longestApp: longestApp ? appFriendly(longestApp) : null,
      avgSegmentMs: base.segments.length > 0
        ? Math.round(base.segments.reduce((sum, s) => sum + Math.max(0, s.to - s.from), 0) / base.segments.length)
        : 0,
      hourlySwitches,
    },
    firstActivity,
    lastActivity,
  };
}
