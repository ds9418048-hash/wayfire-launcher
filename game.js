'use strict';
/**
 * Wayfire: движок запуска Minecraft: Java Edition.
 * Скачивает файлы игры с серверов Mojang (клиент, библиотеки, ресурсы), проверяет контрольные суммы,
 * собирает команду запуска и стартует игру из папки сборки.
 * Аккаунт: офлайн (ник, токен «0», user_type legacy) или, если включён authMode "microsoft", токен из auth.js.
 * Поддерживается: ваниль и Fabric, версии 1.7.10 и новее. Forge и NeoForge пока нет.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ensureLoaderProfile, minecraftDir } = require('./mclauncher');
const { loaderVersions } = require('./versions');

const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');

/* ---- минимальная распаковка zip (нужна для natives) ---- */
function unzip(buf, destDir, exclude = []) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Файл не похож на zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const base = path.resolve(destDir);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Повреждён zip');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/') || exclude.some(x => name.startsWith(x))) continue;
    const dest = path.resolve(base, name);
    if (dest !== base && !dest.startsWith(base + path.sep)) continue; // защита от выхода из папки
    const ds = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(ds, ds + csize);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, method === 0 ? raw : zlib.inflateRawSync(raw));
  }
}

/* ---- Java ---- */
function javaMajor(bin) {
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 8000 });
  if (r.error) return 0;
  const m = /version "(\d+)(?:\.(\d+))?/.exec((r.stderr || '') + (r.stdout || ''));
  if (!m) return 0;
  return m[1] === '1' ? +(m[2] || 0) : +m[1];
}
function javaCandidates(component) {
  const exe = process.platform === 'win32' ? 'java.exe' : 'java';
  const list = [];
  const rt = path.join(minecraftDir(), 'runtime');
  const plat = process.platform === 'win32' ? ['windows-x64', 'windows-arm64', 'windows-x86']
    : process.platform === 'darwin' ? ['mac-os', 'mac-os-arm64'] : ['linux', 'linux-i386'];
  if (component) for (const pl of plat) list.push(path.join(rt, component, pl, component, 'bin', exe));
  if (process.env.JAVA_HOME) list.push(path.join(process.env.JAVA_HOME, 'bin', exe));
  list.push('java');
  return list;
}
function findJava(required, component, custom, extra) {
  const ok = m => (required <= 8 ? m === 8 : m >= required);
  const list = custom ? [custom] : [...(extra || []), ...javaCandidates(component)];
  for (const c of list) {
    if (c !== 'java' && !fs.existsSync(c)) continue;
    if (ok(javaMajor(c))) return c;
  }
  throw new Error('Не нашёл подходящую Java (нужна версия ' + required + (required > 8 ? ' или новее' : '') + '). Установи Java с https://adoptium.net и попробуй снова.');
}

/**
 * @param {object} o
 * @param {string} o.root          папка с общими файлами игры (versions, libraries, assets)
 * @param {function}[o.fetch]      подмена fetch (для тестов)
 * @param {string}  [o.manifestUrl], [o.resourcesUrl], [o.osName], [o.arch], [o.userAgent], [o.settleMs]
 */
function createGame(o) {
  const root = o.root;
  const f = o.fetch || globalThis.fetch;
  const ua = o.userAgent || 'Wayfire/2.0.0';
  const MANIFEST = o.manifestUrl || 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
  const RES = o.resourcesUrl || 'https://resources.download.minecraft.net/';
  const osName = o.osName || (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux');
  const arch = o.arch || process.arch;
  const sep = osName === 'windows' ? ';' : ':';
  const p = (...a) => path.join(root, ...a);
  const libPath = rel => {
    const full = path.resolve(root, 'libraries', rel);
    if (!full.startsWith(path.resolve(root, 'libraries') + path.sep)) throw new Error('Подозрительный путь библиотеки');
    return full;
  };

  const hostOf = u => { try { return new URL(u).host; } catch (e) { return u; } };
  const why = e => { const c = (e && e.cause) || e || {}; return c.code || c.message || String(e); };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // fetch с тремя попытками: обрывы связи и ошибки сервера часто проходят со второго раза
  async function fetchRetry(url, opts) {
    let last;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await f(url, opts);
        if (r.status < 500) return r;
        last = new Error('HTTP ' + r.status);
      } catch (e) { last = e; }
      if (i < 2) await wait(o.retryMs === undefined ? 1200 : o.retryMs);
    }
    throw last;
  }
  async function getJson(url) {
    let r;
    try { r = await fetchRetry(url, { headers: { 'User-Agent': ua, Accept: 'application/json' } }); }
    catch (e) { throw new Error('Нет связи с ' + hostOf(url) + ' (' + why(e) + '). Проверь интернет, VPN или антивирус.'); }
    if (!r.ok) throw new Error('Сервер ' + hostOf(url) + ' вернул ошибку ' + r.status + '.');
    return r.json();
  }
  async function download(url, dest, hash, size) {
    // Быстрая проверка: если размер совпал, файл не перечитываем и не считаем хеш заново
    if (fs.existsSync(dest)) {
      if (size ? fs.statSync(dest).size === size : (!hash || sha1(fs.readFileSync(dest)) === hash)) return false;
    }
    let r;
    try { r = await fetchRetry(url, { headers: { 'User-Agent': ua } }); }
    catch (e) { throw new Error('Нет связи с ' + hostOf(url) + ' при скачивании «' + path.basename(dest) + '» (' + why(e) + ').'); }
    if (!r.ok) throw new Error('Не удалось скачать «' + path.basename(dest) + '» (' + r.status + ').');
    const buf = Buffer.from(await r.arrayBuffer());
    if (hash && sha1(buf) !== hash) throw new Error('Файл «' + path.basename(dest) + '» повреждён: контрольная сумма не совпала.');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest + '.part', buf);
    fs.renameSync(dest + '.part', dest);
    return true;
  }
  async function pool(items, n, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k]); } }));
  }

  /* ---- правила Mojang ---- */
  function ruleOk(rules, features) {
    if (!rules || !rules.length) return true;
    let ok = false;
    for (const r of rules) {
      let m = true;
      if (r.os) {
        if (r.os.name && r.os.name !== osName) m = false;
        if (r.os.arch && r.os.arch !== (arch === 'ia32' ? 'x86' : arch)) m = false;
      }
      if (r.features) for (const [k, v] of Object.entries(r.features)) if (!!features[k] !== v) m = false;
      if (m) ok = r.action === 'allow';
    }
    return ok;
  }
  const sub = (s, vars) => String(s).replace(/\$\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : ''));
  function expand(list, vars, features) {
    const out = [];
    for (const a of list || []) {
      if (typeof a === 'string') { out.push(sub(a, vars)); continue; }
      if (!ruleOk(a.rules, features)) continue;
      for (const x of [].concat(a.value)) out.push(sub(x, vars));
    }
    return out;
  }
  const mavenPath = name => {
    const [g, a, v, c] = name.split(':');
    return g.replace(/\./g, '/') + '/' + a + '/' + v + '/' + a + '-' + v + (c ? '-' + c : '') + '.jar';
  };

  /* ---- описание версии ---- */
  async function resolve(id) {
    const file = p('versions', id, id + '.json');
    let v;
    if (fs.existsSync(file)) v = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      const m = await getJson(MANIFEST);
      const e = (m.versions || []).find(x => x.id === id);
      if (!e) throw new Error('Версия Minecraft ' + id + ' не найдена в списке Mojang.');
      v = await getJson(e.url);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(v));
    }
    if (v.inheritsFrom) {
      const b = await resolve(v.inheritsFrom);
      const ba = b.arguments || {}, va = v.arguments || {};
      return {
        ...b, ...v, jarId: b.jarId, assetIndex: b.assetIndex, assets: b.assets, downloads: b.downloads, logging: b.logging,
        mainClass: v.mainClass || b.mainClass, javaVersion: v.javaVersion || b.javaVersion,
        libraries: [...(v.libraries || []), ...b.libraries],
        arguments: { game: [...(ba.game || []), ...(va.game || [])], jvm: [...(ba.jvm || []), ...(va.jvm || [])] }
      };
    }
    v.jarId = id;
    if (!v.arguments && v.minecraftArguments) {
      v.arguments = { game: v.minecraftArguments.split(' '), jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'] };
    }
    return v;
  }

  function libraries(v) {
    const cp = [], natives = [], seen = new Set();
    for (const lib of v.libraries || []) {
      if (!ruleOk(lib.rules, {})) continue;
      const parts = lib.name.split(':');
      const key = parts.slice(0, 2).join(':') + (parts[3] ? ':' + parts[3] : '');
      if (seen.has(key)) continue;
      seen.add(key);
      if (lib.natives && lib.natives[osName]) {
        const cls = lib.natives[osName].replace('${arch}', arch === 'ia32' ? '32' : '64');
        const a = lib.downloads && lib.downloads.classifiers && lib.downloads.classifiers[cls];
        if (a) natives.push({ path: a.path, url: a.url, sha1: a.sha1, size: a.size, exclude: (lib.extract && lib.extract.exclude) || [] });
      }
      const art = lib.downloads && lib.downloads.artifact;
      if (art) cp.push({ path: art.path, url: art.url, sha1: art.sha1, size: art.size });
      else if (!lib.downloads) {
        const rel = mavenPath(lib.name);
        cp.push({ path: rel, url: (lib.url || 'https://libraries.minecraft.net/') + rel, sha1: lib.sha1 });
      }
    }
    return { cp, natives };
  }

  /** Скачивает всё, что нужно для запуска версии. */
  async function install({ mc, loader, loaderVersion, settings }, onP) {
    const emit = (stage, done, total) => { if (onP) onP({ stage, done, total }); };
    emit('version', 0, 1);
    let id = mc;
    if (loader === 'Fabric' || loader === 'Quilt') id = await ensureLoaderProfile(root, mc, f, ua, loader, loaderVersion);
    else if (loader === 'Forge' || loader === 'NeoForge') id = await installForgeLike(loader, mc, loaderVersion, settings || {}, onP);
    else if (loader && loader !== 'Ваниль') throw new Error('Загрузчик ' + loader + ' не поддерживается.');
    const v = await resolve(id);
    emit('version', 1, 1);

    const cj = v.downloads && v.downloads.client;
    if (!cj) throw new Error('У версии ' + id + ' нет клиента для скачивания.');
    await download(cj.url, p('versions', v.jarId, v.jarId + '.jar'), cj.sha1, cj.size);
    emit('client', 1, 1);

    const { cp, natives } = libraries(v);
    const all = [...cp, ...natives];
    let n = 0;
    await pool(all, 12, async l => { await download(l.url, libPath(l.path), l.sha1, l.size); if (++n % 5 === 0 || n === all.length) emit('libraries', n, all.length); });
    const ndir = p('versions', v.id, 'natives');
    fs.mkdirSync(ndir, { recursive: true });
    const nmark = path.join(ndir, '.unpacked');
    if (!fs.existsSync(nmark)) { for (const l of natives) unzip(fs.readFileSync(libPath(l.path)), ndir, l.exclude); fs.writeFileSync(nmark, '1'); }

    if (v.assetIndex) {
      const ix = v.assetIndex, ifile = p('assets', 'indexes', ix.id + '.json');
      await download(ix.url, ifile, ix.sha1);
      const objs = JSON.parse(fs.readFileSync(ifile, 'utf8')).objects || {};
      const sizes = new Map(Object.values(objs).map(x => [x.hash, x.size]));
      const hashes = [...sizes.keys()];
      let k = 0;
      await pool(hashes, 24, async h => { await download(RES + h.slice(0, 2) + '/' + h, p('assets', 'objects', h.slice(0, 2), h), h, sizes.get(h)); if (++k % 25 === 0 || k === hashes.length) emit('assets', k, hashes.length); });
    }
    let logArg = '';
    const lg = v.logging && v.logging.client;
    if (lg && lg.file) {
      const dest = p('assets', 'log_configs', lg.file.id);
      await download(lg.file.url, dest, lg.file.sha1);
      logArg = String(lg.argument || '').replace('${path}', dest);
    }
    return { v, cp, ndir, logArg };
  }

  const splitArgs = s => String(s || '').split(/\s+/).filter(a => a.startsWith('-'));

  /** Собирает команду запуска. */
  function command({ v, cp, ndir, logArg, auth, gameDir, java, settings }) {
    const st = settings || {};
    const w = parseInt(st.w, 10) || 0, h = parseInt(st.h, 10) || 0;
    const classpath = [...cp.map(l => libPath(l.path)), p('versions', v.jarId, v.jarId + '.jar')].join(sep);
    const vars = {
      auth_player_name: auth.name, version_name: v.id, game_directory: gameDir, assets_root: p('assets'),
      assets_index_name: v.assetIndex ? v.assetIndex.id : v.assets, auth_uuid: auth.uuid, auth_access_token: auth.token,
      clientid: '', auth_xuid: '', user_type: auth.userType || 'msa', version_type: v.type || 'release', launcher_name: 'Wayfire', launcher_version: '2.0.0',
      natives_directory: ndir, classpath, classpath_separator: sep, library_directory: p('libraries'),
      resolution_width: String(w), resolution_height: String(h), user_properties: '{}',
      auth_session: 'token:' + auth.token + ':' + auth.uuid, game_assets: p('assets', 'virtual', 'legacy')
    };
    const features = { has_custom_resolution: !!(w && h) };
    const jvm = expand(v.arguments && v.arguments.jvm, vars, features);
    if (!jvm.includes('-cp')) jvm.push('-cp', classpath);
    if (!jvm.some(a => a.startsWith('-Djava.library.path'))) jvm.push('-Djava.library.path=' + ndir);
    if (logArg) jvm.push(logArg);
    const game = expand(v.arguments && v.arguments.game, vars, features);
    if (st.full) game.push('--fullscreen');
    const ram = Math.max(1, Math.min(32, parseInt(st.ram, 10) || 4));
    return { java, args: ['-Xmx' + ram + 'G', '-Xms512M', ...splitArgs(st.jvm), ...jvm, v.mainClass, ...game] };
  }

  async function launch({ cmd, gameDir }) {
    fs.mkdirSync(path.join(gameDir, 'logs'), { recursive: true });
    const log = path.join(gameDir, 'logs', 'wayfire-launch.log');
    const fd = fs.openSync(log, 'a');
    const child = spawn(cmd.java, cmd.args, { cwd: gameDir, detached: true, stdio: ['ignore', fd, fd] });
    const early = await new Promise(res => {
      let done = false;
      child.on('error', e => { if (!done) { done = true; res({ err: e.message }); } });
      child.on('exit', c => { if (!done) { done = true; res({ code: c }); } });
      setTimeout(() => { if (!done) { done = true; res(null); } }, o.settleMs || 3000);
    });
    fs.closeSync(fd);
    if (early && (early.err || early.code)) {
      let tail = '';
      try { tail = fs.readFileSync(log, 'utf8').split('\n').slice(-6).join('\n'); } catch (e) { /* нет лога */ }
      throw new Error('Игра закрылась сразу после запуска. ' + (early.err || 'Код ' + early.code) + '\nПодробности в файле ' + log + '\n' + tail);
    }
    child.unref();
    return { pid: child.pid, log };
  }


  /* ---- Java от Mojang: скачивается сама, если подходящей нет ---- */
  const JAVA_INDEX = o.javaIndexUrl || 'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json';
  const javaPlatform = () => osName === 'windows' ? (arch === 'arm64' ? 'windows-arm64' : arch === 'ia32' || arch === 'x86' ? 'windows-x86' : 'windows-x64')
    : osName === 'osx' ? (arch === 'arm64' ? 'mac-os-arm64' : 'mac-os') : (arch === 'ia32' || arch === 'x86' ? 'linux-i386' : 'linux');
  const javaExe = component => {
    const dir = p('runtime', component);
    return osName === 'osx' ? path.join(dir, 'jre.bundle', 'Contents', 'Home', 'bin', 'java')
      : path.join(dir, 'bin', osName === 'windows' ? 'java.exe' : 'java');
  };
  async function ensureJava(component, onProgress) {
    if (!component) return null;
    let idx, lastErr;
    for (const u of [JAVA_INDEX, JAVA_INDEX.replace('launchermeta.mojang.com', 'bmclapi2.bangbang93.com')]) {
      try { idx = await getJson(u); break; } catch (e) { lastErr = lastErr || e; }
    }
    if (!idx) throw lastErr;
    const entry = idx[javaPlatform()] && idx[javaPlatform()][component] && idx[javaPlatform()][component][0];
    if (!entry || !entry.manifest) return null;
    const dir = p('runtime', component), mark = path.join(dir, '.wayfire-ok');
    const exe = javaExe(component);
    if (fs.existsSync(exe) && fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === entry.manifest.sha1) return exe;
    const man = await getJson(entry.manifest.url);
    const all = Object.entries(man.files || {});
    const safe = rel => {
      const full = path.resolve(dir, rel);
      if (full !== path.resolve(dir) && !full.startsWith(path.resolve(dir) + path.sep)) throw new Error('Подозрительный путь в Java');
      return full;
    };
    for (const [rel, e] of all) if (e.type === 'directory') fs.mkdirSync(safe(rel), { recursive: true });
    const files = all.filter(([, e]) => e.type === 'file' && e.downloads && e.downloads.raw);
    let done = 0;
    if (onProgress) onProgress({ stage: 'java', done, total: files.length });
    await pool(files, 8, async ([rel, e]) => {
      const dest = safe(rel);
      await download(e.downloads.raw.url, dest, e.downloads.raw.sha1);
      if (e.executable && osName !== 'windows') fs.chmodSync(dest, 0o755);
      done++; if (onProgress && (done % 20 === 0 || done === files.length)) onProgress({ stage: 'java', done, total: files.length });
    });
    if (osName !== 'windows') for (const [rel, e] of all) {
      if (e.type !== 'link' || !e.target) continue;
      const l = safe(rel);
      const t = path.resolve(path.dirname(l), e.target);
      if (!t.startsWith(path.resolve(dir) + path.sep)) continue;
      try { fs.mkdirSync(path.dirname(l), { recursive: true }); fs.rmSync(l, { force: true }); fs.symlinkSync(e.target, l); } catch (err) { /* не критично */ }
    }
    if (!fs.existsSync(exe)) throw new Error('Java скачалась, но файл запуска не найден.');
    fs.writeFileSync(mark, entry.manifest.sha1);
    return exe;
  }

  /* ---- Java: найти, а если нет, скачать ---- */
  async function obtainJava(jv, st, onProgress) {
    const custom = st.java === 'Свой путь' ? st.javaPath : '';
    const own = jv.component ? [javaExe(jv.component)].filter(x => fs.existsSync(x)) : [];
    try { return findJava(jv.majorVersion, jv.component, custom, own); }
    catch (e) {
      if (custom) throw e;
      const j = await ensureJava(jv.component, onProgress); // нет подходящей Java: берём ту, что нужна этой версии игры
      if (!j) throw e;
      return j;
    }
  }

  /* ---- Forge и NeoForge: запускаем их официальный установщик ---- */
  async function installForgeLike(kind, mc, want, st, onP) {
    const vers = await loaderVersions(f, kind, mc);
    if (!vers.length) throw new Error('Для Minecraft ' + mc + ' нет ' + kind + '.');
    const ver = want && vers.includes(want) ? want : vers[0];
    const vdir = p('versions');
    const have = () => fs.existsSync(vdir) ? fs.readdirSync(vdir).find(n => n.includes(ver) && /forge/i.test(n) && fs.existsSync(path.join(vdir, n, n + '.json'))) : null;
    if (have()) return have();
    const full = kind === 'Forge' ? mc + '-' + ver : ver;
    const url = kind === 'Forge'
      ? 'https://maven.minecraftforge.net/net/minecraftforge/forge/' + full + '/forge-' + full + '-installer.jar'
      : 'https://maven.neoforged.net/releases/net/neoforged/neoforge/' + full + '/neoforge-' + full + '-installer.jar';
    const jar = p('installers', kind + '-' + full + '.jar');
    await download(url, jar);
    const base = await resolve(mc);
    const java = await obtainJava(base.javaVersion || { majorVersion: 8 }, st, onP);
    const lp = p('launcher_profiles.json');
    if (!fs.existsSync(lp)) fs.writeFileSync(lp, JSON.stringify({ profiles: {} }));
    if (onP) onP({ stage: 'loader', done: 0, total: 1 });
    const r = spawnSync(java, ['-jar', jar, '--installClient', root], { encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    const id = have();
    if (!id) throw new Error('Не удалось установить ' + kind + ' ' + ver + '.\n' + ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-6).join('\n'));
    if (onP) onP({ stage: 'loader', done: 1, total: 1 });
    return id;
  }

  /** Всё вместе: скачать, собрать команду, запустить. */
  async function start({ build, gameDir, auth, settings, onProgress }) {
    if (!auth || !auth.token || !auth.uuid || !auth.name) throw new Error('Не задан ник игрока.');
    const st = settings || {};
    const inst = await install({ mc: build.version, loader: build.type, loaderVersion: build.loader, settings: st }, onProgress);
    const jv = inst.v.javaVersion || { majorVersion: 8 };
    const java = await obtainJava(jv, st, onProgress);
    fs.mkdirSync(gameDir, { recursive: true });
    const cmd = command({ ...inst, auth, gameDir, java, settings: st });
    if (onProgress) onProgress({ stage: 'launch', done: 0, total: 1 });
    const r = await launch({ cmd, gameDir });
    if (onProgress) onProgress({ stage: 'launch', done: 1, total: 1 });
    return { ok: true, pid: r.pid, version: inst.v.id };
  }

  return { install, command, launch, start, resolve, libraries, ruleOk, findJava, ensureJava };
}

module.exports = { createGame, unzip, findJava, javaMajor };
