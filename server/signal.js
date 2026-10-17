'use strict';
/**
 * Wayfire: сервер комнат (сигнальный сервер).
 * Он только помогает друзьям найти друг друга и обменяться данными для прямого соединения.
 * Сама игра по нему не идёт, поэтому нагрузка почти нулевая и хватает бесплатного хостинга.
 * Без внешних пакетов, Node.js 18+. Запуск: node server/signal.js   (порт: переменная PORT, по умолчанию 8787)
 */
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const NICK = /^[A-Za-z0-9_]{3,16}$/;
const TYPES = new Set(['request', 'accept', 'deny', 'offer', 'answer', 'ice']);
const MAX_BODY = 16 * 1024;
const MAX_PEERS = 2000;

const peers = new Map(); // ник -> { res, key, hosting, info, hits: [] }

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}
function reply(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function limited(p) { // не больше 60 сообщений за 10 секунд от одного игрока
  const now = Date.now();
  p.hits = p.hits.filter(t => now - t < 10000);
  if (p.hits.length >= 60) return true;
  p.hits.push(now);
  return false;
}
function auth(body) {
  const p = peers.get(body.from);
  return p && body.key && p.key === body.key ? p : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  if (url.pathname === '/health') return reply(res, 200, { ok: true, online: peers.size });

  // Поток событий: игрок "входит в сеть", пока соединение открыто
  if (url.pathname === '/v1/stream' && req.method === 'GET') {
    const nick = url.searchParams.get('nick') || '';
    if (!NICK.test(nick)) return reply(res, 400, { error: 'bad nick' });
    if (peers.has(nick)) return reply(res, 409, { error: 'nick busy' });
    if (peers.size >= MAX_PEERS) return reply(res, 503, { error: 'full' });
    const key = crypto.randomBytes(16).toString('hex');
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const p = { res, key, hosting: false, info: null, hits: [] };
    peers.set(nick, p);
    res.write('event: hello\ndata: ' + JSON.stringify({ key }) + '\n\n');
    const ka = setInterval(() => res.write(': keepalive\n\n'), 20000);
    req.on('close', () => { clearInterval(ka); if (peers.get(nick) === p) peers.delete(nick); });
    return;
  }

  if (url.pathname === '/v1/lookup' && req.method === 'GET') {
    const p = peers.get(url.searchParams.get('nick') || '');
    return reply(res, 200, p ? { online: true, hosting: p.hosting, info: p.hosting ? p.info : null } : { online: false, hosting: false });
  }

  if (req.method === 'POST' && (url.pathname === '/v1/host' || url.pathname === '/v1/send')) {
    let body;
    try { body = await readJson(req); } catch (e) { return reply(res, 400, { error: 'bad json' }); }
    const me = auth(body);
    if (!me) return reply(res, 403, { error: 'bad key' });
    if (limited(me)) return reply(res, 429, { error: 'slow down' });

    if (url.pathname === '/v1/host') {
      me.hosting = !!body.hosting;
      const i = body.info || {};
      me.info = me.hosting ? { build: String(i.build || '').slice(0, 40), version: String(i.version || '').slice(0, 20) } : null;
      return reply(res, 200, { ok: true });
    }

    if (!TYPES.has(body.type)) return reply(res, 400, { error: 'bad type' });
    const to = peers.get(body.to);
    if (!to || body.to === body.from) return reply(res, 404, { error: 'offline' });
    to.res.write('event: msg\ndata: ' + JSON.stringify({ from: body.from, type: body.type, data: body.data === undefined ? null : body.data }) + '\n\n');
    return reply(res, 200, { ok: true });
  }

  reply(res, 404, { error: 'not found' });
});

if (require.main === module) {
  server.listen(PORT, () => console.log('Wayfire: сервер комнат запущен на порту ' + PORT));
}
module.exports = { server, peers };
