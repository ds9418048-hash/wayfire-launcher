'use strict';
/**
 * Wayfire: мост для игры по сети напрямую между друзьями (в главном процессе).
 *
 * Как это работает:
 *   Хост открывает мир для сети в Minecraft (Esc → «Открыть для сети»). Лаунчер находит порт мира:
 *   Minecraft объявляет LAN-миры по UDP-мультикасту 224.0.2.60:4445.
 *   Лаунчер друга поднимает у себя локальный TCP-порт и объявляет его тем же способом, поэтому мир
 *   появляется в списке «Сетевая игра» у друга сам. Весь TCP-трафик Minecraft идёт по одному
 *   WebRTC-каналу (его открывает лаунчер в окне), а здесь он разбирается на отдельные соединения.
 */
const net = require('net');
const dgram = require('dgram');

const T_OPEN = 1, T_DATA = 2, T_CLOSE = 3;
const CHUNK = 15000;                 // WebRTC-сообщения лучше держать меньше ~16 КБ
const MAX_STREAMS = 32;
const MARK = 'Wayfire · ';           // метка наших объявлений, чтобы не принять их за настоящий мир

const frame = (t, id, payload) => {
  const h = Buffer.alloc(5);
  h[0] = t;
  h.writeUInt32BE(id, 1);
  return payload ? Buffer.concat([h, payload]) : h;
};

/** Размножает несколько TCP-соединений Minecraft по одному каналу send/receive. */
class Mux {
  constructor(send) {
    this.send = send;
    this.streams = new Map();
    this.next = 1;
    this.hostPort = 0;
    this.server = null;
    this.closed = false;
  }
  host(port) { this.hostPort = port; }                       // сторона хоста: подключаемся к локальному миру
  join() {                                                    // сторона друга: слушаем локальный порт
    return new Promise((resolve, reject) => {
      this.server = net.createServer(sock => {
        const id = this.next++;
        this.attach(id, sock);
        this.send(frame(T_OPEN, id));
      });
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }
  attach(id, sock) {
    this.streams.set(id, sock);
    sock.setNoDelay(true);
    sock.on('data', d => {
      for (let i = 0; i < d.length; i += CHUNK) this.send(frame(T_DATA, id, d.subarray(i, i + CHUNK)));
    });
    sock.on('close', () => { if (this.streams.delete(id) && !this.closed) this.send(frame(T_CLOSE, id)); });
    sock.on('error', () => sock.destroy());
  }
  receive(buf) {
    if (this.closed || buf.length < 5) return;
    const t = buf[0], id = buf.readUInt32BE(1), body = buf.subarray(5);
    if (t === T_OPEN) {
      if (!this.hostPort) return;                              // принимаем только на стороне хоста
      if (this.streams.size >= MAX_STREAMS) { this.send(frame(T_CLOSE, id)); return; }
      this.attach(id, net.connect(this.hostPort, '127.0.0.1')); // цель всегда локальный мир, адрес не берётся из канала
    } else if (t === T_DATA) {
      const s = this.streams.get(id);
      if (s) s.write(body);
    } else if (t === T_CLOSE) {
      const s = this.streams.get(id);
      if (s) { this.streams.delete(id); s.end(); }
    }
  }
  close() {
    this.closed = true;
    for (const s of this.streams.values()) s.destroy();
    this.streams.clear();
    if (this.server) this.server.close();
  }
}

/* ---- LAN-объявления Minecraft ---- */
const LAN_ADDR = '224.0.2.60', LAN_PORT = 4445;
const parseAnnounce = m => {
  const s = m.toString('utf8');
  const mo = /\[MOTD\]([\s\S]*?)\[\/MOTD\]/.exec(s), ad = /\[AD\](\d+)\[\/AD\]/.exec(s);
  return ad ? { motd: mo ? mo[1] : '', port: +ad[1] } : null;
};
const buildAnnounce = (motd, port) => Buffer.from('[MOTD]' + motd + '[/MOTD][AD]' + port + '[/AD]');

class LanWatcher {
  constructor(cb) { this.cb = cb; this.sock = null; }
  start() {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = s;
    s.on('message', m => { const a = parseAnnounce(m); if (a) this.cb(a.port, a.motd); });
    s.on('error', () => {});
    s.bind(LAN_PORT, () => { try { s.addMembership(LAN_ADDR); } catch (e) { /* нет сети */ } });
  }
  stop() { if (this.sock) { try { this.sock.close(); } catch (e) { /* уже закрыт */ } this.sock = null; } }
}
class LanAnnouncer {
  constructor(motd, port) { this.motd = motd; this.port = port; this.sock = null; this.t = null; }
  start() {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = s;
    s.on('error', () => {});
    const go = () => s.send(buildAnnounce(this.motd, this.port), LAN_PORT, LAN_ADDR, () => {});
    go();
    this.t = setInterval(go, 1500);
  }
  stop() {
    clearInterval(this.t);
    if (this.sock) { try { this.sock.close(); } catch (e) { /* уже закрыт */ } this.sock = null; }
  }
}

/** Подключает мост к IPC. requireLicense() бросает ошибку, если лицензия не подтверждена. */
function registerNet({ ipcMain, send, requireLicense, Watcher = LanWatcher, Announcer = LanAnnouncer }) {
  const muxes = new Map();
  let watch = null, hostPort = 0, ann = null;

  const dropAnn = () => { if (ann && ![...muxes.values()].some(m => m.server)) { ann.stop(); ann = null; } };

  ipcMain.handle('net:hostStart', async () => {
    requireLicense();
    if (watch) watch.stop();
    hostPort = 0;
    watch = new Watcher((port, motd) => {
      if (motd.startsWith(MARK)) return;
      hostPort = port;
      send('net:lan', { port, motd });
      for (const m of muxes.values()) if (!m.hostPort) m.host(port);
    });
    watch.start();
    return true;
  });
  ipcMain.handle('net:hostStop', async () => {
    if (watch) watch.stop();
    watch = null; hostPort = 0;
    for (const m of muxes.values()) m.close();
    muxes.clear(); dropAnn();
    return true;
  });
  ipcMain.handle('net:peerOpen', async (_e, { peer, role, name }) => {
    requireLicense();
    const old = muxes.get(peer);
    if (old) old.close();
    const m = new Mux(buf => send('net:toPeer', peer, buf));
    muxes.set(peer, m);
    if (role === 'host') {
      if (!hostPort) throw new Error('Не нашёл открытый мир. В Minecraft нажми Esc и «Открыть для сети».');
      m.host(hostPort);
      return { port: hostPort };
    }
    const port = await m.join();
    if (ann) ann.stop();
    ann = new Announcer(MARK + String(name || 'Игра').slice(0, 30), port);
    ann.start();
    return { port };
  });
  ipcMain.on('net:fromPeer', (_e, peer, buf) => { const m = muxes.get(peer); if (m) m.receive(Buffer.from(buf)); });
  ipcMain.handle('net:peerClose', async (_e, peer) => {
    const m = muxes.get(peer);
    if (m) { m.close(); muxes.delete(peer); }
    dropAnn();
    return true;
  });
}

module.exports = { Mux, LanWatcher, LanAnnouncer, parseAnnounce, buildAnnounce, registerNet, MARK };
