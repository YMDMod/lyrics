const fs = require('fs');
const path = require('path');

const CONFIG = {
  override: 'https://music-lyric.s3-private.mds.yandex.net/ymd-override/lyrics.lrc',
  api: 'https://api.music.yandex.net/',
  lrclib: 'https://lrclib.net/api/',
  requestTimeout: 2500,
  retryDelays: [300, 700],
  rateLimitPause: 5000,
  concurrency: 2,
  maxDurationDiff: 5,
  trackLimit: 5000,
  verdictLimit: 3000,
  storedTexts: 200,
  foundTtl: 30 * 24 * 3600 * 1000,
  missingTtl: 3 * 24 * 3600 * 1000,
  storageKey: 'ymdmod.lyrics.verdicts',
  saveDelay: 2000,
  logPrefix: '[ymd-lyrics] ',
};

const hashOf = (text) => {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
};

const HOOK_CODE = fs.readFileSync(path.join(__dirname, 'hook.js'), 'utf8').trim();
const HOOK_SOURCE = `(${HOOK_CODE})(${JSON.stringify({ ...CONFIG, id: hashOf(HOOK_CODE + JSON.stringify(CONFIG)) })});`;

let api = null;
let attached = null;
let enabled = false;
let timer = null;

const push = (win) => {
  const replace = enabled && api.settings.get('replace') !== false;
  win.webContents.executeJavaScript(`window.__ymdLyricsEnabled = ${enabled}; window.__ymdReplace = ${replace};`).catch(() => {});
};

const install = (win, reloadAfter = false) => {
  win.webContents.executeJavaScript(HOOK_SOURCE)
    .then(() => {
      push(win);
      if (reloadAfter) win.webContents.reload();
    })
    .catch((error) => api.log('lyrics: хук не установлен', error));
};

const reinstall = () => {
  if (attached && !attached.isDestroyed()) install(attached);
};

const forwardWarning = (event, level, message) => {
  const text = String((event && event.message) || message || '');
  if (text.startsWith(CONFIG.logPrefix)) api.log('lyrics:', text.slice(CONFIG.logPrefix.length));
};

const detach = () => {
  if (attached && !attached.isDestroyed()) {
    attached.webContents.removeListener('did-finish-load', reinstall);
    attached.webContents.removeListener('console-message', forwardWarning);
  }
  attached = null;
};

const attach = (reloadAfter = false) => {
  const win = api.mainWindow();
  if (!win || win === attached || win.isDestroyed()) return;
  detach();
  attached = win;
  win.webContents.on('did-finish-load', reinstall);
  win.webContents.on('console-message', forwardWarning);
  install(win, reloadAfter);
};

module.exports = {
  activate(host) {
    api = host;
    enabled = true;
    attach(Boolean(api.mainWindow()));
    timer = setInterval(attach, 2000);
    api.settings.onChange(() => {
      if (attached && !attached.isDestroyed()) push(attached);
    });
  },
  deactivate() {
    clearInterval(timer);
    enabled = false;
    if (attached && !attached.isDestroyed()) push(attached);
    detach();
  },
};
