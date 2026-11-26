'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, ...args) => fn(...args));

contextBridge.exposeInMainWorld('arp', {
  state: () => ipcRenderer.invoke('home:state'),
  open: (name) => ipcRenderer.send('home:open', name),
  getQemu: () => ipcRenderer.send('home:get-qemu'),
  setPrivate: (on) => ipcRenderer.invoke('home:private', on === true),
  fit: (height) => ipcRenderer.send('launcher:fit', height),
  window: (action) => ipcRenderer.send('window:action', action),
  onState: on('home:state'),
  onWindow: on('window:state'),
});
