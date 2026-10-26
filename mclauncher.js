'use strict';
/**
 * Wayfire: запуск через официальный Minecraft Launcher (вход в Azure не нужен).
 * Wayfire добавляет сборку профилем в официальный лаунчер. Вход в аккаунт и проверку лицензии
 * делает сам официальный лаунчер, а игра запускается из папки сборки (там лежат твои моды).
 * Поддерживается: ваниль и Fabric. Для Forge и NeoForge нужен их установщик, это пока не сделано.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const FABRIC_META = 'https://meta.fabricmc.net/v2';

function minecraftDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'minecraft');
  return path.join(os.homedir(), '.minecraft');
}

async function getJson(f, url, ua) {
  let r;
  try { r = await f(url, { headers: { 'User-Agent': ua || 'Wayfire/2.0.0', Accept: 'application/json' } }); }
  catch (e) { throw new Error('Нет связи с интернетом.'); }
  if (!r.ok) throw new Error('Сервер вернул ошибку ' + r.status + '.');
  return r.json();
}

/** Fabric и Quilt ставятся без установщика: достаточно положить описание в папку versions. */
async function ensureLoaderProfile(dir, mc, f, ua, loader, want) {
  const base = loader === 'Quilt' ? 'https://meta.quiltmc.org/v3' : FABRIC_META;
  const list = await getJson(f, base + '/versions/loader/' + encodeURIComponent(mc), ua);
  if (!Array.isArray(list) || !list.length) throw new Error('Для Minecraft ' + mc + ' нет ' + loader + '.');
  const pick = (want && list.find(x => x.loader && x.loader.version === want))
    || (want !== 'Последняя' && list.find(x => x.loader && x.loader.stable)) || list[0];
  const profile = await getJson(f, base + '/versions/loader/' + encodeURIComponent(mc) + '/' + encodeURIComponent(pick.loader.version) + '/profile/json', ua);
  const id = String(profile.id || '');
  if (!/^[A-Za-z0-9._+-]{1,80}$/.test(id)) throw new Error(loader + ' вернул странное имя версии.');
  const vdir = path.join(dir, 'versions', id);
  fs.mkdirSync(vdir, { recursive: true });
  const file = path.join(vdir, id + '.json');
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(profile));
  return id;
}
const ensureFabric = (dir, mc, f, ua, want) => ensureLoaderProfile(dir, mc, f, ua, 'Fabric', want);

/**
 * @param {object} o
 * @param {object} o.build     { id, name, version, type }
 * @param {string} o.buildDir  папка сборки (gameDir)
 * @param {string}[o.dir]      папка .minecraft (по умолчанию определяется сама)
 */
async function prepare({ build, buildDir, dir, fetch: f, userAgent }) {
  const mc = dir || minecraftDir();
  const pf = path.join(mc, 'launcher_profiles.json');
  if (!fs.existsSync(pf)) {
    throw new Error('Не нашёл официальный Minecraft Launcher. Установи его с minecraft.net, войди в аккаунт и один раз запусти. Потом нажми «Играть» ещё раз.');
  }
  if (!/^[A-Za-z0-9._+-]{1,40}$/.test(String(build.version))) throw new Error('Некорректная версия Minecraft.');
  if (!/^[a-z0-9_-]{1,40}$/i.test(String(build.id))) throw new Error('Некорректный номер сборки.');

  let versionId;
  if (build.type === 'Ваниль') versionId = build.version;
  else if (build.type === 'Fabric') versionId = await ensureFabric(mc, build.version, f || globalThis.fetch, userAgent);
  else throw new Error('Загрузчик ' + build.type + ' пока не поддерживается в этом режиме. Используй сборку «Ваниль» или «Fabric».');

  let data;
  try { data = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch (e) { throw new Error('Файл профилей официального лаунчера повреждён.'); }
  const backup = pf + '.wayfire-backup';
  if (!fs.existsSync(backup)) fs.copyFileSync(pf, backup);
  data.profiles = data.profiles || {};
  const key = 'wayfire-' + build.id;
  const now = new Date().toISOString();
  const old = data.profiles[key] || {};
  data.profiles[key] = {
    ...old,
    name: 'Wayfire: ' + String(build.name || build.id).slice(0, 40),
    type: 'custom',
    created: old.created || now,
    lastUsed: now,
    icon: old.icon || 'Furnace',
    lastVersionId: versionId,
    gameDir: buildDir
  };
  fs.mkdirSync(buildDir, { recursive: true });
  fs.writeFileSync(pf, JSON.stringify(data, null, 2));
  return { ok: true, profile: data.profiles[key].name, versionId };
}

module.exports = { ensureLoaderProfile, prepare, minecraftDir, ensureFabric };
