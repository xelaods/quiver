const { app, BrowserWindow, Menu, shell, desktopCapturer, ipcMain, Tray, nativeImage } = require('electron');
const path = require('path');
const crypto = require('crypto');
const { createApi } = require('./api');

const VENDOR_ID = 0xcafe; // HID Remapper
const ICON = path.join(__dirname, 'build', 'icon.png');

let win = null;
let tray = null;
let keepAlive = false; // 自動切り替え中・API使用中は、閉じてもトレイで動き続ける
let keepAliveAuto = false;
let keepAliveApi = false;
let quitting = false;
let captureSourceId = null;

// 二重起動しない（2つ目を開こうとしたら、今のウィンドウを前に出す）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function ensureTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Quiver（自動切り替え中）');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Quiver を開く', click: showWindow },
    { type: 'separator' },
    { label: '終了', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 1000,
    minHeight: 660,
    backgroundColor: '#050505',
    title: 'Quiver',
    icon: ICON,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#050505', symbolColor: '#a3a3a3', height: 44 },
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      // 最小化・トレイ中も画面の判定を止めない
      backgroundThrottling: false,
    },
  });

  const ses = win.webContents.session;

  // WebHID: デバイス選択ダイアログの代わりに HID Remapper を自動で選ぶ
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const d = details.deviceList.find((x) => x.vendorId === VENDOR_ID) || details.deviceList[0];
    callback(d ? d.deviceId : '');
  });
  ses.setPermissionCheckHandler((_wc, permission) =>
    permission === 'hid' || permission === 'clipboard-sanitized-write' || permission === 'media');
  ses.setDevicePermissionHandler((details) => details.deviceType === 'hid' && details.device.vendorId === VENDOR_ID);

  // 画面キャプチャ：選択ダイアログを出さず、設定で選んだ画面をそのまま使う
  ses.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const src = sources.find((s) => s.id === captureSourceId) || sources[0];
      callback(src ? { video: src } : {});
    } catch {
      callback({});
    }
  });

  win.on('close', (e) => {
    if (keepAlive && !quitting) {
      e.preventDefault();
      win.hide();
      ensureTray();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

ipcMain.handle('quiver:screens', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 240, height: 135 } });
  return sources.map((s, i) => ({ id: s.id, name: s.name || `画面 ${i + 1}`, thumb: s.thumbnail.toDataURL() }));
});
ipcMain.on('quiver:capture-source', (_e, id) => { captureSourceId = id || null; });
function applyKeepAlive() {
  keepAlive = keepAliveAuto || keepAliveApi;
  if (keepAlive) ensureTray();
  else if (tray) { tray.destroy(); tray = null; }
  if (tray) tray.setToolTip(keepAliveApi && keepAliveAuto ? 'Quiver（自動切り替え・API）' : keepAliveApi ? 'Quiver（API待機中）' : 'Quiver（自動切り替え中）');
}
ipcMain.on('quiver:keep-alive', (_e, on) => { keepAliveAuto = !!on; applyKeepAlive(); });

// ---- 外部ソフト用のローカルAPI ----
// 実際の送信（WebHID）は画面側が持っているので、画面側に頼んで結果を待つ
let deviceState = { connected: false, canMove: false, mouseMode: false, name: '' };
const pending = new Map();
let reqSeq = 0;
function askRenderer(op, args) {
  return new Promise((resolve, reject) => {
    if (!win || win.isDestroyed()) return reject(new Error('Quiver の画面が開いていません'));
    const id = ++reqSeq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('デバイスから応答がありません')); }, 2000);
    pending.set(id, { resolve, reject, timer });
    win.webContents.send('quiver:api-req', { id, op, args });
  });
}
ipcMain.on('quiver:api-res', (_e, { id, ok, error }) => {
  const p = pending.get(id);
  if (!p) return;
  clearTimeout(p.timer); pending.delete(id);
  ok ? p.resolve() : p.reject(new Error(error || '失敗しました'));
});
const api = createApi({
  sendMove: (dx, dy, step, replace) => askRenderer('move', { dx, dy, step, replace }),
  getDevice: () => deviceState,
  onLog: (entry) => { if (win && !win.isDestroyed()) win.webContents.send('quiver:api-log', entry); },
});
ipcMain.on('quiver:api-device', (_e, d) => { deviceState = { ...deviceState, ...d }; });
ipcMain.handle('quiver:api-config', async (_e, c) => {
  const r = await api.configure({ enabled: !!c.enabled, port: c.port | 0 || 47810, token: String(c.token || '') });
  keepAliveApi = !!c.enabled && r.listening;
  applyKeepAlive();
  return r;
});
ipcMain.handle('quiver:new-token', () => crypto.randomBytes(18).toString('base64url'));
ipcMain.handle('quiver:cursor', () => api.cursorPhysical());

Menu.setApplicationMenu(null);
app.whenReady().then(createWindow);
app.on('before-quit', () => { quitting = true; api.stop(); });
app.on('window-all-closed', () => app.quit());
