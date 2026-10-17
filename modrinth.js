'use strict';
/**
 * Wayfire: каталог модов, текстурпаков и шейдеров через открытый API Modrinth (бесплатно, без ключа).
 * Работает в главном процессе Electron: так можно задать обязательный заголовок User-Agent и нет проблем с CORS.
 * Карты на Modrinth отсутствуют, они есть на CurseForge (нужен ключ разработчика).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.modrinth.com/v2';
const PROJECT_TYPE = { mod: 'mod', texture: 'resourcepack', shader: 'shader' };
const DIR = { mod: 'mods', texture: 'resourcepacks', shader: 'shaderpacks', map: 'saves' };
const LOADERS = ['forge', 'fabric', 'neoforge', 'quilt'];
const INDEX = ['relevance', 'downloads', 'newest'];
const cap = s => (s === 'neoforge' ? 'NeoForge' : s.charAt(0).toUpperCase() + s.slice(1));

function stripMd(t) {
  return String(t || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>~|]/g, '')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, 900);
}

/**
 * @param {object} o
 * @param {string} [o.userAgent]  Modrinth просит уникальный User-Agent, например "твойник/wayfire/0.1.0 (почта)"
 * @param {string}  o.root        папка со сборками
 * @param {function}[o.fetch]     подмена fetch (для тестов)
 */
function createModrinth(o) {
  const f = o.fetch || globalThis.fetch;
  const ua = o.userAgent || 'Wayfire/1.0.0';
  const root = o.root;

  async function get(p, params) {
    const u = new URL(API + p);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    let r;
    try { r = await f(u, { headers: { 'User-Agent': ua, Accept: 'application/json' } }); }
    catch (e) { throw new Error('Нет связи с Modrinth. Проверь интернет.'); }
    if (r.status === 429) throw new Error('Modrinth просит подождать: слишком много запросов.');
    if (!r.ok) throw new Error('Modrinth вернул ошибку ' + r.status + '.');
    return r.json();
  }

  async function search({ cat, q, ver, loader, sort, offset, limit }) {
    const type = PROJECT_TYPE[cat];
    if (!type) return { items: [], total: 0, note: 'На Modrinth нет карт. Карты есть на CurseForge.' };
    const facets = [['project_type:' + type]];
    if (ver) facets.push(['versions:' + ver]);
    if (loader && cat === 'mod') facets.push(['categories:' + String(loader).toLowerCase()]);
    const d = await get('/search', { query: q || undefined, facets, index: INDEX[sort] || 'relevance', offset: offset || 0, limit: limit || 20 });
    return {
      total: d.total_hits || 0,
      items: (d.hits || []).map(h => ({
        id: h.project_id, slug: h.slug, cat, name: h.title, au: h.author, dl: h.downloads || 0, d: h.description || '',
        lo: (h.categories || []).filter(c => LOADERS.includes(c)).map(cap),
        ve: (h.versions || []).slice(-3).reverse(),
        icon: h.icon_url || '', feat: h.featured_gallery || (h.gallery && h.gallery[0]) || '',
        sr: ['m'], dp: [], real: true
      }))
    };
  }

  async function project(id) {
    const p = await get('/project/' + encodeURIComponent(id));
    return {
      body: stripMd(p.body),
      shots: (p.gallery || []).map(g => g.url).slice(0, 6),
      loaders: (p.loaders || []).filter(l => LOADERS.includes(l)).map(cap),
      versions: (p.game_versions || []).slice(-8).reverse()
    };
  }

  async function gameVersions() {
    const v = await get('/tag/game_version');
    return v.filter(x => x.version_type === 'release')
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(x => x.version).slice(0, 14);
  }

  async function pickVersion(pid, ver, loader) {
    const vs = await get('/project/' + encodeURIComponent(pid) + '/version', {
      game_versions: ver ? [ver] : undefined,
      loaders: loader ? [loader] : undefined
    });
    return vs.find(v => v.version_type === 'release') || vs[0] || null;
  }

  /** Подбирает версию под сборку и находит обязательные зависимости. */
  async function plan({ id, title, cat, ver, loader }) {
    const files = [], seen = new Set(), missing = [];
    const ld = cat === 'mod' ? String(loader || '').toLowerCase() : '';
    async function visit(pid, depth, main) {
      if (seen.has(pid)) return;
      seen.add(pid);
      const v = await pickVersion(pid, ver, ld);
      if (!v || !v.files || !v.files.length) {
        if (main) throw new Error('Нет подходящей версии для Minecraft ' + (ver || '') + (ld ? ' и ' + cap(ld) : '') + '.');
        missing.push(pid);
        return;
      }
      const file = v.files.find(x => x.primary) || v.files[0];
      let name = title;
      if (!main) { try { name = (await get('/project/' + encodeURIComponent(pid))).title; } catch (e) { name = pid; } }
      files.push({ project_id: pid, title: name, version: v.version_number, filename: file.filename, url: file.url,
        sha512: file.hashes && file.hashes.sha512, size: file.size, main, kind: cat });
      if (depth < 4) {
        for (const d of v.dependencies || []) {
          if (d.dependency_type === 'required' && d.project_id) await visit(d.project_id, depth + 1, false);
        }
      }
    }
    await visit(id, 0, true);
    return { files, missing };
  }

  /* ---- файлы сборки ---- */
  const safeId = id => { if (!/^[a-z0-9_-]{1,40}$/i.test(String(id))) throw new Error('Некорректный номер сборки'); return String(id); };
  const buildDir = id => path.join(root, safeId(id));
  const kindDir = (id, kind) => {
    if (!DIR[kind]) throw new Error('Неизвестный тип файла');
    return path.join(buildDir(id), DIR[kind]);
  };
  const safeName = n => { const b = path.basename(String(n)); if (!b || b.startsWith('.')) throw new Error('Некорректное имя файла'); return b; };

  async function install({ buildId, files }, onProgress) {
    const saved = [];
    for (let i = 0; i < files.length; i++) {
      const x = files[i];
      const dir = kindDir(buildId, x.kind);
      fs.mkdirSync(dir, { recursive: true });
      const name = safeName(x.filename);
      const dest = path.join(dir, name);
      if (onProgress) onProgress({ filename: name, i: i + 1, n: files.length });
      let r;
      try { r = await f(x.url, { headers: { 'User-Agent': ua } }); }
      catch (e) { throw new Error('Нет связи при скачивании «' + name + '».'); }
      if (!r.ok) throw new Error('Не удалось скачать «' + name + '» (' + r.status + ').');
      const buf = Buffer.from(await r.arrayBuffer());
      if (x.sha512 && crypto.createHash('sha512').update(buf).digest('hex') !== x.sha512) {
        throw new Error('Файл «' + name + '» повреждён: контрольная сумма не совпала.');
      }
      fs.writeFileSync(dest + '.part', buf);
      fs.renameSync(dest + '.part', dest);
      saved.push(name);
    }
    return { ok: true, saved };
  }

  function toggle(buildId, filename, on) {
    const p = path.join(kindDir(buildId, 'mod'), safeName(filename));
    if (on && fs.existsSync(p + '.disabled')) fs.renameSync(p + '.disabled', p);
    if (!on && fs.existsSync(p)) fs.renameSync(p, p + '.disabled');
    return true;
  }
  function remove(buildId, kind, filename) {
    const p = path.join(kindDir(buildId, kind), safeName(filename));
    for (const q of [p, p + '.disabled']) if (fs.existsSync(q)) fs.unlinkSync(q);
    return true;
  }
  function saveLocal(buildId, kind, filename, data) {
    const dir = kindDir(buildId, kind);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, safeName(filename)), Buffer.from(data));
    return true;
  }
  function ensureDir(buildId) { fs.mkdirSync(buildDir(buildId), { recursive: true }); return buildDir(buildId); }

  return { search, project, gameVersions, plan, install, toggle, remove, saveLocal, ensureDir };
}

/** Подключает каталог к IPC. */
function registerMods({ ipcMain, send, root, shell, userAgent }) {
  const m = createModrinth({ root, userAgent });
  ipcMain.handle('mods:search', (_e, p) => m.search(p || {}));
  ipcMain.handle('mods:project', (_e, id) => m.project(id));
  ipcMain.handle('mods:versions', () => m.gameVersions());
  ipcMain.handle('mods:plan', (_e, p) => m.plan(p));
  ipcMain.handle('mods:install', (_e, p) => m.install(p, prog => send('mods:progress', prog)));
  ipcMain.handle('mods:toggle', (_e, id, name, on) => m.toggle(id, name, on));
  ipcMain.handle('mods:remove', (_e, id, kind, name) => m.remove(id, kind, name));
  ipcMain.handle('mods:saveLocal', (_e, id, kind, name, data) => m.saveLocal(id, kind, name, data));
  ipcMain.handle('mods:showFolder', (_e, id) => { shell.openPath(m.ensureDir(id)); return true; });
}

module.exports = { createModrinth, registerMods, stripMd };
