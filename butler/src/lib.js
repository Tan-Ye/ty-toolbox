// 函数式入口：给 Kotana 之类的外部进程直接调用，不需要走 CLI。
//
// 用法（外部项目）：
//   import { openDb, eventsInRange, buildTimeline, analyzeDaily } from 'butler';
//   const db = openDb();                       // 默认读采集器 config.json 指向的库
//   const events = eventsInRange(db, from, to);
//   const daily = analyzeDaily(buildTimeline(events, { from, to }));
//   const text = formatDaily(daily, { dateMs: from });
export { resolveDbPath, openDb, eventsInRange, databaseStats } from './db.js';
export { buildTimeline, denoiseSegments } from './timeline.js';
export { analyzeRange } from './analyzers/range.js';
export { analyzeDaily } from './analyzers/daily.js';
export { formatRange, formatDaily } from './report/text.js';
export { pushQq } from './notify-qq.js';
export { renderDailyContent, buildDailyMemory, writeMemory } from './export/kotana-memory.js';
