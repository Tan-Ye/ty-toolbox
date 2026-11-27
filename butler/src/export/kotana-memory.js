// 把 butler 日报转成 Kotana 记忆文件。
//
// Kotana 的记忆是「一条记忆一个 JSON 文件」：
//   <dataDir>/memories/<encodeURIComponent(id)>.json
//   外层 {schemaVersion:1, type:"memory", memory:{...}}
// 字段见 kotana-runtime/src/domain/memory.ts:48 与 file-memory-store.ts:41。
//
// 这里不 import Kotana 的代码：Kotana 是 TypeScript 项目且已冻结，
// 记忆文件是稳定的纯 JSON 格式，按格式直接写即可。
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { formatClock, formatDate, formatDuration } from '../util/time.js';

/** 记忆文件格式版本，与 Kotana 的 MEMORY_SCHEMA_VERSION 保持一致。 */
const MEMORY_SCHEMA_VERSION = 1;

/** Kotana 注入记忆时单条正文的截断长度（prompt-assembler.ts:43）。 */
const MAX_CONTENT_LENGTH = 200;

/** 用途分布占比。 */
function pct(part, whole) {
  if (!whole || whole <= 0) return '0%';
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * 生成日报记忆的正文。
 *
 * 正文是给「字面检索」用的：日期、应用名、搜索词都要出现，
 * 用户问「11月26日做了什么」「最近在玩什么」才能命中。
 * 控制在 200 字内，否则 Kotana 注入时会截断。
 */
export function renderDailyContent(daily, { date }) {
  // 整天没开机/没采到数据时，也给一条极短的记忆：确认「那天没有活动」本身是有用的信息。
  if (daily.activeMs < 60_000) {
    return `${date} 使用记录：无前台活动记录。`;
  }

  const topApps = daily.appList.slice(0, 5);
  const topCategories = daily.categories.slice(0, 3);
  const searches = daily.searches.map((s) => s.query).filter(Boolean);
  const biggestGap = daily.gaps.reduce((max, g) => (g.ms > (max?.ms ?? 0) ? g : max), null);

  const parts = [];
  const push = (text) => {
    if (parts.join('').length + text.length <= MAX_CONTENT_LENGTH) parts.push(text);
  };

  push(`${date} 使用记录：活跃${formatDuration(daily.activeMs)}，切换${daily.switches}次，点击${daily.clickCount}次。`);

  if (topApps.length > 0) {
    push(`应用：${topApps.map((a) => `${a.name} ${formatDuration(a.ms)}`).join('、')}。`);
  }

  if (topCategories.length > 0) {
    push(`用途：${topCategories.map((c) => `${c.category} ${pct(c.ms, daily.activeMs)}`).join('、')}。`);
  }

  if (searches.length > 0) {
    const shown = searches.slice(0, 5).join('、');
    const more = searches.length > 5 ? ` 等${searches.length}条` : '';
    push(`搜索：${shown}${more}。`);
  }

  if (daily.focus.longestMs > 0) {
    push(`最长专注：${daily.focus.longestApp ?? '未知'} ${formatDuration(daily.focus.longestMs)}。`);
  }

  if (biggestGap && biggestGap.ms >= 30 * 60 * 1000) {
    push(`空档：${formatClock(biggestGap.from)}-${formatClock(biggestGap.to)}。`);
  }

  return parts.join('');
}

/**
 * 把 analyzeDaily 的结果转成一条 Kotana 记忆。
 *
 * 固定 id（butler-daily-YYYY-MM-DD）保证同一天重复导入是覆盖而不是新增，
 * 所以导入天然幂等。
 */
export function buildDailyMemory(daily, { dateMs, reportTxt = null, reportJson = null, dbPath = null }) {
  const date = formatDate(dateMs);
  const id = `butler-daily-${date}`;
  const createdAt = new Date(daily.to).toISOString();

  const memory = {
    id,
    // event：记录「某天发生了什么」，不是偏好也不是指令。
    type: 'event',
    content: renderDailyContent(daily, { date }),
    status: 'active',
    tags: buildTags(daily, date),
    metadata: {
      source: 'butler',
      kind: 'daily',
      date,
      events: { from: daily.from, to: daily.to },
      database: dbPath,
      reports: { txt: reportTxt, json: reportJson },
      stats: {
        activeMs: daily.activeMs,
        idleMs: daily.idleMs,
        unrecordedMs: daily.unrecordedMs,
        switches: daily.switches,
        clicks: daily.clickCount,
        appCount: daily.appList.length,
        searchCount: daily.searches.length,
      },
      topApps: daily.appList.slice(0, 5).map((a) => ({ name: a.name, ms: a.ms })),
      categories: daily.categories.map((c) => ({ category: c.category, ms: c.ms })),
      searches: daily.searches.map((s) => s.query).filter(Boolean),
      generatedAt: new Date().toISOString(),
    },
    createdAt,
    updatedAt: createdAt,
  };

  return { id, memory };
}

/** 标签参与检索加权，日期与主要用途类别都放进去。 */
function buildTags(daily, date) {
  const tags = ['日报', '使用记录', date];
  for (const c of daily.categories.slice(0, 3)) {
    if (c.category && !tags.includes(c.category)) tags.push(c.category);
  }
  return tags;
}

/**
 * 把记忆写成 Kotana 的 JSON 文件。
 *
 * 先写临时文件再 rename，避免 Kotana 读到半截 JSON
 *（与 file-memory-store.ts 的 writeAtomically 同样的做法）。
 */
export function writeMemory(memoriesDir, memory) {
  mkdirSync(memoriesDir, { recursive: true });
  const filePath = path.join(memoriesDir, `${encodeURIComponent(memory.id)}.json`);
  const document = { schemaVersion: MEMORY_SCHEMA_VERSION, type: 'memory', memory };
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, filePath);
  } finally {
    // rename 成功后临时文件已不存在；失败时清理残留。
    try { unlinkSync(temporaryPath); } catch { /* 忽略 */ }
  }

  return filePath;
}
