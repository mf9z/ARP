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
  allow: (what) => ipcRenderer.send('host:allow', what),

  openVm: (id) => ipcRenderer.invoke('vm:open', id),

  copyHost: (what) => ipcRenderer.send('host:copy', what),
  startAtLogin: (enabled) => ipcRenderer.invoke('app:start-at-login', enabled),
  window: (action) => ipcRenderer.send('window:action', action),

  onState: on('launcher:state'),
  onHost: on('host:state'),
  onLocalVms: on('local-vms'),
  onWindow: on('window:state'),
});
