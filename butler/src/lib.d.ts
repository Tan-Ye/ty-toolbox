// butler 的函数入口类型声明。与 lib.js 一一对应，供 TypeScript 项目直接 import。

/** 一行原始事件（已把 data 解析成对象）。 */
export interface ButlerEvent {
  ts: number;
  kind: string;
  hwnd: number | null;
  app: string | null;
  title: string | null;
  url: string | null;
  session: string | null;
  data: Record<string, unknown>;
}

/** 一段前台占用（同一应用同一标题同一 URL 连续）。 */
export interface Segment {
  from: number;
  to: number;
  app: string | null;
  title: string | null;
  url: string | null;
  fullscreen: boolean;
  lastConfirm: number;
}

export interface IdleSpan {
  from: number;
  to: number;
  idleMs: number;
  thresholdS: number;
}

export interface Click {
  ts: number;
  app: string | null;
}

export interface Wheel {
  ts: number;
  direction: string;
}

export interface Nav {
  ts: number;
  phase: string;
  url: string;
  title: string;
  host: string;
}

export interface Lifecycle {
  ts: number;
  phase: string;
  app: string | null;
}

export interface Gap {
  from: number;
  to: number;
  ms: number;
}

/** buildTimeline 的产物。 */
export interface Timeline {
  from: number;
  to: number;
  events: ButlerEvent[];
  segments: Segment[];
  idles: IdleSpan[];
  clicks: Click[];
  wheels: Wheel[];
  navs: Nav[];
  lifecycles: Lifecycle[];
  gaps: Gap[];
}

export interface AppBucket {
  name: string;
  apps: string[];
  category: string;
  ms: number;
}

export interface SearchHit {
  ts: number;
  engine: string;
  query: string;
}

export interface SiteBucket {
  host: string;
  count: number;
  category: string;
}

export interface HourlySwitch {
  hour: number;
  count: number;
}

/** analyzeRange 的产物。 */
export interface RangeAnalysis {
  from: number;
  to: number;
  spanMs: number;
  activeMs: number;
  idleMs: number;
  unrecordedMs: number;
  appList: AppBucket[];
  switches: number;
  clickCount: number;
  searches: SearchHit[];
  gaps: Gap[];
  segments: Segment[];
  navs: Nav[];
}

/** analyzeDaily 的产物。 */
export interface DailyAnalysis extends RangeAnalysis {
  categories: { category: string; ms: number }[];
  sites: SiteBucket[];
  focus: {
    longestMs: number;
    longestApp: string | null;
    avgSegmentMs: number;
    hourlySwitches: HourlySwitch[];
  };
  firstActivity: number | null;
  lastActivity: number | null;
}

/** node:sqlite 的 DatabaseSync；这里用 unknown 避免和宿主的 @types/node 版本耦合。 */
export type ButlerDb = unknown;

export function resolveDbPath(arg?: string | null): string;
export function openDb(dbPath?: string): ButlerDb;
export function eventsInRange(
  db: ButlerDb,
  from: number,
  to: number,
  options?: { kinds?: string[] | null; app?: string | null },
): ButlerEvent[];
export function databaseStats(db: ButlerDb): Record<string, unknown>;

export function buildTimeline(events: ButlerEvent[], range: { from: number; to: number }): Timeline;
export function denoiseSegments(segments: Segment[], minMs?: number, maxGapMs?: number): Segment[];

export function analyzeRange(timeline: Timeline, options?: { appFilter?: string | null }): RangeAnalysis;
export function analyzeDaily(timeline: Timeline): DailyAnalysis;

export function formatRange(
  result: RangeAnalysis,
  options?: { appFilter?: string | null; showAll?: boolean },
): string;
export function formatDaily(result: DailyAnalysis, options?: { dateMs?: number }): string;
