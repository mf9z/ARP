'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, ...args) => fn(...args));

contextBridge.exposeInMainWorld('ardp', {
  state: () => ipcRenderer.invoke('launcher:state'),
  connect: (request) => ipcRenderer.invoke('launcher:connect', request),
  cancel: () => ipcRenderer.send('launcher:cancel'),
  forget: (address) => ipcRenderer.invoke('launcher:forget', address),
  fit: (height) => ipcRenderer.send('launcher:fit', height),

  setHost: (change) => ipcRenderer.invoke('host:set', change),
  newCode: () => ipcRenderer.invoke('host:new-code'),
  disconnect: (id) => ipcRenderer.send('host:disconnect', id),

  copy: (text) => ipcRenderer.send('app:copy', text),
  startAtLogin: (enabled) => ipcRenderer.invoke('app:start-at-login', enabled),
  window: (action) => ipcRenderer.send('window:action', action),

  onState: on('launcher:state'),
  onHost: on('host:state'),
  onWindow: on('window:state'),
});
