'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, ...args) => fn(...args));

contextBridge.exposeInMainWorld('ardp', {
  state: () => ipcRenderer.invoke('launcher:state'),
  connect: (request) => ipcRenderer.invoke('launcher:connect', request),
  cancel: () => ipcRenderer.send('launcher:cancel'),
  choose: (id) => ipcRenderer.invoke('launcher:choose', id),
  forget: (address) => ipcRenderer.invoke('launcher:forget', address),
  fit: (height) => ipcRenderer.send('launcher:fit', height),

  setHost: (change) => ipcRenderer.invoke('host:set', change),
  newCode: () => ipcRenderer.invoke('host:new-code'),
  disconnect: (id) => ipcRenderer.send('host:disconnect', id),

  vm: {
    create: (spec) => ipcRenderer.invoke('vm:create', spec),
    start: (id) => ipcRenderer.invoke('vm:start', id),
    stop: (id, force) => ipcRenderer.invoke('vm:stop', id, force),
    remove: (id) => ipcRenderer.invoke('vm:remove', id),
    open: (id) => ipcRenderer.invoke('vm:open', id),
    browse: () => ipcRenderer.invoke('vm:browse'),
  },

  copy: (text) => ipcRenderer.send('app:copy', text),
  startAtLogin: (enabled) => ipcRenderer.invoke('app:start-at-login', enabled),
  window: (action) => ipcRenderer.send('window:action', action),

  onState: on('launcher:state'),
  onHost: on('host:state'),
  onVms: on('vm:state'),
  onWindow: on('window:state'),
});
