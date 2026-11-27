// 时间解析与格式化。所有时间都按本机本地时区处理（东八区）。

/** 解析命令行里的时间参数。defaultDate 用于补全 "22:30" 这种只有时分的写法。 */
export function parseTimeArg(str, defaultDate = new Date()) {
  if (str === undefined || str === null || str === '') return null;
  const s = String(str).trim();
  if (s === 'now') return Date.now();
  if (/^\d{13}$/.test(s)) return Number(s);

  let m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const d = new Date(defaultDate);
    d.setHours(Number(m[1]), Number(m[2]), Number(m[3] || 0), 0);
    return d.getTime();
  }

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();

  throw new Error(`无法解析时间: ${s}`);
}

/** 解析 --date，返回当天零点。 */
export function parseDateArg(str) {
  if (!str) return startOfDay(new Date()).getTime();
  const m = String(str).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`日期格式应为 YYYY-MM-DD: ${str}`);
  return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
}

export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function formatClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatClockSeconds(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function formatDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || ms < 0) return '-';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h}小时` : `${h}小时${rest}分`;
}

/** 把毫秒取整到分钟，用于聚合显示。 */
export function floorToMinute(ms) {
  return Math.floor(ms / 60000) * 60000;
}
