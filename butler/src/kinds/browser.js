// 浏览器事件：browser.activate（切到某个标签页）与 browser.nav（页面导航）。
// 只认 http/https；chrome:// 等内部页返回 null，由注册表跳过。
import { hostOf } from '../util/text.js';

export const browser = {
  id: 'browser',
  kinds: ['browser.activate', 'browser.nav'],
  parse(event) {
    const host = hostOf(event.url);
    if (!host) return null;
    return {
      type: 'browser',
      phase: event.kind === 'browser.nav' ? 'nav' : 'activate',
      url: event.url,
      title: event.title ?? '',
      host,
      data: event.data,
    };
  },
};
