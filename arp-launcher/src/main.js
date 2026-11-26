'use strict';

const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, ipcMain, Menu, Tray, dialog, clipboard, protocol, net } = require('electron');
const product = require('ardp/src/common/product');
const { parseAddress, formatAddress } = require('ardp/src/common/address');
const { describe } = require('ardp/src/common/messages');
const { ArdpClient } = require('ardp/src/client/client');
const { Config } = require('ardp/src/app/config');
const { HostService } = require('ardp/src/app/host-service');
const { Session } = require('ardp/src/app/session');
const { VmService } = require('./vm-service');

const argv = process.argv.slice(1);
const startHidden = argv.includes('--hidden');
// --selftest-vm tests the vm path with a stand-in for qemu, without ever showing a window
const quiet = argv.includes('--selftest-vm');
const selftest = quiet || argv.includes('--selftest');
if (quiet) process.env.ARP_FAKE_QEMU = '1';

const ARDP = path.dirname(require.resolve('ardp/package.json'));
const KIT = path.join(ARDP, 'src', 'app', 'ui');
const icon = (size) => path.join(ARDP, 'assets', 'icons', `icon-${size}.png`);
const MAX_RECENT = 10;
const ASK_SECONDS = 30;

// the windows this app can open. the remote desktop one belongs to ardp
const WINDOWS = {
  home: { file: path.join(__dirname, 'ui', 'home.html'), preload: path.join(__dirname, 'preload', 'home.js'), width: 400, title: product.arp.name },
  rdp: { file: path.join(KIT, 'launcher.html'), preload: path.join(ARDP, 'src', 'app', 'preload', 'launcher.js'), width: 432, title: product.ardp.name },
  vms: { file: path.join(__dirname, 'ui', 'vms.html'), preload: path.join(__dirname, 'preload', 'vms.js'), width: 432, title: 'Virtual machines' },
};

// lets this app's pages use ardp's stylesheet, logo and scripts wherever ardp is installed
protocol.registerSchemesAsPrivileged([{ scheme: 'ardp-ui', privileges: { standard: true, secure: true } }]);

if (selftest) app.setPath('userData', require('./selftest').profileDir());

if (!selftest && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  let config;
  let hostService;
  let vms;
  let tray = null;
  let dialing = null;
  let choosing = null;
  let quitting = false;
  const windows = {};
  const sessions = new Set();

  const clientInfo = () => ({ name: os.hostname(), platform: process.platform, version: app.getVersion() });
  const running = () => vms.state().vms.filter((vm) => vm.state === 'running' || vm.state === 'starting');
  const busy = () => config.data.host.enabled || vms.state().vms.some((vm) => vm.state !== 'stopped');

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
      const { response } = await ask(windows.rdp, {
        type: 'warning',
        message: `The identity of ${id} has changed.`,
        detail:
          `"${name}" is presenting a different identity than the last time you connected to this address.\n\n` +
          'That is expected if ARP was reinstalled on that computer. Otherwise another machine may be answering in its place.\n\n' +
          `New fingerprint: ${presented.slice(0, 47)}…`,
        buttons: ['Connect anyway', 'Cancel'],
      });
      return response === 0;
    },
  };

  function ask(parent, options) {
    const full = { title: product.arp.name, defaultId: 1, cancelId: 1, noLink: true, ...options };
    return parent && !parent.isDestroyed() && parent.isVisible() ? dialog.showMessageBox(parent, full) : dialog.showMessageBox(full);
  }

  // someone at this computer says yes or no to an incoming connection
  async function approve(who, signal) {
    if (quiet) return true;
    const what = who.kind === 'vm' ? `the virtual machine "${who.sourceName}"` : 'this computer';
    const { response } = await ask(null, {
      type: 'question',
      message: `${who.name || 'A computer'} (${who.address}) wants to ${who.viewOnly ? 'watch' : 'use'} ${what}.`,
      detail: `They already entered the access code. If nobody answers in ${ASK_SECONDS} seconds the answer is no.`,
      buttons: ['Allow', 'Deny'],
      signal: AbortSignal.any([signal, AbortSignal.timeout(ASK_SECONDS * 1000)]),
    });
    return response === 0;
  }

  function open(name) {
    const existing = windows[name];
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      if (!quiet) {
        existing.show();
        existing.focus();
      }
      return existing;
    }
    const spec = WINDOWS[name];
    const win = new BrowserWindow({
      width: spec.width,
      height: 420,
      useContentSize: true,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      frame: false,
      backgroundColor: '#f0f0f0',
      title: spec.title,
      icon: icon(256),
      webPreferences: { preload: spec.preload, contextIsolation: true, sandbox: true, spellcheck: false },
    });
    windows[name] = win;
    win.removeMenu();
    win.loadFile(spec.file);

    // shown once the page has sized itself. started at sign-in it stays in the tray
    win.ardpReveal = () => {
      if (win.isDestroyed() || win.isVisible() || win.ardpRevealed) return;
      win.ardpRevealed = true;
      if (!quiet && !(name === 'home' && startHidden && busy())) win.show();
    };
    win.once('ready-to-show', () => setTimeout(win.ardpReveal, 1500));

    const pushState = () => {
      if (!win.isDestroyed()) win.webContents.send('window:state', { maximized: false, fullscreen: false, focused: win.isFocused() });
    };
    win.on('focus', pushState);
    win.on('blur', pushState);
    win.on('closed', () => {
      if (windows[name] === win) windows[name] = null;
    });
    return win;
  }

  function send(name, channel, payload) {
    const win = windows[name];
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function homeState() {
    const host = hostService.state();
    const all = vms.state();
    return {
      product: product.arp,
      version: app.getVersion(),
      host: { enabled: host.enabled, listening: host.listening, error: host.error, connected: host.sessions.filter((s) => s.streaming).length },
      vms: { available: all.available, total: all.vms.length, running: running().length },
    };
  }

  function rdpState() {
    const client = config.data.client;
    return {
      product: { name: product.ardp.name, meaning: product.ardp.meaning, family: product.arp },
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged,
      startAtLogin: !!config.data.app.startAtLogin,
      defaultPort: product.defaultPort,
      host: hostService.state(),
      localVms: running().map((vm) => ({ id: vm.id, name: vm.name })),
      client: {
        recent: (Array.isArray(client.recent) ? client.recent : []).map((r) => ({ address: r.address, name: r.name || '', hasCode: !!r.code })),
        quality: client.quality,
        viewOnly: !!client.viewOnly,
        fullScreen: !!client.fullScreen,
      },
    };
  }

  function changed() {
    send('home', 'home:state', homeState());
    send('rdp', 'host:state', hostService.state());
    send('rdp', 'local-vms', rdpState().localVms);
    send('vms', 'vm:state', vms.state());
    refreshTray();
  }

  // in the tray while this computer is reachable or runs a vm, so that is never invisible
  function refreshTray() {
    if (!busy()) {
      if (tray) tray.destroy();
      tray = null;
      return;
    }
    if (!tray) {
      tray = new Tray(icon(process.platform === 'darwin' ? 16 : 32));
      tray.on('click', () => open('home'));
    }
    const host = hostService.state();
    const watching = host.sessions.filter((s) => s.streaming).length;
    const notes = [];
    if (host.enabled) notes.push(watching ? `${watching} connected` : 'accepting connections');
    if (running().length) notes.push(`${running().length} virtual machine${running().length === 1 ? '' : 's'} running`);
    tray.setToolTip(`${product.arp.name} - ${notes.join(', ')}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${product.arp.name}`, click: () => open('home') },
        { label: 'Remote desktop', click: () => open('rdp') },
        { label: 'Virtual machines', click: () => open('vms') },
        { type: 'separator' },
        { label: 'Allow remote connections', type: 'checkbox', checked: host.enabled, click: (item) => hostService.setEnabled(item.checked) },
        { label: 'Disconnect everyone', enabled: host.sessions.length > 0, click: () => hostService.disconnect() },
        { type: 'separator' },
        { label: 'Exit', click: () => app.quit() },
      ]),
    );
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

  async function connect(request, { local = false } = {}) {
    const target = parseAddress(request.address);
    if (!target) return { ok: false, field: 'address', text: 'Type the address of the other computer, for example 192.168.1.20.' };
    const shown = formatAddress(target);
    const address = shown + (target.source ? `/${target.source}` : '');

    let code = String(request.code || '').trim();
    if (!code) code = (await savedCode(address)) || '';
    if (!code) return { ok: false, field: 'code', text: 'Type the access code shown in ARP on the other computer.' };

    const options = {
      quality: ['low', 'balanced', 'high'].includes(request.quality) ? request.quality : 'balanced',
      viewOnly: !!request.viewOnly,
      fullScreen: !!request.fullScreen,
    };
    if (!local) {
      Object.assign(config.data.client, options);
      config.save();
    }

    const dial = async () => {
      const client = new ArdpClient({ host: target.host, port: target.port, accessCode: code, info: clientInfo(), trust: local ? null : trust });
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

    const start = async () => {
      if (!local) await remember(target, client.remote.name, code, !!request.remember);
      startSession({ target, client, dial, options, local });
      return { ok: true };
    };

    // the other computer has a vm running: ask whether to open that or the pc itself
    const live = (s) => s.kind === 'vm' && (s.state === 'running' || s.state === 'starting');
    if (!target.source && client.sources.some(live)) {
      choosing = { client, target, start };
      const sources = client.sources.slice(0, 32).map((s) => ({
        id: String(s.id),
        kind: s.kind === 'vm' ? 'vm' : 'desktop',
        name: String(s.name || ''),
        state: s.state ? String(s.state) : '',
      }));
      // the pc first, then what is running, then the rest
      const rank = (s) => (s.kind !== 'vm' ? 0 : live(s) ? 1 : 2);
      return { ok: false, choose: { name: client.remote.name, sources: sources.sort((a, b) => rank(a) - rank(b)) } };
    }
    return start();
  }

  async function choose(id) {
    const pending = choosing;
    choosing = null;
    if (!pending) return { ok: false, cancelled: true };
    if (typeof id !== 'string' || !pending.client.sources.some((s) => String(s.id) === id)) {
      pending.client.abort();
      return { ok: false, cancelled: true };
    }
    pending.target.source = id;
    return pending.start();
  }

  async function openVm(id) {
    const port = await hostService.localPort();
    return connect({ address: `127.0.0.1:${port}/vm:${id}`, code: hostService.code, quality: 'high' }, { local: true });
  }

  function startSession({ target, client, dial, options, local }) {
    const session = new Session({ target, client, redial: dial, options, local, quiet, icon: icon(256) });
    sessions.add(session);
    // like mstsc, the connect window steps aside for a remote session and comes back after
    const rdp = windows.rdp;
    const stepAside = !local && rdp && !rdp.isDestroyed() && rdp.isVisible();
    if (stepAside) rdp.hide();
    session.on('closed', () => {
      sessions.delete(session);
      if (quitting) return;
      if (stepAside && !rdp.isDestroyed()) {
        rdp.show();
        send('rdp', 'launcher:state', rdpState());
      } else if (BrowserWindow.getAllWindows().every((w) => !w.isVisible()) && !quiet) {
        open('home');
      }
    });
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
    ipcMain.on('launcher:fit', (event, height) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !Number.isFinite(height) || win.isResizable()) return;
      const [width] = win.getContentSize();
      win.setContentSize(width, Math.max(160, Math.min(900, Math.round(height))));
      if (win.ardpReveal) win.ardpReveal();
    });

    ipcMain.handle('home:state', () => homeState());
    ipcMain.on('home:open', (_e, name) => {
      if (name === 'rdp' || name === 'vms') open(name);
    });

    ipcMain.handle('launcher:state', () => rdpState());
    ipcMain.handle('launcher:connect', (_e, request) => connect(request || {}));
    ipcMain.on('launcher:cancel', () => {
      if (dialing) dialing.abort();
    });
    ipcMain.handle('launcher:choose', (_e, id) => choose(id));
    ipcMain.handle('launcher:forget', (_e, address) => {
      const client = config.data.client;
      client.recent = (Array.isArray(client.recent) ? client.recent : []).filter((r) => r && r.address !== address);
      config.save();
      return rdpState();
    });

    ipcMain.handle('host:set', async (_e, change) => {
      try {
        if (typeof change.enabled === 'boolean') await hostService.setEnabled(change.enabled);
        if (typeof change.allowControl === 'boolean') hostService.setAllowControl(change.allowControl);
        if (typeof change.askFirst === 'boolean') hostService.setAskFirst(change.askFirst);
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

    const vmCall = async (run) => {
      try {
        await run();
        return { ok: true, vms: vms.state() };
      } catch (err) {
        return { ok: false, text: err.message, vms: vms.state() };
      }
    };
    ipcMain.handle('vm:state', () => vms.state());
    ipcMain.handle('vm:create', (_e, spec) => vmCall(() => vms.create(spec || {})));
    ipcMain.handle('vm:start', (_e, id) => vmCall(() => vms.start(id)));
    ipcMain.handle('vm:stop', (_e, id, force) => vmCall(() => vms.stop(id, force === true)));
    ipcMain.handle('vm:remove', async (_e, id) => {
      const vm = vms.state().vms.find((v) => v.id === id);
      if (!vm) return { ok: false, vms: vms.state() };
      const { response } = await ask(windows.vms, {
        type: 'warning',
        message: `Delete "${vm.name}" and its disk?`,
        detail: 'Everything stored inside the virtual machine is lost. This cannot be undone.',
        buttons: ['Delete', 'Cancel'],
      });
      if (response !== 0) return { ok: false, cancelled: true, vms: vms.state() };
      return vmCall(() => vms.remove(id));
    });
    ipcMain.handle('vm:open', async (_e, id) => {
      try {
        return await openVm(String(id));
      } catch (err) {
        return { ok: false, text: err.message };
      }
    });
    ipcMain.handle('vm:browse', async () => {
      const picked = await dialog.showOpenDialog(windows.vms, {
        title: 'Choose an installer',
        filters: [{ name: 'Disc images', extensions: ['iso', 'img'] }],
        properties: ['openFile'],
      });
      return picked.canceled ? '' : picked.filePaths[0];
    });

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
  app.on('second-instance', () => open('home'));
  app.on('activate', () => open('home'));
  app.on('window-all-closed', () => {
    if (!config || !busy()) app.quit();
  });
  // running vms get a proper shutdown before the app goes away
  let vmsDown = false;
  app.on('before-quit', (event) => {
    quitting = true;
    if (vmsDown || !vms || !vms.state().vms.some((vm) => vm.state !== 'stopped')) return;
    event.preventDefault();
    vms.shutdown().finally(() => {
      vmsDown = true;
      app.quit();
    });
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
    if (process.platform === 'win32') app.setAppUserModelId('app.arp.desktop');

    protocol.handle('ardp-ui', (request) => net.fetch(pathToFileURL(path.join(KIT, path.basename(new URL(request.url).pathname))).toString()));

    const dir = app.getPath('userData');
    config = new Config(dir);
    vms = new VmService({ dir });
    hostService = new HostService({ config, dir, version: app.getVersion(), extraSources: () => vms.sources(), approve });
    registerIpc();
    try {
      await hostService.init();
    } catch (err) {
      dialog.showErrorBox(product.arp.name, `ARP could not start.\n\n${err.message}`);
      app.exit(1);
      return;
    }
    hostService.on('change', changed);
    vms.on('change', changed);
    refreshTray();
    open('home');

    if (selftest) require('./selftest')[quiet ? 'runQuiet' : 'run']({ app, hostService, vms, open, sessions });
  });
}
