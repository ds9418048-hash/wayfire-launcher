'use strict';
/**
 * Wayfire: каталог CurseForge.
 * Ключ разработчика в приложении НЕ хранится: запросы идут через небольшой сервер-посредник (Cloudflare Worker),
 * где лежит ключ. Адрес посредника задаётся в config.json (curseforgeProxy). См. cloudflare-worker/worker.js.
 */
const GAME = 432; // Minecraft
const CLASS = { mod: 6, texture: 12, shader: 6552, map: 17 };
const LOADER = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const LNAME = { 1: 'Forge', 4: 'Fabric', 5: 'Quilt', 6: 'NeoForge' };
const SORT = [2, 6, 3]; // популярность, загрузки, обновлено

function createCurseForge(o) {
  const f = o.fetch || globalThis.fetch;
  const base = String(o.proxy || '').replace(/\/+$/, '');
  const ua = o.userAgent || 'Wayfire/2.0.0';
  const NOTE = 'CurseForge пока не подключён. Моды, текстурпаки и шейдеры доступны на Modrinth.';

  async function get(p, params) {
    const u = new URL(base + '/v1' + p);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    let r;
    try { r = await f(u, { headers: { 'User-Agent': ua, Accept: 'application/json' } }); }
    catch (e) { throw new Error('Нет связи с CurseForge. Проверь интернет.'); }
    if (r.status === 429) throw new Error('CurseForge просит подождать: слишком много запросов.');
    if (!r.ok) throw new Error('CurseForge вернул ошибку ' + r.status + '.');
    return r.json();
  }
  const strip = h => String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
  const rid = id => { const n = String(id).replace(/^cf:/, ''); if (!/^\d{1,9}$/.test(n)) throw new Error('Некорректный номер мода.'); return n; };

  async function search({ cat, q, ver, loader, sort, offset, limit }) {
    if (!base) return { items: [], total: 0, note: NOTE };
    const classId = CLASS[cat]; if (!classId) return { items: [], total: 0 };
    const d = await get('/mods/search', {
      gameId: GAME, classId, searchFilter: q || undefined, gameVersion: ver || undefined,
      modLoaderType: cat === 'mod' && loader ? LOADER[String(loader).toLowerCase()] : undefined,
      sortField: q && !sort ? 1 : (SORT[sort] || 2), sortOrder: 'desc', index: offset || 0, pageSize: limit || 20
    });
    return {
      total: (d.pagination && d.pagination.totalCount) || 0,
      items: (d.data || []).map(m => ({
        id: 'cf:' + m.id, slug: m.slug, cat, name: m.name, au: (m.authors && m.authors[0] && m.authors[0].name) || '', dl: m.downloadCount || 0, d: m.summary || '',
        lo: [...new Set((m.latestFilesIndexes || []).map(x => LNAME[x.modLoader]).filter(Boolean))],
        ve: [...new Set((m.latestFilesIndexes || []).map(x => x.gameVersion))].slice(0, 3),
        icon: (m.logo && m.logo.url) || '', feat: (m.screenshots && m.screenshots[0] && m.screenshots[0].url) || '',
        sr: ['c'], dp: [], real: true
      }))
    };
  }

  async function project(id) {
    const n = rid(id);
    const [m, d] = await Promise.all([get('/mods/' + n), get('/mods/' + n + '/description').catch(() => ({ data: '' }))]);
    const mod = m.data || {};
    return {
      body: strip(d.data) || mod.summary || '',
      shots: (mod.screenshots || []).map(s => s.url).slice(0, 6),
      loaders: [...new Set((mod.latestFilesIndexes || []).map(x => LNAME[x.modLoader]).filter(Boolean))],
      versions: [...new Set((mod.latestFilesIndexes || []).map(x => x.gameVersion))].slice(0, 8)
    };
  }

  async function pickFile(n, ver, ld) {
    const d = await get('/mods/' + n + '/files', { gameVersion: ver || undefined, modLoaderType: ld ? LOADER[ld] : undefined, pageSize: 50 });
    const list = (d.data || []).slice().sort((a, b) => new Date(b.fileDate) - new Date(a.fileDate));
    return list.find(x => x.releaseType === 1) || list[0] || null;
  }

  async function plan({ id, title, cat, ver, loader }) {
    if (!base) throw new Error(NOTE);
    if (cat === 'map') throw new Error('Установка карт скоро появится. Карту можно скачать на сайте CurseForge.');
    const ld = cat === 'mod' ? String(loader || '').toLowerCase() : '';
    const files = [], seen = new Set(), missing = [];
    async function visit(n, depth, main) {
      if (seen.has(n)) return; seen.add(n);
      const file = await pickFile(n, ver, ld);
      if (!file) { if (main) throw new Error('Нет подходящей версии для Minecraft ' + (ver || '') + (ld ? ' и ' + ld : '') + '.'); missing.push(n); return; }
      if (!file.downloadUrl) {
        if (main) throw new Error('Автор запретил скачивание этого мода в сторонних лаунчерах. Скачайте его на сайте CurseForge.');
        missing.push(n); return;
      }
      let name = title;
      if (!main) { try { name = (await get('/mods/' + n)).data.name; } catch (e) { name = n; } }
      const sha1 = (file.hashes || []).find(h => h.algo === 1);
      files.push({ project_id: 'cf:' + n, title: name, version: file.displayName, filename: file.fileName, url: file.downloadUrl, sha1: sha1 && sha1.value, size: file.fileLength, main, kind: cat });
      if (depth < 4) for (const dep of file.dependencies || []) if (dep.relationType === 3) await visit(String(dep.modId), depth + 1, false);
    }
    await visit(rid(id), 0, true);
    return { files, missing };
  }

  return { search, project, plan };
}

module.exports = { createCurseForge };
