#!/usr/bin/env node
// butler CLI：只读分析 BehaviorCollector 的事件库。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTimeArg, parseDateArg, startOfDay, formatDate, formatClock, formatClockSeconds } from './util/time.js';
import { resolveDbPath, openDb, eventsInRange, databaseStats } from './db.js';
import { buildTimeline } from './timeline.js';
import { analyzeRange } from './analyzers/range.js';
import { analyzeDaily } from './analyzers/daily.js';
import { formatRange, formatDaily } from './report/text.js';
import { registeredKinds } from './kinds/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(HERE, '../reports');

/** 把一次分析结果落盘：人读的 txt + 机器读的 json。 */
function saveReport(basename, text, data) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const txtPath = path.join(REPORTS_DIR, `${basename}.txt`);
  const jsonPath = path.join(REPORTS_DIR, `${basename}.json`);
  writeFileSync(txtPath, text + '\n', 'utf8');
  writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { txtPath, jsonPath };
}

function reportSaveHint(saved) {
  console.log(`\n已保存:\n  ${saved.txtPath}\n  ${saved.jsonPath}`);
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? 'help';
  const args = parseArgs(argv.slice(1));

  if (command === 'help' || command === '--help' || command === '-h') {
    help();
    return;
  }

  if (!['kinds', 'range', 'daily'].includes(command)) {
    console.error(`未知命令: ${command}\n`);
    help();
    process.exitCode = 1;
    return;
  }

  const dbPath = resolveDbPath(args.db);
  let db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    console.error(`无法打开数据库: ${dbPath}`);
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  try {
    if (command === 'kinds') return cmdKinds(db, dbPath);
    if (command === 'range') return cmdRange(db, args);
    if (command === 'daily') return cmdDaily(db, args);
  } finally {
    db.close();
  }
}

function cmdRange(db, args) {
  const base = args.date ? parseDateArg(args.date) : startOfDay(new Date()).getTime();
  const from = args.from ? parseTimeArg(args.from, new Date(base)) : base;
  let to = args.to ? parseTimeArg(args.to, new Date(base)) : Date.now();
  if (to <= from) to += DAY_MS; // 跨午夜
  // 未来时段没有数据，截到当下，否则最后一段会被算到未来
  if (to > Date.now()) to = Date.now();

  const events = eventsInRange(db, from, to);
  const timeline = buildTimeline(events, { from, to });
  const result = analyzeRange(timeline, { appFilter: typeof args.app === 'string' ? args.app : null });

  const text = formatRange(result, {
    appFilter: typeof args.app === 'string' ? args.app : null,
    showAll: args.all === true,
  });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(text);
  }

  if (args.save) {
    const base = `range-${formatDate(from)}-${formatClockSeconds(from).replaceAll(':', '')}-${formatClockSeconds(to).replaceAll(':', '')}`;
    reportSaveHint(saveReport(base, text, result));
  }
}

function cmdDaily(db, args) {
  const start = parseDateArg(args.date);
  const from = start;
  const to = Math.min(Date.now(), start + DAY_MS);
  if (to <= from) {
    console.error(`这一天还没开始: ${formatDate(start)}`);
    return;
  }

  const events = eventsInRange(db, from, to);
  const timeline = buildTimeline(events, { from, to });
  const result = analyzeDaily(timeline);
  result.windowMs = to - from;

  const text = formatDaily(result, { dateMs: start });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(text);
  }

  if (args.save) {
    reportSaveHint(saveReport(`daily-${formatDate(start)}`, text, result));
  }
}

function cmdKinds(db, dbPath) {
  const stats = databaseStats(db);
  console.log(`数据库: ${dbPath}`);
  console.log(`事件总数: ${stats.total}` + (stats.minTs ? `，范围 ${formatClock(stats.minTs)} 起` : '') + '\n');

  const registered = new Set(registeredKinds());
  console.log(`已注册的 kind（${registered.size} 个，分析器认识）:`);
  for (const kind of [...registered].sort()) console.log(`  ${kind}`);

  console.log('\n数据库中的 kind:');
  for (const { kind, count } of stats.kinds) {
    const mark = registered.has(kind) ? '' : '  (未注册，跳过)';
    console.log(`  ${kind.padEnd(20)} ${String(count).padStart(6)}${mark}`);
  }
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (!item.startsWith('--')) continue;
    const eq = item.indexOf('=');
    if (eq > 0) {
      out[item.slice(2, eq)] = item.slice(eq + 1);
      continue;
    }
    const key = item.slice(2);
    const next = list[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function help() {
  console.log(`butler —— 个人时间线分析器（只读 BehaviorCollector 的 events.db）

用法:
  node src/index.js kinds   [--db <path>]
  node src/index.js range   [--from 22:30] [--to 23:30] [--date 2026-11-26] [--app chrome] [--all] [--json] [--save] [--db <path>]
  node src/index.js daily   [--date 2026-11-26] [--json] [--save] [--db <path>]

说明:
  range   回放任意区间：前台时间线、应用时长、搜索、数据空档
  daily   日报：应用时长、用途分布、站点分布、搜索、专注碎片、作息
  kinds   列出已注册的事件类型与数据库里的分布

输出:
  --json     输出机器可读 JSON
  --save     把结果存到 reports/ 目录（同名 .txt 与 .json），daily 存成 daily-YYYY-MM-DD

时间参数:
  --from/--to 支持 "22:30"、"2026-11-26 22:30"、ISO 时间或 "now"，
  只写时分时按 --date 或今天补全；跨午夜会自动顺延到次日。

数据库路径:
  --db > 环境变量 BUTLER_DB > 采集器 config.json 的 storage.dataDir
  > ../behavior-collector/data/events.db`);
}

Promise.resolve(main()).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
