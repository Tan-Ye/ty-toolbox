// 文本与分类工具：应用名、域名、搜索词、站点与应用分类。全部是纯规则，没有网络请求。

const APP_NAMES = new Map(Object.entries({
  'explorer.exe': '资源管理器',
  'chrome.exe': 'Chrome',
  'msedge.exe': 'Edge',
  'firefox.exe': 'Firefox',
  'trae cn.exe': 'Trae',
  'code.exe': 'VS Code',
  'devenv.exe': 'Visual Studio',
  'idea64.exe': 'IntelliJ IDEA',
  'pycharm64.exe': 'PyCharm',
  'cursor.exe': 'Cursor',
  'windowsterminal.exe': 'Windows Terminal',
  'powershell.exe': 'PowerShell',
  'pwsh.exe': 'PowerShell',
  'cmd.exe': 'CMD',
  'conhost.exe': '控制台宿主',
  'dotnet.exe': '.NET',
  'deepseek harness.exe': 'DeepSeek Harness',
  'pallas.exe': 'Pallas',
  'leagueclientux.exe': '英雄联盟',
  'leagueclient.exe': '英雄联盟',
  'league of legends.exe': '英雄联盟',
  'nvidia app.exe': 'NVIDIA',
  'steam.exe': 'Steam',
  'wechat.exe': '微信',
  'weixin.exe': '微信',
  'qq.exe': 'QQ',
  'feishu.exe': '飞书',
  'lark.exe': '飞书',
  'dingtalk.exe': '钉钉',
  'wxwork.exe': '企业微信',
  'shellexperiencehost.exe': '系统外壳',
  'systemsettings.exe': '设置',
  'searchhost.exe': '搜索',
  'startmenuexperiencehost.exe': '开始菜单',
  'textinputhost.exe': '输入法',
  'behaviorcollector.exe': '采集器',
  'vmplayer.exe': 'VMware Player',
  'taskmgr.exe': '任务管理器',
  'notepad.exe': '记事本',
  'mstsc.exe': '远程桌面',
  'clash-verge.exe': 'Clash Verge',
  'ace-helper.exe': 'ACE 反作弊',
}));

const APP_CATEGORIES = new Map(Object.entries({
  'trae cn.exe': '开发',
  'code.exe': '开发',
  'devenv.exe': '开发',
  'idea64.exe': '开发',
  'pycharm64.exe': '开发',
  'cursor.exe': '开发',
  'windowsterminal.exe': '开发',
  'powershell.exe': '开发',
  'pwsh.exe': '开发',
  'cmd.exe': '开发',
  'dotnet.exe': '开发',
  'pallas.exe': '开发',
  'chrome.exe': '浏览器',
  'msedge.exe': '浏览器',
  'firefox.exe': '浏览器',
  'deepseek harness.exe': 'AI 工具',
  'leagueclientux.exe': '游戏',
  'leagueclient.exe': '游戏',
  'steam.exe': '游戏',
  'explorer.exe': '系统',
  'conhost.exe': '系统',
  'shellexperiencehost.exe': '系统',
  'systemsettings.exe': '系统',
  'searchhost.exe': '系统',
  'startmenuexperiencehost.exe': '系统',
  'textinputhost.exe': '系统',
  'nvidia app.exe': '系统工具',
  'vmplayer.exe': '系统工具',
  'taskmgr.exe': '系统工具',
  'clash-verge.exe': '系统工具',
  'ace-helper.exe': '系统工具',
  'wechat.exe': '聊天',
  'weixin.exe': '聊天',
  'qq.exe': '聊天',
  'feishu.exe': '聊天',
  'lark.exe': '聊天',
  'dingtalk.exe': '聊天',
  'wxwork.exe': '聊天',
}));

/** 不应出现在时间线里的应用（采集器自身、无窗口的系统壳）。 */
const IGNORED_APPS = new Set([
  'behaviorcollector.exe',
  'shellexperiencehost.exe',
  'startmenuexperiencehost.exe',
  'textinputhost.exe',
  'searchhost.exe',
  'conhost.exe',
  // 采集器在窗口解析失败时写入的占位值
  'unknown.exe',
  'idle.exe',
  'browser.exe',
  'openwith.exe',
  'applicationframehost.exe',
  'ace-helper.exe',
]);

export function isIgnoredApp(app) {
  if (!app) return false;
  return IGNORED_APPS.has(String(app).toLowerCase());
}

export function appFriendly(app) {
  if (!app) return '未知';
  const key = String(app).toLowerCase();
  if (APP_NAMES.has(key)) return APP_NAMES.get(key);
  const base = key.replace(/\.exe$/, '');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function appCategory(app) {
  if (!app) return '其他';
  const key = String(app).toLowerCase();
  return APP_CATEGORIES.get(key) ?? '其他';
}

/** 从 URL 安全取出 hostname；chrome:// / chrome-extension:// / file:// 等返回 null。 */
export function hostOf(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

const SEARCH_HOSTS = [
  ['bing.com', 'q', 'Bing'],
  ['baidu.com', 'wd', '百度'],
  ['google.com', 'q', 'Google'],
  ['sogou.com', 'query', '搜狗'],
  ['so.com', 'q', '360 搜索'],
  ['bilibili.com', 'keyword', '哔哩哔哩'],
  ['douyin.com', 'keyword', '抖音'],
  ['youtube.com', 'search_query', 'YouTube'],
  ['zhihu.com', 'q', '知乎'],
];

/** 如果 URL 是搜索页，返回 { engine, query }；否则 null。 */
export function searchQuery(url) {
  if (!url) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^www\./, '');
  for (const [domain, param, engine] of SEARCH_HOSTS) {
    if (host === domain || host.endsWith('.' + domain)) {
      const q = u.searchParams.get(param);
      if (q) return { engine, query: q.trim() };
    }
  }
  return null;
}

const SITE_CATEGORIES = [
  { category: '搜索', hosts: ['bing.com', 'baidu.com', 'google.com', 'sogou.com', 'so.com'] },
  { category: 'AI', hosts: ['chat.deepseek.com', 'deepseek.com', 'chat.openai.com', 'claude.ai', 'kimi.moonshot.cn', 'doubao.com', 'tongyi.aliyun.com'] },
  { category: '开发文档', hosts: ['github.com', 'gitlab.com', 'stackoverflow.com', 'developer.mozilla.org', 'nuget.org', 'npmjs.com', 'pypi.org', 'packages-prod.broadcom.com', 'techdocs.broadcom.com', 'vmware.com', 'dshmarket.com', 'learn.microsoft.com'] },
  { category: '视频', hosts: ['bilibili.com', 'youtube.com', 'douyin.com', 'v.qq.com', 'iqiyi.com', 'youku.com'] },
  { category: '购物', hosts: ['taobao.com', 'jd.com', 'pinduoduo.com', 'aliexpress.com', 'tmall.com'] },
  { category: '社区', hosts: ['zhihu.com', 'weibo.com', 'x.com', 'twitter.com', 'reddit.com', 'tieba.baidu.com'] },
  { category: '资讯', hosts: ['ithome.com', 'cnbeta.com', '36kr.com', 'thepaper.cn'] },
  { category: '游戏', hosts: ['leagueoflegends.com', 'steamcommunity.com', 'op.gg', 'lol.qq.com'] },
];

export function siteCategory(host) {
  if (!host) return '其他';
  const h = String(host).toLowerCase();
  for (const { category, hosts } of SITE_CATEGORIES) {
    if (hosts.some((d) => h === d || h.endsWith('.' + d))) return category;
  }
  return '其他';
}

const TITLE_SUFFIXES = [
  ' - Google Chrome',
  ' - Microsoft Edge',
  ' - Mozilla Firefox',
  ' - Visual Studio Code',
  ' - Chrome',
];

export function cleanTitle(title) {
  if (!title) return '';
  let t = String(title).trim();
  for (const s of TITLE_SUFFIXES) {
    if (t.endsWith(s)) t = t.slice(0, -s.length).trim();
  }
  return t;
}
