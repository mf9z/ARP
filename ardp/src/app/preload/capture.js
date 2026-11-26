'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ardpCapture', {
  onStart: (fn) => ipcRenderer.on('capture:start', (_e, options) => fn(options)),
  onGo: (fn) => ipcRenderer.on('capture:go', () => fn()),
  onTune: (fn) => ipcRenderer.on('capture:tune', (_e, settings) => fn(settings)),
  onKey: (fn) => ipcRenderer.on('capture:key', () => fn()),
  ready: (info) => ipcRenderer.send('capture:ready', info),
  frame: (meta, data) => ipcRenderer.send('capture:frame', meta, data),
  error: (message) => ipcRenderer.send('capture:error', message),
  ended: () => ipcRenderer.send('capture:ended'),
  stats: (stats) => ipcRenderer.send('capture:stats', stats),
});
