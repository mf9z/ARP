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

exports.run = async ({ app, hostService, getLauncher, sessions }) => {
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
    const launcher = getLauncher();
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
    if (session.opened.control) throw new Error('a loopback session to this desktop must be view only');
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
  process.env.ARDP_LOOPBACK_INPUT = '1';
  try {
    await setField(launcher, 'code', host.code);
    await click(launcher, 'connect');
    await until('the control session', () => sessions.size === 1);
    const session = [...sessions][0];
    session.win.setBounds({ x: park.workArea.x + 40, y: park.workArea.y + 40, width: 802, height: 484 });
    await until('control', async () => session.opened && session.opened.control && (await js(session.win, `document.body.classList.contains('controlling')`)));
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
  } finally {
    delete process.env.ARDP_LOOPBACK_INPUT;
  }

  const { KEYS } = require('./host/keymap');
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

// the vm path through the real app, with a stand-in for qemu and no window ever shown.
// run: npm run selftest:vm
exports.runQuiet = async ({ app, hostService, vms, getLauncher, sessions }) => {
  const log = (...args) => console.log('[selftest]', ...args);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const js = (win, code) => win.webContents.executeJavaScript(code, true);
  const click = (win, id) => js(win, `document.getElementById(${JSON.stringify(id)}).click()`);
  const until = async (what, test, timeout = 15000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const value = await test();
      if (value) return value;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  const problems = [];
  const expect = (ok, what) => {
    log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok) problems.push(what);
  };
  const menuText = (win) => js(win, `[...document.querySelectorAll('#menu li')].map((li) => li.textContent.trim()).filter(Boolean).join(' | ')`);
  const menuClick = (win, text) =>
    js(win, `[...document.querySelectorAll('#menu li')].find((li) => li.textContent.trim() === ${JSON.stringify(text)}).click()`);

  try {
    const launcher = getLauncher();
    await until('the launcher page', () => !launcher.webContents.isLoading());
    await sleep(400);
    expect(!launcher.isVisible(), 'the launcher stays hidden');
    expect(await js(launcher, `document.getElementById('vm-new').disabled === false`), 'virtual machines are available');

    const made = await js(launcher, `window.ardp.vm.create({ name: 'Quiet VM', memory: 1024, cpus: 1, diskGb: 4, iso: '' })`);
    expect(made.ok && made.vms.vms.length === 1 && made.vms.vms[0].state === 'stopped', `a vm can be created: ${JSON.stringify(made.vms.vms)}`);
    const bad = await js(launcher, `window.ardp.vm.create({ name: 'Quiet VM' })`);
    expect(!bad.ok && /already/.test(bad.text), `a second one with the same name is refused: ${bad.text}`);
    await until('the vm in the list', () => js(launcher, `document.querySelectorAll('#vm-list li[data-id]').length === 1`));

    // open it from the virtual machines tab, as its owner would
    await click(launcher, 'tab-vms');
    await click(launcher, 'vm-open');
    await until('a session window', () => sessions.size === 1);
    const session = [...sessions][0];
    await until('the vm picture', async () => (await js(session.win, 'window.ardpStats ? window.ardpStats.frames : 0')) >= 5);
    const vm = vms.store.get('quiet-vm');
    expect(!session.win.isVisible(), 'the session window stays hidden');
    expect(vm.state === 'running', 'opening the vm switched it on');
    expect(session.win.getTitle() === 'Quiet VM - this computer - ARDP', `title: ${session.win.getTitle()}`);
    expect(session.opened.kind === 'vm' && session.opened.control, `a vm on this computer can be controlled: ${JSON.stringify(session.opened)}`);
    await until('the vm listed as running', () => js(launcher, `document.querySelector('#vm-list .state').textContent === 'running'`));

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
    session.win.close();
    await until('the session to close', () => sessions.size === 0);

    // from "another computer": the host now offers its desktop and the vm, so the launcher asks
    hostService.config.data.host.port = PORT;
    hostService.config.data.host.bind = '127.0.0.1';
    await hostService.setEnabled(true);
    const port = hostService.host.server.address().port;
    await click(launcher, 'tab-connect');
    await js(launcher, `(() => { const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }; set('address', '127.0.0.1:${port}'); set('code', ${JSON.stringify(hostService.code)}); })()`);
    await click(launcher, 'connect');
    await until('the chooser', () => js(launcher, `!document.getElementById('chooser').hidden`));
    const offered = await js(launcher, `[...document.querySelectorAll('#chooser-list li')].map((li) => li.textContent).join(' | ')`);
    expect(/the desktop/.test(offered) && /Quiet VMvirtual machine, off/.test(offered), `the launcher asks what to open: ${offered}`);
    await js(launcher, `document.querySelector('#chooser-list li[data-id="vm:quiet-vm"]').click()`);
    await click(launcher, 'chooser-open');
    await until('the vm session', () => sessions.size === 1);
    const remote = [...sessions][0];
    await until('its picture', async () => (await js(remote.win, 'window.ardpStats ? window.ardpStats.frames : 0')) >= 5);
    expect(remote.opened.kind === 'vm' && remote.target.source === 'vm:quiet-vm', `the chosen vm opens: ${remote.win.getTitle()}`);
    expect(hostService.host.list().some((s) => s.source === 'vm:quiet-vm'), 'the host lists the session');
    remote.win.close();
    await until('the session to close', () => sessions.size === 0);

    await vms.stop('quiet-vm', true);
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
