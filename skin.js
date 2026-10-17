'use strict';
/**
 * Скин в офлайн-режиме. Mojang отдаёт скины только по лицензионному профилю, поэтому игра без входа
 * показывает стандартного Стива или Алекс. Чтобы ты видел в игре свой скин, Wayfire кладёт его в
 * маленький ресурспак и сам включает его: он заменяет стандартные скины.
 * Скин виден только тебе. Другие игроки увидят стандартный.
 */
const fs = require('fs');
const path = require('path');

const PACK = 'wayfire-skin.zip', ENTRY = 'file/' + PACK;
const NAMES = ['steve', 'alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'sunny', 'zuri'];

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/** Zip без сжатия: файлы лежат как есть. Этого достаточно для ресурспака. */
function zipStore(files) {
  const parts = [], central = []; let off = 0;
  for (const [name, data] of files) {
    const nb = Buffer.from(name, 'utf8'), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nb.length, 26);
    parts.push(lh, nb, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nb.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nb);
    off += 30 + nb.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

function parsePng(dataUrl) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m || m[1].length > 400000) return null;
  const b = Buffer.from(m[1], 'base64');
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  return w === 64 && (h === 64 || h === 32) ? b : null;
}

function setPackInOptions(gameDir, on) {
  const file = path.join(gameDir, 'options.txt');
  let lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const i = lines.findIndex(l => l.startsWith('resourcePacks:'));
  let list = ['vanilla'];
  if (i >= 0) { try { const a = JSON.parse(lines[i].slice('resourcePacks:'.length)); if (Array.isArray(a)) list = a; } catch (e) { /* оставим стандартный список */ } }
  list = list.filter(x => x !== ENTRY);
  if (on) list.push(ENTRY);
  const line = 'resourcePacks:' + JSON.stringify(list);
  if (i >= 0) lines[i] = line; else lines.push(line);
  fs.writeFileSync(file, lines.filter((l, k) => l !== '' || k < lines.length - 1).join('\n') + '\n');
}

function applySkin(gameDir, dataUrl) {
  const zip = path.join(gameDir, 'resourcepacks', PACK);
  const png = dataUrl ? parsePng(dataUrl) : null;
  if (!png) { // скин не выбран: убираем ресурспак
    if (fs.existsSync(zip)) { fs.rmSync(zip, { force: true }); setPackInOptions(gameDir, false); }
    return false;
  }
  const files = [['pack.mcmeta', Buffer.from(JSON.stringify({ pack: { pack_format: 15, supported_formats: { min_inclusive: 1, max_inclusive: 999 }, description: 'Wayfire: твой скин' } }))]];
  files.push(['assets/minecraft/textures/entity/steve.png', png], ['assets/minecraft/textures/entity/alex.png', png]);
  for (const kind of ['wide', 'slim']) for (const n of NAMES) files.push(['assets/minecraft/textures/entity/player/' + kind + '/' + n + '.png', png]);
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  fs.writeFileSync(zip, zipStore(files));
  setPackInOptions(gameDir, true);
  return true;
}

module.exports = { applySkin, zipStore, parsePng };
