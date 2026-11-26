'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => ipcRenderer.on(channel, (_e, ...args) => fn(...args));

contextBridge.exposeInMainWorld('ardpSession', {
  platform: process.platform,

  ready: (info) => ipcRenderer.send('session:ready', info),
  input: (event) => ipcRenderer.send('session:input', event),
  ack: (seq) => ipcRenderer.send('session:ack', seq),
  keyframe: () => ipcRenderer.send('session:keyframe'),
  reconnect: () => ipcRenderer.send('session:reconnect'),
  display: (id) => ipcRenderer.send('session:display', id),
  window: (action) => ipcRenderer.send('window:action', action),

  onInit: on('session:init'),
  onOpened: on('session:opened'),
  onConfig: on('session:config'),
  onFrame: on('session:frame'),
  onStatus: on('session:status'),
  onClosed: on('session:closed'),
  onState: on('window:state'),
});
