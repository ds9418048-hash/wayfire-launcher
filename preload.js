'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a);

// Мост между лаунчером (launcher.html) и главным процессом.
contextBridge.exposeInMainWorld('wayfire', {
  mode: ipcRenderer.sendSync('app:mode'),
  quit: () => ipcRenderer.send('app:quit'),
  versions: { mc: () => inv('versions:mc'), loader: (l, mc) => inv('versions:loader', l, mc) },
  builds: { remove: id => inv('builds:delete', id) },
  launch: { prepare: b => inv('launch:prepare', b) },
  game: { start: p => inv('game:start', p), onProgress: cb => ipcRenderer.on('game:progress', (_e, p) => cb(p)) },
  auth: {
    start: () => inv('auth:start'),
    restore: () => inv('auth:restore'),
    signOut: () => inv('auth:signout'),
    cancel: () => inv('auth:cancel'),
    openExternal: url => inv('auth:open', url),
    onProgress: cb => ipcRenderer.on('auth:progress', (_e, p) => cb(p)),
    onResult: cb => ipcRenderer.on('auth:result', (_e, r) => cb(r))
  },
  net: {
    hostStart: () => inv('net:hostStart'),
    hostStop: () => inv('net:hostStop'),
    peerOpen: o => inv('net:peerOpen', o),
    peerClose: peer => inv('net:peerClose', peer),
    fromPeer: (peer, buf) => ipcRenderer.send('net:fromPeer', peer, buf),
    onToPeer: cb => ipcRenderer.on('net:toPeer', (_e, peer, buf) => cb(peer, buf)),
    onLan: cb => ipcRenderer.on('net:lan', (_e, i) => cb(i))
  },
  mods: {
    search: p => inv('mods:search', p),
    project: id => inv('mods:project', id),
    gameVersions: () => inv('mods:versions'),
    plan: p => inv('mods:plan', p),
    install: p => inv('mods:install', p),
    toggle: (id, name, on) => inv('mods:toggle', id, name, on),
    remove: (id, kind, name) => inv('mods:remove', id, kind, name),
    saveLocal: (id, kind, name, data) => inv('mods:saveLocal', id, kind, name, data),
    showFolder: id => inv('mods:showFolder', id)
  }
});
