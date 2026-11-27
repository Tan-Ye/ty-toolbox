#!/usr/bin/env node
// butler CLI：只读分析 BehaviorCollector 的事件库。
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTimeArg, parseDateArg, startOfDay, formatDate, formatClock, formatClockSeconds, formatDuration } from './util/time.js';
import { resolveDbPath, openDb, eventsInRange, databaseStats } from './db.js';
import { buildTimeline } from './timeline.js';
import { analyzeRange } from './analyzers/range.js';
import { analyzeDaily } from './analyzers/daily.js';
import { formatRange, formatDaily } from './report/text.js';
import { buildDailyMemory, renderDailyContent, writeMemory } from './export/kotana-memory.js';
import { showToast } from './notify.js';
import { pushQq } from './notify-qq.js';
import { DEFAULT_WATCH, startWatch } from './watch.js';
import { appFriendly } from './util/text.js';
import { registeredKinds } from './kinds/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(HERE, '../reports');
/** Kotana 开发数据目录下的记忆目录；Kotana 正式运行时可换成它的 data/memories。 */
const DEFAULT_MEMORIES_DIR = path.resolve(HERE, '../../../kotana-runtime/.kotana-dev/memories');

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

  if (command === 'watch') {
    // 长任务：不进入下面的 finally（否则 db 会被立刻关闭）
    return cmdWatch(db, args);
  }

  try {
    if (command === 'kinds') return cmdKinds(db, dbPath);
    if (command === 'range') return cmdRange(db, args);
    if (command === 'daily') return cmdDaily(db, args);
    if (command === 'memory') return cmdMemory(db, args, dbPath);
    if (command === 'notify') return cmdNotify(db, args);
    console.error(`未知命令: ${command}\n`);
    help();
    process.exitCode = 1;
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

function cmdMemory(db, args, dbPath) {
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

  const base = `daily-${formatDate(start)}`;
  const txtPath = path.join(REPORTS_DIR, `${base}.txt`);
  const jsonPath = path.join(REPORTS_DIR, `${base}.json`);
  const { id, memory } = buildDailyMemory(result, {
    dateMs: start,
    reportTxt: existsSync(txtPath) ? txtPath : null,
    reportJson: existsSync(jsonPath) ? jsonPath : null,
    dbPath,
  });

  if (args['dry-run']) {
    console.log(`id: ${id}`);
    console.log(`content（${memory.content.length} 字）:`);
    console.log(memory.content);
    console.log('\nmetadata:');
    console.log(JSON.stringify(memory.metadata, null, 2));
    return;
  }

  const memoriesDir = typeof args.out === 'string' ? path.resolve(args.out) : DEFAULT_MEMORIES_DIR;
  const filePath = writeMemory(memoriesDir, memory);
  console.log(`已写入 Kotana 记忆: ${filePath}`);
  console.log(`  id: ${id}（${memory.content.length} 字）`);
  console.log(`  ${memory.content}`);
}

function cmdNotify(db, args) {
  const dryRun = args['dry-run'] === true;

  if (typeof args.text === 'string') {
    const text = args.text.trim();
    if (!text) {
      console.error('--text 不能为空');
      return;
    }

    if (dryRun) {
      console.log(`[dry-run] 将推送 QQ：\n  ${text}`);
      return;
    }

    return pushQq(text, {
      ...(typeof args.outbox === 'string' ? { outboxPath: path.resolve(args.outbox) } : {}),
    }).then(({ id, path: outboxPath }) => {
      console.log(`已入队 QQ 推送: ${id}`);
      console.log(`  队列: ${outboxPath}`);
      console.log(`  等待 Kotana 进程发送（桌面端连着 QQ 时 5 秒内发出去）。`);
    });
  }

  // 默认推昨天的日报：这个命令挂在凌晨的计划任务里。
  const start = parseDateArg(args.date, new Date(Date.now() - DAY_MS));
  const from = start;
  const to = start + DAY_MS;

  const events = eventsInRange(db, from, to);
  const timeline = buildTimeline(events, { from, to });
  const daily = analyzeDaily(timeline);
  daily.windowMs = to - from;

  const content = renderDailyContent(daily, { date: formatDate(start) });

  if (dryRun) {
    console.log(`[dry-run] 将推送 QQ 日报（${formatDate(start)}）：\n  ${content}`);
    return;
  }

  return pushQq(content, {
    ...(typeof args.outbox === 'string' ? { outboxPath: path.resolve(args.outbox) } : {}),
  }).then(({ id, path: outboxPath }) => {
    console.log(`已入队 QQ 日报推送: ${id}`);
    console.log(`  队列: ${outboxPath}`);
    console.log(`  ${content}`);
  });
}

function cmdWatch(db, args) {
  // 单实例：重复启动会重复提醒，所以先抢锁
  const lockPath = path.join(os.tmpdir(), 'butler-watch.lock');
  try {
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0); // 进程还活着
        console.error(`watch 已经在运行（PID ${pid}），不要重复启动。`);
        console.error(`如果是上次异常退出留下的锁，删掉 ${lockPath} 再试。`);
        process.exitCode = 1;
        return;
      } catch {
        // 进程已不在，锁是残留的，继续
      }
    }
  } catch {
    // 没有锁文件
  }
  writeFileSync(lockPath, String(process.pid), 'utf8');

  return runWatchLoop(db, args, lockPath);
}

async function runWatchLoop(db, args, lockPath) {
  const cleanup = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  const opts = { ...DEFAULT_WATCH };
  if (args.interval) opts.intervalMs = Math.max(10, Number(args.interval)) * 1000;
  if (args.focus) opts.focusWarnMs = Math.max(1, Number(args.focus)) * 60_000;
  if (args.switches) opts.switchWarnCount = Math.max(1, Number(args.switches));
  if (args.late) {
    const [h, m] = String(args.late).split(':').map(Number);
    if (Number.isFinite(h)) opts.lateFromMinute = h * 60 + (Number.isFinite(m) ? m : 0);
  }
  const dryRun = args['dry-run'] === true;
  const lateClock = `${String(Math.floor(opts.lateFromMinute / 60)).padStart(2, '0')}:${String(opts.lateFromMinute % 60).padStart(2, '0')}`;

  console.log(`watch 启动：每 ${opts.intervalMs / 1000} 秒看一眼，专注 ${opts.focusWarnMs / 60000} 分钟提醒，1 小时切换 ${opts.switchWarnCount} 次提醒，${lateClock} 后提醒休息`);
  if (dryRun) console.log('（dry-run：只打印，不弹通知）');

  if (args.test) {
    const result = await showToast({ title: '大肥鱼', message: '测试通知：watch 已经就绪' });
    console.log(result.ok ? '测试通知已发送' : `测试通知失败: ${result.error ?? result.code}`);
    cleanup();
    return;
  }

  const onAlert = (alert) => {
    console.log(`[${formatClock(Date.now())}] 提醒: ${alert.message}`);
    if (dryRun) return;
    // 两个出口各管一路：桌面右下角立刻能看到，QQ 走 Kotana 的 outbox 带到手机。
    void pushQq(alert.message).catch((err) => console.error('QQ 提醒入队失败:', err.message));
    return showToast({ title: '大肥鱼', message: alert.message, onError: (err) => console.error('通知发送失败:', err.message) });
  };

  const onTick = (snap, alerts) => {
    if (!args.verbose && !args.once) return;
    const state = snap.active
      ? `活跃 ${formatDuration(snap.current?.ms ?? 0)}${snap.current ? ' · ' + appFriendly(snap.current.app) : ''}`
      : snap.idleOpen ? '空闲中' : '无活动';
    console.log(`[${formatClock(Date.now())}] ${state} · 1 小时切换 ${snap.switches} 次 · 命中规则 ${alerts.length} 条`);
  };

  if (args.once) {
    await startWatch(db, { opts, onAlert, onTick, once: true });
    return;
  }
  await startWatch(db, { opts, onAlert, onTick });
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
  node src/index.js range   [--from 22:30] [--to 23:30] [--date 2026-11-26] [--app chrome] [--all] [--json] [--save]
  node src/index.js daily   [--date 2026-11-26] [--json] [--save] [--db <path>]
  node src/index.js memory  [--date 2026-11-26] [--out <memories目录>] [--dry-run] [--db <path>]
  node src/index.js notify  [--date 2026-11-26] [--text "想说的话"] [--outbox <qq.jsonl>] [--db <path>]
  node src/index.js watch   [--interval 60] [--focus 45] [--switches 30] [--late 23:30] [--once] [--verbose] [--dry-run] [--test]

说明:
  range   回放任意区间：前台时间线、应用时长、搜索、数据空档
  daily   日报：应用时长、用途分布、站点分布、搜索、专注碎片、作息
  memory  把日报写成一条 Kotana 长期记忆（一天一条，id 固定，重复导入会覆盖）
  notify  把日报摘要推进 Kotana 的 QQ outbox（默认昨天；也可 --text 直接推一段），由 Kotana 进程发送
  kinds   列出已注册的事件类型与数据库里的分布
  watch   常驻观察：每 60 秒看一眼当下，命中规则（连续专注/深夜/切换过频）就弹通知并推 QQ

输出:
  --json     输出机器可读 JSON
  --save     把结果存到 reports/ 目录（同名 .txt 与 .json），daily 存成 daily-YYYY-MM-DD
  --dry-run  memory 命令只打印要写入的内容，不落盘；watch 命令只打印不弹通知

watch 参数:
  --interval 秒     检查间隔，默认 60
  --focus 分钟      同一窗口连续专注多久提醒，默认 45
  --switches 次     最近 1 小时切换超过多少次提醒，默认 30
  --late HH:MM      几点后仍活跃提醒休息，默认 23:30
  --once            只检查一轮就退出（配合 --verbose 看状态）
  --verbose         每轮打印当前状态
  --test            只弹一条测试通知
  --dry-run         只打印命中的提醒，不弹通知

记忆写入位置:
  默认 ../../kotana-runtime/.kotana-dev/memories（Kotana 开发数据目录）
  可用 --out 指定，或换成 Kotana 正式运行的 data/memories。

时间参数:
  --from/--to 支持 "22:30"、"2026-11-26 22:30"、ISO 时间或 "now"，
  只写时分时按 --date 或今天补全；跨午夜会自动顺延到次日。

数据库默认位置: ../behavior-collector/data/events.db
也可用环境变量 BUTLER_DB 或 --db 指定。`);
}

// main 对 watch 返回 Promise、对其他命令同步返回 undefined，统一用 Promise.resolve 兜住
Promise.resolve(main()).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
