// 只读打开 BehaviorCollector 的 events.db，提供查询与统计。
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECTOR_ROOT = path.resolve(HERE, '../../behavior-collector');
const DEFAULT_DB = path.resolve(COLLECTOR_ROOT, 'data/events.db');

/**
 * 库路径优先级：--db 参数 > BUTLER_DB 环境变量 > 采集器 config.json 的
 * storage.dataDir > 旧默认 data/events.db。
 * 跟随配置能避免采集器换了数据目录、分析器还读旧库的问题。
 */
export function resolveDbPath(arg) {
  if (arg) return path.resolve(arg);
  if (process.env.BUTLER_DB) return path.resolve(process.env.BUTLER_DB);

  const fromConfig = dbPathFromCollectorConfig();
  if (fromConfig) return fromConfig;
  return DEFAULT_DB;
}

function dbPathFromCollectorConfig() {
  try {
    const configPath = path.join(COLLECTOR_ROOT, 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const dataDir = config?.storage?.dataDir;
    if (typeof dataDir !== 'string' || dataDir.trim() === '') return null;
    return path.resolve(COLLECTOR_ROOT, dataDir, 'events.db');
  } catch {
    return null;
  }
}

export function openDb(dbPath = resolveDbPath()) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** 读取区间内的事件（ts 升序），data 列解析成对象。 */
export function eventsInRange(db, from, to, { kinds = null, app = null } = {}) {
  const where = ['ts >= ?', 'ts < ?'];
  const params = [from, to];
  if (kinds && kinds.length > 0) {
    where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
    params.push(...kinds);
  }
  if (app) {
    where.push('app = ?');
    params.push(app);
  }
  const sql = `SELECT ts, kind, source, pid, hwnd, app, title, url, data, session
               FROM events WHERE ${where.join(' AND ')} ORDER BY ts, id`;
  return db.prepare(sql).all(...params).map(normalizeEvent);
}

export function normalizeEvent(row) {
  return {
    ts: Number(row.ts),
    kind: String(row.kind),
    app: row.app ?? null,
    title: row.title ?? null,
    url: row.url ?? null,
    hwnd: row.hwnd ?? null,
    session: row.session ?? null,
    data: parseJson(row.data),
  };
}

function parseJson(s) {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** 全局统计：每种 kind 的数量、首末事件时间。 */
export function databaseStats(db) {
  const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM events GROUP BY kind ORDER BY n DESC').all();
  const span = db.prepare('SELECT MIN(ts) AS minTs, MAX(ts) AS maxTs, COUNT(*) AS total FROM events').get();
  return {
    total: Number(span.total ?? 0),
    minTs: span.minTs ? Number(span.minTs) : null,
    maxTs: span.maxTs ? Number(span.maxTs) : null,
    kinds: kinds.map((r) => ({ kind: String(r.kind), count: Number(r.n) })),
  };
}
