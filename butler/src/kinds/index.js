// kind 注册表：一个 kind 对应一个解析器模块。
// 新增事件类型时，新建 src/kinds/<name>.js 并在下面注册即可；
// 未注册的 kind 会被 parseEvent 安全跳过，分析器不需要改。
import { windowForeground, windowTitle } from './window.js';
import { appLifecycle } from './app-lifecycle.js';
import { browser } from './browser.js';
import { input } from './input.js';
import { idle } from './idle.js';

const PARSERS = [windowForeground, windowTitle, appLifecycle, browser, input, idle];

export const KIND_INDEX = new Map();
for (const parser of PARSERS) {
  for (const kind of parser.kinds) KIND_INDEX.set(kind, parser);
}

/** 返回事件语义对象；未知 kind 返回 null。 */
export function parseEvent(event) {
  const parser = KIND_INDEX.get(event.kind);
  if (!parser) return null;
  return parser.parse(event);
}

export function registeredKinds() {
  return [...KIND_INDEX.keys()];
}
