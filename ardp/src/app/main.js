'use strict';

const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, Menu, Tray, dialog, clipboard } = require('electron');
const product = require('../common/product');
const { parseAddress, formatAddress } = require('../common/address');
const { describe } = require('../common/messages');
const { ArdpClient } = require('../client/client');
const { Config } = require('./config');
const { HostService } = require('./host-service');
const { Session } = require('./session');

const argv = process.argv.slice(1);
const startHidden = argv.includes('--hidden');
const selftest = argv.includes('--selftest');

const ICONS = path.join(__dirname, '..', '..', 'assets', 'icons');
const icon = (size) => path.join(ICONS, `icon-${size}.png`);
const MAX_RECENT = 10;

if (selftest) app.setPath('userData', require('./selftest').profileDir());

if (!selftest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
   let config;
   let hostService;
   let launcher = null;
   let tray = null;
   let dialing = null;
  const sessions = new Set();
  let quitting = false;

  const clientInfo = () => ({ name: os.hostname(), platform: process.platform, version: app.getVersion() });

  const trust = {
    get: (id) => {
      const known = config.data.client.known;
      return known && typeof known === 'object' ? known[id] : undefined;
    },
    set: (id, fingerprint) => {
      const client = config.data.client;
      if (!client.known || typeof client.known !== 'object' || Array.isArray(client.known)) client.known = {};
      if (client.known[id] === fingerprint) return;
      client.known[id] = fingerprint;
      config.save();
    },
    changed: async ({ id, presented, name }) => {
      const parent = launcher && launcher.isVisible() ? launcher : BrowserWindow.getFocusedWindow();
      const options = {
        type: 'warning',
        title: product.ardp.name,
        message: `The identity of ${id} has changed.`,
        detail:
          `"${name}" is presenting a different identity than the last time you connected to this address.\n\n` +
          'That is expected if ARDP was reinstalled on that computer. Otherwise another machine may be answering in its place.\n\n' +
          `New fingerprint: ${presented.slice(0, 47)}…`,
        buttons: ['Connect anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      return response === 0;
    },
  };

  function launcherState() {
    const client = config.data.client;
    return {
      product: { name: product.ardp.name, meaning: product.ardp.meaning, family: product.arp },
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      startAtLogin: !!config.data.app.startAtLogin,
      defaultPort: product.defaultPort,
      host: hostService.state(),
      client: {
        recent: (Array.isArray(client.recent) ? client.recent : []).map((r) => ({ address: r.address, name: r.name || '', hasCode: !!r.code })),
        quality: client.quality,
        viewOnly: !!client.viewOnly,
        fullScreen: !!client.fullScreen,
      },
    };
  }

  function createLauncher() {
    launcher = new BrowserWindow({
      width: 432,
      height: 420,
      useContentSize: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      frame: false,
      backgroundColor: '#f0f0f0',
      title: product.ardp.name,
      icon: icon(256),
      webPreferences: {
        preload: path.join(__dirname, 'preload', 'launcher.js'),
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
      },
    });
    const win = launcher;
    win.removeMenu();
    win.loadFile(path.join(__dirname, 'ui', 'launcher.html'));
    // shown once the page has sized itself. started at sign-in it stays in the tray
    const reveal = () => {
      if (win.isDestroyed() || win.isVisible() || win.ardpRevealed) return;
      win.ardpRevealed = true;
      if (!startHidden || !config.data.host.enabled) win.show();
    };
    win.ardpReveal = reveal;
    win.once('ready-to-show', () => setTimeout(reveal, 1500));
    const pushState = () => {
      if (!win.isDestroyed()) win.webContents.send('window:state', { maximized: false, fullscreen: false, focused: win.isFocused() });
    };
    win.on('focus', pushState);
    win.on('blur', pushState);
    win.on('close', (event) => {
      // stay in the tray while hosting or in a session
      if (!quitting && (config.data.host.enabled || sessions.size > 0)) {
        event.preventDefault();
        win.hide();
      }
    });
    win.on('closed', () => {
      launcher = null;
    });
  }

  function showLauncher() {
    if (!launcher) createLauncher();
    else {
      if (launcher.isMinimized()) launcher.restore();
      launcher.show();
      launcher.focus();
    }
  }

  function toLauncher(channel, payload) {
    if (launcher && !launcher.isDestroyed()) launcher.webContents.send(channel, payload);
  }

  function refreshTray() {
    const state = hostService.state();
    if (!state.enabled) {
      if (tray) tray.destroy();
      tray = null;
      return;
    }
    if (!tray) {
      tray = new Tray(icon(process.platform === 'darwin' ? 16 : 32));
      tray.on('click', showLauncher);
    }
    const watching = state.sessions.filter((s) => s.streaming).length;
    tray.setToolTip(
      watching > 0
        ? `${product.ardp.name} - ${watching === 1 ? 'a computer is' : `${watching} computers are`} connected`
        : `${product.ardp.name} - accepting connections`,
    );
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${product.ardp.name}`, click: showLauncher },
        { type: 'separator' },
        { label: 'Allow remote connections', type: 'checkbox', checked: true, click: () => hostService.setEnabled(false) },
        { label: 'Disconnect everyone', enabled: state.sessions.length > 0, click: () => hostService.disconnect() },
        { type: 'separator' },
        { label: 'Exit', click: quit },
      ]),
    );
  }

  function quit() {
    quitting = true;
    app.quit();
  }

  async function remember(target, name, code, keepCode) {
    const client = config.data.client;
    const address = formatAddress(target) + (target.source ? `/${target.source}` : '');
    const rest = (Array.isArray(client.recent) ? client.recent : []).filter((r) => r && r.address !== address);
    const entry = { address, name };
    if (keepCode) entry.code = await config.seal(code);
    client.recent = [entry, ...rest].slice(0, MAX_RECENT);
    config.save();
  }

  async function savedCode(address) {
    const list = Array.isArray(config.data.client.recent) ? config.data.client.recent : [];
    const entry = list.find((r) => r && r.address === address);
    return entry ? config.unseal(entry.code) : null;
  }

  async function connect(request) {
    const target = parseAddress(request.address);
    if (!target) return { ok: false, field: 'address', text: 'Type the address of the other computer, for example 192.168.1.20.' };
    const shown = formatAddress(target);
    const address = shown + (target.source ? `/${target.source}` : '');

    let code = String(request.code || '').trim();
    if (!code) code = (await savedCode(address)) || '';
    if (!code) return { ok: false, field: 'code', text: 'Type the access code shown in ARDP on the other computer.' };

    const options = {
      quality: ['low', 'balanced', 'high'].includes(request.quality) ? request.quality : 'balanced',
      viewOnly: !!request.viewOnly,
      fullScreen: !!request.fullScreen,
    };
    Object.assign(config.data.client, options);
    config.save();

    const dial = async () => {
      const client = new ArdpClient({ host: target.host, port: target.port, accessCode: code, info: clientInfo(), trust });
      dialing = client;
      try {
        await client.connect();
        return client;
      } finally {
        if (dialing === client) dialing = null;
      }
    };

    let client;
    try {
      client = await dial();
    } catch (err) {
      if (err.code === 'cancelled') return { ok: false, cancelled: true };
      const field = err.code === 'auth_failed' ? 'code' : ['refused', 'unreachable', 'not_found', 'bad_protocol'].includes(err.code) ? 'address' : null;
      return { ok: false, code: err.code, field, text: describe(err, shown) };
    }

    await remember(target, client.remote.name, code, !!request.remember);

    const session = new Session({ target, client, redial: dial, options, icon: icon(256) });
    sessions.add(session);
    session.on('closed', () => {
      sessions.delete(session);
      if (sessions.size === 0 && !quitting) {
        showLauncher();
        toLauncher('launcher:state', launcherState());
      }
    });
    if (launcher) launcher.hide();
    return { ok: true };
  }

  function registerIpc() {
    ipcMain.on('window:action', (event, action) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;
      if (action === 'minimize') win.minimize();
      else if (action === 'maximize' && win.isMaximizable()) win.isMaximized() ? win.unmaximize() : win.maximize();
      else if (action === 'fullscreen' && win.isFullScreenable()) win.setFullScreen(!win.isFullScreen());
      else if (action === 'close') win.close();
    });

    ipcMain.handle('launcher:state', () => launcherState());
    ipcMain.handle('launcher:connect', (_e, request) => connect(request || {}));
    ipcMain.on('launcher:cancel', () => {
      if (dialing) dialing.abort();
    });
    ipcMain.on('launcher:fit', (_e, height) => {
      if (!launcher || !Number.isFinite(height)) return;
      const [width] = launcher.getContentSize();
      launcher.setContentSize(width, Math.max(200, Math.min(900, Math.round(height))));
      launcher.ardpReveal();
    });
    ipcMain.handle('launcher:forget', (_e, address) => {
      const client = config.data.client;
      client.recent = (Array.isArray(client.recent) ? client.recent : []).filter((r) => r && r.address !== address);
      config.save();
      return launcherState();
    });

    ipcMain.handle('host:set', async (_e, change) => {
      try {
        if (typeof change.enabled === 'boolean') await hostService.setEnabled(change.enabled);
        if (typeof change.allowControl === 'boolean') hostService.setAllowControl(change.allowControl);
        if (change.port !== undefined) await hostService.setPort(Number(change.port));
        return { ok: true, host: hostService.state() };
      } catch (err) {
        return { ok: false, text: err.message, host: hostService.state() };
      }
    });
    ipcMain.handle('host:new-code', async () => {
      await hostService.newCode();
      return hostService.state();
    });
    ipcMain.on('host:disconnect', (_e, id) => hostService.disconnect(Number.isInteger(id) ? id : undefined));

    ipcMain.on('app:copy', (_e, text) => clipboard.writeText(String(text || '').slice(0, 4096)));
    ipcMain.handle('app:start-at-login', (_e, on) => {
      config.data.app.startAtLogin = !!on;
      config.save();
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
      return !!on;
    });
  }

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
  app.on('second-instance', showLauncher);
  app.on('activate', showLauncher);
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('window-all-closed', () => {
    if (!config || !config.data.host.enabled) app.quit();
  });
  app.on('will-quit', () => {
    if (hostService) hostService.shutdown().catch(() => {});
  });

  app.whenReady().then(async () => {
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    } else {
      Menu.setApplicationMenu(null);
    }
    if (process.platform === 'win32') app.setAppUserModelId('app.ardp.desktop');

    const dir = app.getPath('userData');
    config = new Config(dir);
    hostService = new HostService({ config, dir, version: app.getVersion() });
    registerIpc();
    try {
      await hostService.init();
    } catch (err) {
      dialog.showErrorBox(product.ardp.name, `ARDP could not start.\n\n${err.message}`);
      app.exit(1);
      return;
    }
    hostService.on('change', (state) => {
      toLauncher('host:state', state);
      refreshTray();
    });
    refreshTray();
    createLauncher();

    if (selftest) require('./selftest').run({ app, hostService, getLauncher: () => launcher, sessions });
  });
}
