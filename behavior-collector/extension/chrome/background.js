// BehaviorCollector Chrome 扩展：只上报标签页/URL/窗口焦点事件。
// 事件先进入 chrome.storage.session 队列，通过 Native Messaging 发给本机宿主；
// 宿主在主程序未运行时落盘缓冲，主程序下次启动补录。

const HOST_NAME = "com.behaviorcollector.browser";
const QUEUE_KEY = "bc_queue";
const MAX_QUEUE = 500;
const DEDUPE_MS = 1000;

let port = null;
let chain = Promise.resolve();
const recent = new Map();

function serial(task) {
  const next = chain.then(task, task);
  chain = next.catch(() => {});
  return next;
}

function now() {
  return Date.now();
}

function makeEid() {
  return `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function shouldEmit(key) {
  const t = now();
  for (const [k, ts] of recent) {
    if (t - ts > 5000) {
      recent.delete(k);
    }
  }
  const last = recent.get(key);
  if (last && t - last < DEDUPE_MS) {
    return false;
  }
  recent.set(key, t);
  return true;
}

async function getQueue() {
  const result = await chrome.storage.session.get(QUEUE_KEY);
  return Array.isArray(result[QUEUE_KEY]) ? result[QUEUE_KEY] : [];
}

async function setQueue(items) {
  await chrome.storage.session.set({ [QUEUE_KEY]: items });
}

function enqueue(kind, tab, extra = {}) {
  if (!tab || typeof tab.id !== "number") {
    return;
  }

  const key = `${kind}|${tab.id}|${tab.url || ""}`;
  if (!shouldEmit(key)) {
    return;
  }

  const event = {
    type: "event",
    eid: makeEid(),
    kind,
    ts: now(),
    url: tab.url || "",
    title: tab.title || "",
    tabId: tab.id,
    windowId: typeof tab.windowId === "number" ? tab.windowId : -1,
    ...extra
  };

  serial(async () => {
    const items = await getQueue();
    items.push(event);
    if (items.length > MAX_QUEUE) {
      items.splice(0, items.length - MAX_QUEUE);
    }
    await setQueue(items);
  }).then(() => flushQueue());
}

function ensurePort() {
  if (port) {
    return port;
  }

  try {
    port = chrome.runtime.connectNative(HOST_NAME);
    port.onDisconnect.addListener(() => {
      port = null;
    });
  } catch (e) {
    port = null;
  }
  return port;
}

function flushQueue() {
  return serial(async () => {
    const p = ensurePort();
    if (!p) {
      return;
    }

    let items = await getQueue();
    while (items.length > 0) {
      try {
        p.postMessage(items[0]);
      } catch (e) {
        port = null;
        return;
      }
      items.shift();
      await setQueue(items);
    }
  });
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId)
    .then((tab) => enqueue("browser.activate", tab, { source: "tabs.onActivated" }))
    .catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && !changeInfo.title) {
    return;
  }
  enqueue("browser.nav", tab, { source: "tabs.onUpdated" });
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) {
    return;
  }
  chrome.tabs.get(details.tabId)
    .then((tab) => enqueue("browser.nav", tab, {
      source: "webNavigation.onCommitted",
      transition: details.transitionType || ""
    }))
    .catch(() => {});
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) {
    return;
  }
  chrome.tabs.get(details.tabId)
    .then((tab) => enqueue("browser.nav", tab, {
      spa: true,
      source: "webNavigation.onHistoryStateUpdated"
    }))
    .catch(() => {});
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    return;
  }
  chrome.tabs.query({ active: true, windowId })
    .then((tabs) => {
      if (tabs && tabs[0]) {
        enqueue("browser.activate", tabs[0], { source: "windows.onFocusChanged" });
      }
    })
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(() => flushQueue());
chrome.runtime.onInstalled.addListener(() => flushQueue());

flushQueue();
