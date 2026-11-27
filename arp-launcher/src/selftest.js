'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { screen } = require('electron');

// runs the real app against itself with a throwaway profile and saves screenshots.
// ARDP_SELFTEST_INPUT=1 also moves the real pointer (needs a second display).
const OUT = process.env.ARDP_SELFTEST_OUT || path.join(os.tmpdir(), 'ardp-selftest');
const PORT = 47389;

exports.profileDir = () => {
  const dir = path.join(OUT, 'profile');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

exports.run = async ({ app, hostService, open, sessions }) => {
  const log = (...args) => console.log('[selftest]', ...args);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const js = (win, code) => win.webContents.executeJavaScript(code, true);
  const click = (win, id) => js(win, `document.getElementById(${JSON.stringify(id)}).click()`);
  const shot = async (win, name) => {
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), image.toPNG());
    const { width, height } = image.getSize();
    log(`wrote ${name} (${width}x${height})`);
  };
  const until = async (what, test, timeout = 15000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await test();
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const setField = (win, id, value) =>
    js(win, `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  const noticeText = (win) => js(win, `document.getElementById('notice').hidden ? '' : document.getElementById('notice-text').textContent`);

  try {
    // no questions on screen during a test
    hostService.config.data.host.askFirst = false;
    const home = open('home');
    await until('the home window', () => home.isVisible() && !home.webContents.isLoading());
    await sleep(700);
    await shot(home, '0-home.png');
    const launcher = open('rdp');
    await until('the launcher', () => launcher.isVisible() && !launcher.webContents.isLoading());
    await sleep(700);
    await shot(launcher, '1-connect.png');

    await click(launcher, 'toggle-options');
    await sleep(300);
    await shot(launcher, '2-connect-options.png');
    await click(launcher, 'toggle-options');

    await click(launcher, 'tab-host');
    await sleep(300);
    await shot(launcher, '3-this-computer-off.png');

    hostService.config.data.host.port = PORT;
    // loopback only: nothing leaves the machine and no firewall prompt
    hostService.config.data.host.bind = '127.0.0.1';
    await click(launcher, 'host-enabled');
    await until('the host to listen', () => hostService.state().listening || hostService.state().error);
    const host = hostService.state();
    if (!host.listening) throw new Error(`host did not start: ${host.error}`);
    await sleep(300);
    await shot(launcher, '4-this-computer-on.png');

    await click(launcher, 'tab-about');
    await sleep(300);
    await shot(launcher, '5-about.png');

    await click(launcher, 'tab-connect');
    await setField(launcher, 'address', `127.0.0.1:${PORT}`);
    await setField(launcher, 'code', 'AAAA-AAAA-AAAA');
    await click(launcher, 'connect');
    const refusal = await until('the refusal', () => js(launcher, `document.getElementById('message').hidden ? '' : document.getElementById('message-text').textContent`));
    log(`wrong code -> "${refusal}"`);
    await sleep(300);
    await shot(launcher, '6-wrong-code.png');
    if (sessions.size !== 0) throw new Error('a session opened with the wrong access code');

    const started = Date.now();
    await setField(launcher, 'code', host.code.toLowerCase().replace(/-/g, ' '));
    await click(launcher, 'connect');
    await until('a session window', () => sessions.size === 1);
    const session = [...sessions][0];
    await until('the remote picture', async () => (await js(session.win, 'window.ardpStats ? window.ardpStats.frames : 0')) >= 5);
    log(`first picture ${Date.now() - started} ms after pressing Connect`);
    await sleep(2500);
    const stats = await js(session.win, 'JSON.parse(JSON.stringify(window.ardpStats))');
    const seconds = ((await js(session.win, 'performance.now()')) - stats.since) / 1000;
    log(`session: ${JSON.stringify(session.opened)}`);
    log(`title: "${session.win.getTitle()}"  bounds: ${JSON.stringify(session.win.getBounds())}`);
    log(`video: ${stats.codec}, ${stats.frames} frames in ${seconds.toFixed(1)} s, ${stats.keyFrames} key, ${(stats.bytes / 1024).toFixed(0)} KiB, first frame after ${stats.firstFrameMs} ms`);
    log(`host sees: ${JSON.stringify(hostService.host.list()[0])}`);
    if (!session.viewOnly || session._control()) throw new Error('a session to this same computer must start out watching');
    await shot(session.win, '7-session.png');

    await click(session.win, 'sysmenu');
    await sleep(200);
    await shot(session.win, '8-session-menu.png');
    await click(session.win, 'sysmenu');

    session.win.setFullScreen(true);
    await until('full screen', () => js(session.win, `document.body.classList.contains('fullscreen')`));
    await sleep(500);
    const hiddenTop = await js(session.win, `document.getElementById('titlebar').getBoundingClientRect().bottom`);
    await until(
      'the title bar to drop in',
      () => {
        session.win.webContents.sendInputEvent({ type: 'mouseMove', x: 400, y: 0 });
        return js(session.win, `document.body.classList.contains('reveal')`);
      },
      4000,
    );
    await sleep(350);
    const shownTop = await js(session.win, `document.getElementById('titlebar').getBoundingClientRect().bottom`);
    log(`full screen: title bar bottom edge at ${Math.round(hiddenTop)}px hidden, ${Math.round(shownTop)}px revealed`);
    await shot(session.win, '8a-full-screen-bar.png');
    if (hiddenTop > 1 || shownTop < 30) throw new Error('the full screen title bar did not hide and return');
    session.win.setFullScreen(false);
    await until('windowed again', () => js(session.win, `!document.body.classList.contains('fullscreen')`));
    await sleep(300);

    const displays = (session.client.sources[0] && session.client.sources[0].displays) || [];
    const other = displays.find((d) => String(d.id) !== session.opened.display);
    if (other) {
      const first = session.opened.display;
      await js(session.win, `window.ardpSession.display(${JSON.stringify(String(other.id))})`);
      await until('the other display', () => session.opened && session.opened.display === String(other.id));
      await until('its picture', async () => !(await noticeText(session.win)));
      await sleep(1200);
      log(`switched display ${first} -> ${session.opened.display} (${other.name}, ${session.opened.width}x${session.opened.height})`);
      await shot(session.win, '8b-second-display.png');
    } else {
      log('one display on this machine; display switching not exercised');
    }

    launcher.show();
    launcher.moveTop();
    await click(launcher, 'tab-host');
    await sleep(700);
    await shot(launcher, '9-this-computer-connected.png');
    await click(launcher, 'tab-connect');
    launcher.hide();

    hostService.disconnect();
    const ended = await until('the session to end', () => noticeText(session.win));
    log(`host disconnect -> "${ended}"`);
    await sleep(300);
    await shot(session.win, '10-session-ended.png');

    session.win.close();
    await until('the launcher to return', () => sessions.size === 0 && launcher.isVisible());

    await inputChecks({ hostService, launcher, sessions, host, log, sleep, js, click, until, setField });

    log('PASSED');
    app.exit(0);
  } catch (err) {
    log('FAILED', err.stack || err.message);
    app.exit(1);
  }
};

async function inputChecks({ hostService, launcher, sessions, host, log, sleep, js, click, until, setField }) {
  const input = hostService.input;
  if (!input) {
    log('input: backend unavailable on this machine');
    return;
  }

  const middle = screen.dipToScreenPoint
    ? screen.dipToScreenPoint({ x: screen.getPrimaryDisplay().bounds.width / 2, y: screen.getPrimaryDisplay().bounds.height / 2 })
    : { x: screen.getPrimaryDisplay().bounds.width / 2, y: screen.getPrimaryDisplay().bounds.height / 2 };
  let close = false;
  for (let attempt = 1; attempt <= 6 && !close; attempt++) {
    const home = input.position();
    const dx = home.x < middle.x ? 9 : -9;
    const dy = home.y < middle.y ? 6 : -6;
    input.move(home.x + dx, home.y + dy);
    await sleep(60);
    const nudged = input.position();
    input.move(home.x, home.y);
    close = Math.abs(nudged.x - home.x - dx) <= 2 && Math.abs(nudged.y - home.y - dy) <= 2;
    log(`pointer injection: moved by (${nudged.x - home.x}, ${nudged.y - home.y}), expected (${dx}, ${dy})`);
    if (!close) await sleep(400);
  }
  // a hand on the mouse spoils the reading, so this one can't be a hard failure
  if (!close) log('pointer injection: inconclusive, the mouse was in use');

  if (process.env.ARDP_SELFTEST_INPUT !== '1') return;

  const shared = screen.getPrimaryDisplay();
  // the session window goes on another display so the injected pointer can't feed back into it
  const park = screen.getAllDisplays().find((d) => d.id !== shared.id);
  if (!park) {
    log('pointer through the wire: skipped, needs a second display');
    return;
  }
  await setField(launcher, 'code', host.code);
  await click(launcher, 'connect');
  await until('the control session', () => sessions.size === 1);
  const session = [...sessions][0];
  session.win.setBounds({ x: park.workArea.x + 40, y: park.workArea.y + 40, width: 802, height: 484 });
  await until('the picture', async () => session.opened && (await js(session.win, 'window.ardpStats ? window.ardpStats.frames : 0')) >= 1);
  // it starts out watching; the button in the title bar takes control
  await click(session.win, 'mode');
  await until('control', async () => session._control() && (await js(session.win, `document.body.classList.contains('controlling')`)));
  await sleep(300);

  const rect = hostService.host.sources()[0].active.rect;
  const box = await js(session.win, `(() => { const r = document.getElementById('screen').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const want = { x: Math.round(rect.x + 0.25 * (rect.width - 1)), y: Math.round(rect.y + 0.5 * (rect.height - 1)) };
  const before = input.position();
  let landed = false;
  for (let attempt = 1; attempt <= 4 && !landed; attempt++) {
    session.win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(box.x + box.w * 0.25) + attempt, y: Math.round(box.y + box.h * 0.5) });
    await sleep(200);
    const at = input.position();
    landed = Math.abs(at.x - want.x) <= 6 && Math.abs(at.y - want.y) <= 4;
    log(`pointer through the wire: landed at (${at.x}, ${at.y}), expected about (${want.x}, ${want.y}) within display ${JSON.stringify(rect)}${landed ? '' : ' - retrying'}`);
  }
  session.win.close();
  input.move(before.x, before.y);
  await until('the launcher to return', () => sessions.size === 0 && launcher.isVisible());
  if (!landed) throw new Error('the pointer did not land where the client pointed');

  const { KEYS } = require('ardp/src/app/host/keymap');
  // only key-ups are sent, and keys that act on release are left out
  const skip = /^(printscreen|win|right_win|cmd|right_cmd|menu|caps_lock|num_lock|scroll_lock|audio_.*)$/;
  const rejected = [];
  for (const [code, name] of Object.entries(KEYS)) {
    if (skip.test(name)) continue;
    try {
      input.native.keyToggle(name, 'up');
    } catch (err) {
      rejected.push(`${code}=${name} (${err.message})`);
    }
  }
  log(`key map: ${Object.keys(KEYS).length} keys checked, ${rejected.length} rejected${rejected.length ? `: ${rejected.join(', ')}` : ''}`);
  if (rejected.length) throw new Error('the key map names keys the input backend does not know');
}

// everything except the picture on your screen: the home window, the vm manager and
// the remote desktop window, with a stand-in for qemu and no window ever shown.
// run: npm run selftest:vm
exports.runQuiet = async ({ app, hostService, vms, open, sessions }) => {
  const log = (...args) => console.log('[selftest]', ...args);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const js = (win, code) => win.webContents.executeJavaScript(code, true);
  const click = (win, id) => js(win, `document.getElementById(${JSON.stringify(id)}).click()`);
  const text = (win, id) => js(win, `document.getElementById(${JSON.stringify(id)}).textContent`);
  const until = async (what, test, timeout = 15000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await test();
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const loaded = async (win) => {
    await until('a window to load', () => !win.webContents.isLoading());
    await sleep(400);
    return win;
  };
  const problems = [];
  const expect = (ok, what) => {
    log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) problems.push(what);
  };
  const frames = (win) => js(win, 'window.ardpStats ? window.ardpStats.frames : 0');
  const menuText = (win) => js(win, `[...document.querySelectorAll('#menu li')].map((li) => li.textContent.trim()).filter(Boolean).join(' | ')`);
  const menuClick = (win, label) =>
    js(win, `[...document.querySelectorAll('#menu li')].find((li) => li.textContent.trim() === ${JSON.stringify(label)}).click()`);
  const closeSession = async (session) => {
    session.win.close();
    await until('the session to close', () => sessions.size === 0);
  };
  const hidden = () => require('electron').BrowserWindow.getAllWindows().every((w) => !w.isVisible());

  try {
    // a mac only lets an app record the screen and use the pointer once someone has said so.
    // where that has not happened, those checks are skipped out loud instead of failing
    const allowed = require('ardp/src/app/host/permissions').status();
    const steer = allowed.control && !!hostService.input;
    log(`this computer: ${process.platform} ${process.arch}, screen recording ${allowed.screen ? 'allowed' : 'not allowed'}, control ${steer ? 'allowed' : 'not allowed'}`);

    // the front door
    const home = await loaded(open('home'));
    expect((await text(home, 'product-name')) === 'ARP' && (await text(home, 'product-meaning')) === 'Aesthetic Remote Protocol', 'the home window says ARP and what it stands for');
    expect(await js(home, `['open-rdp', 'open-vms'].every((id) => !document.getElementById(id).disabled)`), 'remote desktop and virtual machines can both be opened');

    // virtual machines
    await click(home, 'open-vms');
    const manager = await loaded(open('vms'));
    expect(await js(manager, `document.getElementById('vm-new').disabled === false`), 'virtual machines are available');
    const made = await js(manager, `window.arp.create({ name: 'Quiet VM', memory: 1024, cpus: 1, diskGb: 4, iso: '' })`);
    expect(made.ok && made.vms.vms.length === 1 && made.vms.vms[0].state === 'stopped', `a vm can be created: ${JSON.stringify(made.vms.vms)}`);
    const kinds = await js(manager, `[...document.getElementById('vm-arch').options].map((o) => o.value).join(' and ')`);
    expect(kinds === 'x86_64 and aarch64' && !(await js(manager, `document.getElementById('vm-arch').hidden`)), `a new vm can be a pc or an arm computer: ${kinds}`);
    const again = await js(manager, `window.arp.create({ name: 'Quiet VM' })`);
    expect(!again.ok && /already/.test(again.text), `a second one with the same name is refused: ${again.text}`);
    await until('the vm in the list', () => js(manager, `document.querySelectorAll('#vm-list li[data-id]').length === 1`));

    await click(manager, 'vm-open');
    await until('a session window', () => sessions.size === 1);
    let session = [...sessions][0];
    await until('the vm picture', async () => (await frames(session.win)) >= 5);
    const vm = vms.store.get('quiet-vm');
    expect(vm.state === 'running', 'opening the vm switched it on');
    expect(session.win.getTitle() === 'Quiet VM - this computer - ARDP', `title: ${session.win.getTitle()}`);
    expect(session.opened.kind === 'vm' && session.opened.control, 'a vm on this computer can be controlled');
    await until('the vm listed as running', () => js(manager, `document.querySelector('#vm-list .state').textContent === 'running'`));
    expect((await text(home, 'vms-note')) === '1 of 1 running.', `the home window notices: ${await text(home, 'vms-note')}`);

    await click(session.win, 'sysmenu');
    const menu = await menuText(session.win);
    expect(/Send Ctrl\+Alt\+Del \| Restart \| Shut down \| Disconnect$/.test(menu), `the window menu offers the vm's actions: ${menu}`);
    await vm.qmp.execute('x-fake-events');
    await menuClick(session.win, 'Send Ctrl+Alt+Del');
    await js(session.win, `window.ardpSession.input({ t: 'move', x: 1, y: 1 })`);
    await sleep(300);
    const events = await vm.qmp.execute('x-fake-events');
    const typed = events.filter((e) => e.t === 'xkey').map((e) => `${e.code}${e.down ? '+' : '-'}`).join(' ');
    const pointer = events.filter((e) => e.t === 'pointer').map((e) => [e.x, e.y]);
    expect(typed === '29+ 56+ 211+ 211- 56- 29-', `ctrl+alt+del reaches the vm: ${typed}`);
    expect(JSON.stringify(pointer) === JSON.stringify([[1023, 767]]), `the pointer reaches the vm's bottom right corner: ${JSON.stringify(pointer)}`);

    await click(session.win, 'sysmenu');
    await menuClick(session.win, 'Shut down');
    const ended = await until('the session to end', () => js(session.win, `document.getElementById('notice').hidden ? '' : document.getElementById('notice-text').textContent`));
    expect(ended === 'The remote session ended.' && vm.state === 'stopped', `shutting down from the menu ends the session and stops the vm: "${ended}", ${vm.state}`);
    await closeSession(session);

    // remote desktop: it knows about a vm running right here
    await vms.start('quiet-vm');
    await click(home, 'open-rdp');
    const rdp = await loaded(open('rdp'));
    expect((await text(rdp, 'product-name')) === 'ARDP', 'the remote desktop window is ARDP');
    await until('the running vm to be offered', () => js(rdp, `!document.getElementById('local-vms').hidden`));
    expect((await js(rdp, `document.querySelector('#local-vm-list span').textContent`)) === 'Quiet VM', 'it offers the vm that is running on this computer');
    await js(rdp, `document.querySelector('#local-vm-list button').click()`);
    await until('the local vm session', () => sessions.size === 1);
    session = [...sessions][0];
    await until('its picture', async () => (await frames(session.win)) >= 5);
    expect(session.opened.kind === 'vm' && session.local, 'and opens it from there');
    await closeSession(session);

    // from another computer: with a vm running the caller is asked which one
    hostService.config.data.host.port = PORT;
    hostService.config.data.host.bind = '127.0.0.1';
    await hostService.setEnabled(true);
    const fill = (address) =>
      js(rdp, `(() => { const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }; set('address', ${JSON.stringify(address)}); set('code', ${JSON.stringify(hostService.code)}); })()`);
    await fill(`127.0.0.1:${PORT}`);
    await click(rdp, 'connect');
    await until('the chooser', () => js(rdp, `!document.getElementById('chooser').hidden`));
    const offered = await js(rdp, `[...document.querySelectorAll('#chooser-list li')].map((li) => li.textContent).join(' | ')`);
    expect(/the main PC/.test(offered) && /Quiet VMvirtual machine, running/.test(offered), `with a vm running it asks what to open: ${offered}`);
    await js(rdp, `document.querySelector('#chooser-list li[data-id="vm:quiet-vm"]').click()`);
    await click(rdp, 'chooser-open');
    await until('the vm session', () => sessions.size === 1);
    session = [...sessions][0];
    await until('its picture', async () => (await frames(session.win)) >= 5);
    expect(session.opened.kind === 'vm' && session.target.source === 'vm:quiet-vm', `the chosen vm opens: ${session.win.getTitle()}`);
    expect((await text(home, 'status-host')) === '1 computer connected', `the home window shows it: ${await text(home, 'status-host')}`);
    await closeSession(session);

    // operators: someone here says yes once, and that computer is not asked about again
    {
      const asked = [];
      const ask = hostService.approve;
      hostService.approve = async (who) => (asked.push(who.identity), true);
      hostService.config.data.host.askFirst = true;
      const me = hostService.identity.fingerprint;
      const makeButton = `document.querySelector('#host-sessions button[title^="Let this computer"]')`;
      const connectToVm = async () => {
        await fill(`127.0.0.1:${PORT}/vm:quiet-vm`);
        await click(rdp, 'connect');
        await until('a session', () => sessions.size === 1);
        const opened = [...sessions][0];
        await until('it to open', () => opened.opened);
        return opened;
      };

      session = await connectToVm();
      expect(asked.length === 1 && asked[0] === me, 'a computer that is not an operator is asked about, and shows who it is');
      await click(rdp, 'tab-host');
      await until('the connected computer and its button', () => js(rdp, `!!${makeButton}`));
      await js(rdp, `${makeButton}.click()`);
      await until('the operator to be remembered', () => hostService.operators.has(me));
      await until('the operators list', () => js(rdp, `!document.getElementById('host-operators').hidden && document.querySelectorAll('#operator-list li').length === 1`));
      const who = await js(rdp, `document.querySelector('#host-sessions .who').textContent`);
      expect(/, operator$/.test(who) && !(await js(rdp, `!!${makeButton}`)), `a connected computer can be made an operator: ${who.replace(/\(.*\)/, '(…)')}`);
      await closeSession(session);

      session = await connectToVm();
      expect(asked.length === 1, 'an operator connects again and nobody is asked');
      await closeSession(session);

      await js(rdp, `document.querySelector('#operator-list button').click()`);
      await until('the operator to be forgotten', () => !hostService.operators.has(me));
      session = await connectToVm();
      expect(asked.length === 2 && (await js(rdp, `document.getElementById('host-operators').hidden`)), 'once removed it is asked about again');
      await closeSession(session);

      // a computer that shows no identity of its own is asked about every time and cannot be made one
      const { ArdpClient } = require('ardp/src/client/client');
      const stranger = new ArdpClient({ host: '127.0.0.1', port: PORT, accessCode: hostService.code, info: { name: 'stranger', platform: 'test', version: '0' } });
      await stranger.connect();
      await stranger.open({ source: 'vm:quiet-vm', codecs: ['vp8', 'h264'], viewOnly: true });
      await until('the stranger to be listed', () => js(rdp, `document.querySelectorAll('#host-sessions li').length === 1`));
      expect(asked.length === 3 && asked[2] === '' && !(await js(rdp, `!!${makeButton}`)), 'a computer with no identity of its own cannot be made an operator');
      stranger.close();
      await until('the stranger to leave', () => hostService.state().sessions.length === 0);

      hostService.approve = ask;
      await click(rdp, 'tab-connect');
    }

    // with no vm running there is nothing to ask: straight to the pc
    await vms.stop('quiet-vm', true);
    if (allowed.screen) {
      await fill(`127.0.0.1:${PORT}`);
      await click(rdp, 'connect');
      await until('the desktop session', () => sessions.size === 1);
      session = [...sessions][0];
      await until('the desktop to open', () => session.opened);
      await until('the desktop picture', async () => (await frames(session.win)) >= 1);
      expect(session.opened.kind === 'desktop' && (await js(rdp, `document.getElementById('chooser').hidden`)), 'with no vm running it goes straight to the pc');

      if (steer) {
        // this is the same computer, so it starts out watching, with a button to take control
        const mode = () => js(session.win, `(() => { const b = document.getElementById('mode'); return b.hidden || b.disabled ? '' : b.textContent.trim(); })()`);
        await until('the control button', mode);
        expect(session.opened.control && !session._control() && (await mode()) === 'Take control', `looking at this same computer starts out watching: "${await mode()}"`);
        await click(session.win, 'mode');
        await until('control to be taken', () => session._control());
        expect((await mode()) === 'Controlling' && (await js(session.win, `document.body.classList.contains('controlling')`)), 'one click on the title bar button takes control');
        await click(session.win, 'mode');
        await until('control to be given back', () => !session._control());
        expect((await mode()) === 'Take control', 'and another click goes back to watching');
        await closeSession(session);

        // asked to only watch, the other side never grants control; the button asks again for it
        await js(rdp, `document.getElementById('control').click()`);
        await fill(`127.0.0.1:${PORT}`);
        await click(rdp, 'connect');
        await until('the watching session', () => sessions.size === 1);
        session = [...sessions][0];
        await until('it to open', () => session.opened);
        await until('its picture', async () => (await frames(session.win)) >= 1);
        expect(!session.opened.control && hostService.host.list()[0].control === false, 'with the box unticked the host is told to give no control');
        await until('the control button', mode);
        await click(session.win, 'mode');
        await until('control after asking again', () => session.opened && session.opened.control && session._control(), 20000);
        expect(hostService.host.list()[0].control === true, 'taking control later asks the host again, and it agrees');
        await closeSession(session);
        await js(rdp, `document.getElementById('control').click()`);
      } else {
        log('skip  taking control: this computer does not let ARP use its pointer and keyboard');
        await closeSession(session);
      }
    } else {
      log('skip  everything that looks at this desktop: this computer does not let ARP record its screen');
    }

    // private mode: once it is on, no window may hold an address, this computer's name or a code
    if (allowed.screen) {
      const { BrowserWindow } = require('electron');
      const os = require('os');
      const here = `127.0.0.1:${PORT}`;
      // a name that is a plain word cannot be told from the page's own text; its own field is checked below
      const named = /[^a-z]/i.test(os.hostname()) ? os.hostname() : '';
      const secrets = () => ['127.0.0.1', named, hostService.code, hostService.state().fingerprint, ...hostService.state().addresses].filter((s) => s && s.length >= 4);
      const leaks = async () => {
        const found = [];
        for (const win of BrowserWindow.getAllWindows()) {
          const page = await js(win, `document.title + '\\n' + document.documentElement.outerHTML + '\\n' + [...document.querySelectorAll('input:not(.masked)')].map((i) => i.value).join('\\n')`);
          const all = `${win.getTitle()}\n${page}`.toLowerCase();
          for (const secret of secrets()) if (all.includes(secret.toLowerCase())) found.push(`${secret.slice(0, 14)} in "${win.getTitle()}"`);
        }
        return found;
      };
      const setField = (id, value) =>
        js(rdp, `(() => { const el = document.getElementById(${JSON.stringify(id)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      const title = 'Remote computer - ARDP';

      await fill(here);
      await click(rdp, 'connect');
      await until('a session before private mode', () => sessions.size === 1);
      session = [...sessions][0];
      await until('its picture', async () => (await frames(session.win)) >= 1);
      const before = await leaks();
      expect(before.some((l) => l.startsWith('127.0.0.1')) && before.some((l) => l.startsWith(hostService.code)), `without private mode the address and the code are in the windows (${before.length} places)`);

      await click(home, 'private-mode');
      await until('private mode', () => hostService.config.data.app.privateMode === true && session.win.getTitle() === title);
      await sleep(500);
      const after = await leaks();
      expect(after.length === 0, `with private mode on, no window holds an address, a computer name or a code${after.length ? ': ' + after.join(', ') : ''}`);
      expect((await text(session.win, 'title')) === title, 'the session title bar no longer names the computer');
      const saved = hostService.config.data.client.recent.find((r) => r.address === here);
      const byNumber = `Saved computer ${saved.n}`;
      expect((await js(rdp, `document.getElementById('address').value`)) === byNumber, `the saved computer goes by a number instead of its address: ${byNumber}`);
      expect((await text(rdp, 'host-address')) === 'Hidden' && (await text(rdp, 'host-code')) === 'Hidden' && (await text(rdp, 'host-name')) === 'Hidden', "this computer's name, address and code read Hidden");

      // the other side ends it: the notice must not name anyone either
      hostService.disconnect();
      const bye = await until('the ended notice', () => js(session.win, `document.getElementById('notice').hidden ? '' : document.getElementById('notice-text').textContent`));
      const ended = await leaks();
      expect(ended.length === 0, `a session that ends says so without names: "${bye}"${ended.length ? ' but ' + ended.join(', ') : ''}`);
      await closeSession(session);

      // connecting by that number reaches the same computer
      await setField('address', byNumber);
      await setField('code', hostService.code);
      await click(rdp, 'connect');
      await until('a session by number', () => sessions.size === 1);
      session = [...sessions][0];
      await until('it to open', () => session.opened);
      expect(session.address === here && session.win.getTitle() === title, 'connecting to a saved computer by its number reaches the right one');
      await closeSession(session);

      // something typed by hand is dotted out, and an error does not repeat it
      await setField('address', '127.0.0.1:1');
      await setField('code', hostService.code);
      expect(await js(rdp, `document.getElementById('address').classList.contains('masked') && document.getElementById('code').classList.contains('masked')`), 'an address or code typed in private mode is dotted out');
      await click(rdp, 'connect');
      const refusal = await until('the refusal', () => js(rdp, `document.getElementById('message').hidden ? '' : document.getElementById('message-text').textContent`));
      const told = await leaks();
      expect(!/127\.0\.0\.1/.test(refusal) && told.length === 0, `an error does not repeat the address: "${refusal}"${told.length ? ' but ' + told.join(', ') : ''}`);

      await setField('address', byNumber);
      await click(home, 'private-mode');
      await until('private mode to go off', async () => hostService.config.data.app.privateMode === false && (await js(rdp, `document.getElementById('address').value`)) === here);
      expect((await text(rdp, 'host-code')) === hostService.code && !(await js(rdp, `document.getElementById('address').classList.contains('masked')`)), 'switching it off brings everything back');

    }

    expect(hidden(), 'no window was ever shown');
    await vms.remove('quiet-vm');
    expect(vms.state().vms.length === 0, 'the vm can be removed once it is off');
  } catch (err) {
    log('FAILED', err.stack || err.message);
    problems.push(err.message);
  }
  await vms.shutdown().catch(() => {});
  log(problems.length ? `${problems.length} PROBLEM(S)` : 'PASSED');
  app.exit(problems.length ? 1 : 0);
};
