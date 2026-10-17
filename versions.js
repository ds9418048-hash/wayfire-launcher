'use strict';
/** Списки версий: Minecraft (с снапшотами) и версии загрузчиков. */
const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

async function getJson(f, url) {
  const r = await f(url, { headers: { 'User-Agent': 'Wayfire/1.0.0', Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function mcVersions(f) {
  const m = await getJson(f, MANIFEST);
  return m.versions.map(v => ({ id: v.id, type: v.type })); // release | snapshot | old_beta | old_alpha
}

// Новые версии сверху. Возвращает массив строк.
async function loaderVersions(f, loader, mc) {
  const e = encodeURIComponent(mc);
  if (loader === 'Fabric') return (await getJson(f, 'https://meta.fabricmc.net/v2/versions/loader/' + e)).map(x => x.loader.version);
  if (loader === 'Quilt') return (await getJson(f, 'https://meta.quiltmc.org/v3/versions/loader/' + e)).map(x => x.loader.version);
  if (loader === 'Forge') {
    const all = await getJson(f, 'https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json');
    return (all[mc] || []).slice().reverse().map(v => v.replace(mc + '-', ''));
  }
  if (loader === 'NeoForge') {
    const all = (await getJson(f, 'https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')).versions || [];
    const m = /^1\.(\d+)(?:\.(\d+))?/.exec(mc); if (!m) return [];
    const pre = m[1] + '.' + (m[2] || '0') + '.';
    return all.filter(v => v.startsWith(pre)).reverse();
  }
  return [];
}

module.exports = { mcVersions, loaderVersions };
