'use strict';
const { app, BrowserWindow, ipcMain, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { createAuth } = require('./auth');
const { registerNet } = require('./net');
const { registerMods } = require('./modrinth');
const { prepare: prepareLaunch } = require('./mclauncher');
const { createGame } = require('./game');
const { mcVersions, loaderVersions } = require('./versions');
const { applySkin } = require('./skin');

// Настройки читаются из config.json (рядом с этим файлом). Переменные WAYFIRE_CLIENT_ID и WAYFIRE_UA главнее.
let config = {};
try { config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch (e) { /* файла нет или он сломан */ }
// Application (client) ID из Azure (см. README, шаг 3)
const CLIENT_ID = process.env.WAYFIRE_CLIENT_ID || config.clientId || 'ВСТАВЬ_СВОЙ_CLIENT_ID';
// Modrinth просит уникальный User-Agent с контактом
const USER_AGENT = process.env.WAYFIRE_UA || config.userAgent || 'wayfire-launcher/1.0.0';

// Токен обновления хранится зашифрованным средствами системы, а не в открытом виде.
const sessionFile = () => path.join(app.getPath('userData'), 'session.bin');
const store = {
  async load() {
    try {
      const b = fs.readFileSync(sessionFile());
      return JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(b) : b.toString());
    } catch (e) { return null; }
  },
  async save(obj) {
    const s = JSON.stringify(obj);
    fs.writeFileSync(sessionFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(s) : Buffer.from(s));
  },
  async clear() { try { fs.unlinkSync(sessionFile()); } catch (e) { /* файла нет */ } }
};

const SAFE_URL = /^https:\/\/([a-z0-9-]+\.)*(microsoft\.com|minecraft\.net|live\.com|microsoftonline\.com|xbox\.com)(\/|$)/;

let win = null;
let auth = null;

// Режим входа:
//  microsoft: свой вход через Microsoft (нужен CLIENT_ID из Azure и одобрение Mojang)
//  official:  игра запускается через официальный Minecraft Launcher, он сам входит в аккаунт и проверяет лицензию
// Если CLIENT_ID не заполнен, включается official. Можно задать явно: "authMode" в config.json.
const hasClient = !/ВСТАВЬ/.test(CLIENT_ID);
const wanted = process.env.WAYFIRE_AUTH_MODE || config.authMode;
// По умолчанию игра запускается самим Wayfire в офлайн-режиме: вход через Microsoft не нужен.
const MODE = wanted === 'microsoft' || wanted === 'official' || wanted === 'offline' ? wanted : 'offline';

// Проверка лицензии делается здесь, в главном процессе, а не только в интерфейсе:
// сетевые функции игры не работают, пока не подтверждён аккаунт с Minecraft: Java Edition.
let session = null;
// Токен игры хранится только здесь. Окну лаунчера отдаётся результат без него.
const setSession = r => {
  session = r && r.ok && r.licensed ? { name: r.name, uuid: r.uuid, token: r.mcToken, at: Date.now() } : null;
  if (!r) return r;
  const { mcToken, ...safe } = r; // eslint-disable-line no-unused-vars
  return safe;
};
const requireLicense = () => { if (MODE === 'official' || MODE === 'offline') return; if (!session) throw new Error('Нужна подтверждённая лицензия Minecraft: Java Edition. Войди через Microsoft.'); };

const offlineUuid = name => {
  const h = require('crypto').createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80;
  return h.toString('hex');
};
const cleanNick = n => {
  const v = String(n || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  return v.length >= 3 ? v : 'Player';
};

const send = (channel, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); };

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 900, minHeight: 600,
    backgroundColor: '#000000', title: 'Wayfire',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(({ url }) => { if (SAFE_URL.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.loadFile('launcher.html');
}

app.whenReady().then(() => {
  try {
    if (MODE === 'microsoft') auth = createAuth({ clientId: CLIENT_ID, store, onProgress: p => send('auth:progress', p) });
  } catch (e) {
    console.error('[Wayfire]', e.message);
  }

  ipcMain.handle('auth:start', async () => {
    if (!auth) throw new Error('Не указан CLIENT_ID приложения Azure (см. README, шаг 2)');
    const { code, done } = await auth.start();
    done.then(result => send('auth:result', setSession(result)));
    return code;
  });
  ipcMain.handle('auth:restore', async () => (auth ? setSession(await auth.restore()) : null));
  ipcMain.handle('auth:signout', async () => { session = null; return auth ? auth.signOut() : null; });
  ipcMain.handle('auth:cancel', async () => { if (auth) auth.cancel(); });
  ipcMain.handle('auth:open', async (_e, url) => { if (typeof url === 'string' && SAFE_URL.test(url)) shell.openExternal(url); });

  // Игра с друзьями (нужна лицензия) и каталог модов (открытый, лицензия не нужна)
  registerNet({ ipcMain, send, requireLicense });
  registerMods({ ipcMain, send, shell, userAgent: USER_AGENT, root: path.join(app.getPath('userData'), 'builds') });

  // Прямой запуск игры (режим microsoft): файлы с серверов Mojang, проверка сумм, запуск с токеном аккаунта
  const game = createGame({ root: path.join(app.getPath('userData'), 'game'), userAgent: USER_AGENT });
  ipcMain.handle('game:start', async (_e, p) => {
    if (MODE === 'official') throw new Error('Сейчас игра запускается через официальный лаунчер (authMode "official" в config.json).');
    let account;
    if (MODE === 'offline') {
      // Офлайн-аккаунт: ник из лаунчера, токен не нужен
      const name = cleanNick(p && p.nick);
      account = { name, uuid: offlineUuid(name), token: '0', userType: 'legacy' };
    } else {
      if (!session) throw new Error('Нужна подтверждённая лицензия Minecraft: Java Edition. Войди через Microsoft.');
      if (Date.now() - session.at > 20 * 3600 * 1000 && auth) setSession(await auth.restore()); // токен живёт около суток
      if (!session) throw new Error('Вход устарел. Войди через Microsoft ещё раз.');
      account = { name: session.name, uuid: session.uuid, token: session.token, userType: 'msa' };
    }
    const b = p && p.build, s = (p && p.settings) || {};
    if (!b || !/^[a-z0-9_-]{1,40}$/i.test(String(b.id))) throw new Error('Не выбрана сборка');
    const settings = {
      ram: Math.max(1, Math.min(32, parseInt(s.ram, 10) || 4)), jvm: String(s.jvm || '').slice(0, 300),
      java: s.java === 'Свой путь' ? 'Свой путь' : '', javaPath: String(s.javaPath || '').slice(0, 300),
      w: parseInt(s.w, 10) || 0, h: parseInt(s.h, 10) || 0, full: !!s.full
    };
    const gameDir = path.join(app.getPath('userData'), 'builds', String(b.id));
    try { fs.mkdirSync(gameDir, { recursive: true }); applySkin(gameDir, p && p.skin); } catch (e) { /* скин не критичен для запуска */ }
    return game.start({
      build: { version: String(b.version || ''), type: String(b.type || ''), loader: String(b.loader || '') },
      gameDir,
      auth: account,
      settings, onProgress: pr => send('game:progress', pr)
    });
  });


  // Списки версий и удаление сборок
  ipcMain.handle('versions:mc', async () => mcVersions(globalThis.fetch));
  ipcMain.handle('versions:loader', async (_e, loader, mc) => {
    if (!['Fabric', 'Quilt', 'Forge', 'NeoForge'].includes(loader) || !/^[A-Za-z0-9._ -]{1,40}$/.test(String(mc))) return [];
    return loaderVersions(globalThis.fetch, loader, String(mc));
  });
  ipcMain.handle('builds:delete', async (_e, id) => {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(id))) throw new Error('Некорректный номер сборки.');
    const base = path.resolve(app.getPath('userData'), 'builds'), dir = path.resolve(base, String(id));
    if (dir === base || !dir.startsWith(base + path.sep)) throw new Error('Некорректный путь.');
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  });

  ipcMain.on('app:quit', () => app.quit());
  ipcMain.on('app:mode', e => { e.returnValue = MODE; });
  // Добавляет сборку профилем в официальный Minecraft Launcher
  ipcMain.handle('launch:prepare', async (_e, b) => {
    if (!b || typeof b !== 'object') throw new Error('Не выбрана сборка');
    const id = String(b.id || '');
    if (!/^[a-z0-9_-]{1,40}$/i.test(id)) throw new Error('Некорректный номер сборки');
    const buildDir = path.join(app.getPath('userData'), 'builds', id);
    return prepareLaunch({ build: { id, name: String(b.name || id), version: String(b.version || ''), type: String(b.type || '') }, buildDir, userAgent: USER_AGENT });
  });

  createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
