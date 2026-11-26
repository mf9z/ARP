'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, ...args) => fn(...args));

contextBridge.exposeInMainWorld('arp', {
  state: () => ipcRenderer.invoke('vm:state'),
  create: (spec) => ipcRenderer.invoke('vm:create', spec),
  start: (id) => ipcRenderer.invoke('vm:start', id),
  stop: (id, force) => ipcRenderer.invoke('vm:stop', id, force),
  remove: (id) => ipcRenderer.invoke('vm:remove', id),
  open: (id) => ipcRenderer.invoke('vm:open', id),
  browse: () => ipcRenderer.invoke('vm:browse'),
  fit: (height) => ipcRenderer.send('launcher:fit', height),
  window: (action) => ipcRenderer.send('window:action', action),
  onState: on('vm:state'),
  onWindow: on('window:state'),
});
