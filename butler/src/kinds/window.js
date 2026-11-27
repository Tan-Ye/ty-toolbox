// 前台窗口事件：window.foreground 与 window.title。
// 两者语义相同（谁在前台、标题是什么），由 timeline 统一去重与切段。
import { isIgnoredApp } from '../util/text.js';

export const windowForeground = {
  id: 'window.foreground',
  kinds: ['window.foreground'],
  parse(event) {
    if (isIgnoredApp(event.app)) return null;
    return { type: 'focus', app: event.app, title: event.title ?? '', url: null, data: event.data };
  },
};

export const windowTitle = {
  id: 'window.title',
  kinds: ['window.title'],
  parse(event) {
    if (isIgnoredApp(event.app)) return null;
    return { type: 'focus', app: event.app, title: event.title ?? '', url: null, data: event.data };
  },
};
