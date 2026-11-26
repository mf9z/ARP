'use strict';

(() => {
  const api = window.ardpSession;
  const $ = (id) => document.getElementById(id);

  const body = document.body;
  const canvas = $('screen');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const notice = $('notice');
  const noticeText = $('notice-text');
  const noticeActions = $('notice-actions');
  const menu = $('menu');

  let decoder = null;
  let config = null;
  let waitingForKey = true;
  let decoderFaults = 0;
  const pending = new Map();

  let opened = null;
  let viewOnly = false;
  let live = false;
  let ended = false;
  let fullscreen = false;
  const held = new Set();
  let buttons = 0;

  const stats = { frames: 0, keyFrames: 0, bytes: 0, since: performance.now(), firstFrameMs: null, codec: '' };
  window.ardpStats = stats;

  body.classList.add('fresh');
  if (api.platform === 'darwin') $('menu-meta').textContent = 'Send Command key';

  async function supportedCodecs() {
    const probes = { h264: 'avc1.64002a', vp8: 'vp8', vp9: 'vp09.00.51.08' };
    const out = [];
    for (const [family, codec] of Object.entries(probes)) {
      try {
        const { supported } = await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true });
        if (supported) out.push(family);
      } catch {}
    }
    return out;
  }

  function configure(next) {
    config = next;
    stats.codec = next.codec;
    if (decoder && decoder.state !== 'closed') decoder.close();
    pending.clear();
    waitingForKey = true;
    decoder = new VideoDecoder({ output: present, error: onDecoderError });
    const settings = { codec: next.codec, codedWidth: next.width, codedHeight: next.height, optimizeForLatency: true };
    if (next.description) settings.description = Uint8Array.from(atob(next.description), (c) => c.charCodeAt(0));
    decoder.configure(settings);
  }

  function onDecoderError() {
    decoderFaults += 1;
    if (!config || decoderFaults > 5) {
      showNotice('This computer could not decode the picture.', true);
      return;
    }
    configure(config);
    api.keyframe();
  }

  function onFrame(meta, data) {
    if (!decoder || decoder.state !== 'configured') return;
    if (waitingForKey) {
      if (!meta.key) {
        api.ack(meta.seq);
        return;
      }
      waitingForKey = false;
    }
    // too far behind to catch up, jump to the next key frame
    if (decoder.decodeQueueSize > 10) {
      waitingForKey = true;
      api.keyframe();
      api.ack(meta.seq);
      return;
    }
    stats.bytes += data.byteLength;
    if (meta.key) stats.keyFrames += 1;
    pending.set(meta.timestamp, meta.seq);
    if (pending.size > 600) pending.delete(pending.keys().next().value);
    try {
      decoder.decode(new EncodedVideoChunk({ type: meta.key ? 'key' : 'delta', timestamp: meta.timestamp, data }));
    } catch {
      onDecoderError();
    }
  }

  function present(frame) {
    const seq = pending.get(frame.timestamp);
    pending.delete(frame.timestamp);
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }
    ctx.drawImage(frame, 0, 0);
    frame.close();
    if (seq !== undefined) api.ack(seq);
    stats.frames += 1;
    if (!live) {
      live = true;
      if (stats.firstFrameMs === null) stats.firstFrameMs = Math.round(performance.now() - stats.since);
      decoderFaults = 0;
      body.classList.remove('fresh');
      hideNotice();
      refreshMode();
    }
  }

  function showNotice(text, actions) {
    noticeText.textContent = text;
    noticeActions.hidden = !actions;
    notice.hidden = false;
    if (actions) $('reconnect').focus();
  }

  function hideNotice() {
    notice.hidden = true;
    canvas.focus();
  }

  const controlling = () => !!opened && opened.control && !viewOnly && live && !ended;

  function refreshMode() {
    body.classList.toggle('controlling', controlling());
    const item = menu.querySelector('[data-action="viewonly"]');
    const forced = !opened || !opened.control;
    item.setAttribute('aria-checked', String(viewOnly || forced));
    item.setAttribute('aria-disabled', String(forced));
    for (const el of menu.querySelectorAll('[data-action^="send-"]')) el.setAttribute('aria-disabled', String(!controlling()));
  }

  // the picture is letterboxed inside the canvas
  function pictureRect() {
    const box = canvas.getBoundingClientRect();
    const scale = Math.min(box.width / canvas.width, box.height / canvas.height);
    const width = canvas.width * scale;
    const height = canvas.height * scale;
    return { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2, width, height };
  }

  const unit = (v) => Math.round(Math.min(1, Math.max(0, v)) * 1e5) / 1e5;

  function point(e) {
    const r = pictureRect();
    return { x: unit((e.clientX - r.left) / r.width), y: unit((e.clientY - r.top) / r.height) };
  }

  function releaseAll() {
    if (held.size === 0 && buttons === 0) return;
    held.clear();
    buttons = 0;
    api.input({ t: 'release' });
  }

  canvas.addEventListener('pointermove', (e) => {
    if (controlling()) api.input({ t: 'move', ...point(e) });
  });

  canvas.addEventListener('pointerdown', (e) => {
    closeMenu();
    canvas.focus();
    if (!controlling()) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    buttons |= 1 << e.button;
    api.input({ t: 'button', b: e.button, down: true, ...point(e) });
  });

  const pointerUp = (e) => {
    if (!(buttons & (1 << e.button))) return;
    buttons &= ~(1 << e.button);
    if (controlling()) api.input({ t: 'button', b: e.button, down: false, ...point(e) });
  };
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', () => releaseAll());

  canvas.addEventListener(
    'wheel',
    (e) => {
      if (!controlling()) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
      api.input({ t: 'wheel', dx: e.deltaX * k, dy: e.deltaY * k, ...point(e) });
    },
    { passive: false },
  );

  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('dragstart', (e) => e.preventDefault());

  function onKey(e) {
    const down = e.type === 'keydown';
    if (!menu.hidden) {
      if (down && e.key === 'Escape') closeMenu();
      e.preventDefault();
      return;
    }
    // the one shortcut we keep for ourselves
    if (e.code === 'Enter' && e.ctrlKey && e.altKey) {
      e.preventDefault();
      if (down && !e.repeat) {
        releaseAll();
        api.window('fullscreen');
      }
      return;
    }
    // not controlling: leave tab/enter alone so the notice buttons work
    if (!controlling()) return;
    e.preventDefault();
    if (!e.code) return;
    if (down) held.add(e.code);
    else if (!held.delete(e.code)) return;
    api.input({ t: 'key', code: e.code, down });
  }
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('blur', () => {
    releaseAll();
    closeMenu();
  });

  function tap(...codes) {
    if (!controlling()) return;
    for (const code of codes) api.input({ t: 'key', code, down: true });
    for (const code of codes.reverse()) api.input({ t: 'key', code, down: false });
  }

  function renderDisplays() {
    for (const old of menu.querySelectorAll('.display-item')) old.remove();
    const displays = opened && Array.isArray(opened.displays) ? opened.displays : [];
    if (displays.length < 2) return;
    const anchor = $('menu-displays');
    const items = displays.map((d, i) => {
      const li = document.createElement('li');
      li.className = 'display-item';
      li.setAttribute('role', 'menuitemradio');
      li.setAttribute('aria-checked', String(d.id === opened.display));
      li.dataset.action = 'display';
      li.dataset.display = d.id;
      li.textContent = `Display ${i + 1} - ${d.name}${d.primary ? ' (main)' : ''}`;
      return li;
    });
    const rule = document.createElement('li');
    rule.className = 'sep display-item';
    rule.setAttribute('role', 'separator');
    anchor.after(...items, rule);
  }

  // what the other side can do besides showing a screen: a vm offers restart, shut down...
  const ACTIONS = { 'ctrl-alt-del': 'Send Ctrl+Alt+Del', restart: 'Restart', shutdown: 'Shut down' };

  function renderActions() {
    for (const old of menu.querySelectorAll('.action-item')) old.remove();
    const names = opened && Array.isArray(opened.actions) ? opened.actions.filter((n) => ACTIONS[n]) : [];
    const items = names.map((name) => {
      const li = document.createElement('li');
      li.className = 'action-item';
      li.setAttribute('role', 'menuitem');
      li.setAttribute('aria-disabled', String(!controlling()));
      li.dataset.action = 'source';
      li.dataset.name = name;
      li.textContent = ACTIONS[name];
      return li;
    });
    $('menu-end').before(...items);
  }

  function openMenu() {
    refreshMode();
    renderDisplays();
    renderActions();
    menu.querySelector('[data-action="fullscreen"]').setAttribute('aria-checked', String(fullscreen));
    const anchor = $('sysmenu').getBoundingClientRect();
    menu.style.left = `${Math.max(0, anchor.left)}px`;
    menu.style.top = `${anchor.bottom}px`;
    menu.hidden = false;
  }

  function closeMenu() {
    menu.hidden = true;
  }

  $('sysmenu').addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) openMenu();
    else closeMenu();
  });
  $('sysmenu').addEventListener('dblclick', () => api.window('close'));
  window.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target.closest('#sysmenu') === null) closeMenu();
  });

  menu.addEventListener('click', (e) => {
    const item = e.target.closest('li[data-action]');
    if (!item || item.getAttribute('aria-disabled') === 'true') return;
    closeMenu();
    switch (item.dataset.action) {
      case 'fullscreen':
        api.window('fullscreen');
        break;
      case 'viewonly':
        releaseAll();
        viewOnly = !viewOnly;
        api.viewOnly(viewOnly);
        refreshMode();
        break;
      case 'display':
        if (item.dataset.display !== opened.display) {
          releaseAll();
          api.display(item.dataset.display);
        }
        break;
      case 'source':
        api.action(item.dataset.name);
        break;
      case 'send-meta':
        tap('MetaLeft');
        break;
      case 'send-taskmgr':
        tap('ControlLeft', 'ShiftLeft', 'Escape');
        break;
      case 'disconnect':
        api.window('close');
        break;
      default:
        break;
    }
    canvas.focus();
  });

  $('min').addEventListener('click', () => api.window('minimize'));
  $('max').addEventListener('click', () => api.window(fullscreen ? 'fullscreen' : 'maximize'));
  $('close').addEventListener('click', () => api.window('close'));

  let revealTimer = null;
  let hideTimer = null;
  window.addEventListener('pointermove', (e) => {
    if (!fullscreen) return;
    const overBar = body.classList.contains('reveal') && e.clientY <= 34;
    if (e.clientY <= 1 || overBar || !menu.hidden) {
      clearTimeout(hideTimer);
      hideTimer = null;
      if (!body.classList.contains('reveal') && !revealTimer) {
        revealTimer = setTimeout(() => {
          revealTimer = null;
          body.classList.add('reveal');
        }, 350);
      }
    } else {
      clearTimeout(revealTimer);
      revealTimer = null;
      if (body.classList.contains('reveal') && !hideTimer) {
        hideTimer = setTimeout(() => {
          hideTimer = null;
          body.classList.remove('reveal');
        }, 500);
      }
    }
  });

  api.onState((state) => {
    fullscreen = state.fullscreen;
    body.classList.toggle('maximized', state.maximized || state.fullscreen);
    body.classList.toggle('fullscreen', state.fullscreen);
    body.classList.toggle('inactive', !state.focused);
    if (!state.fullscreen) body.classList.remove('reveal');
    $('max').setAttribute('aria-label', state.maximized || state.fullscreen ? 'Restore' : 'Maximize');
  });

  $('reconnect').addEventListener('click', () => api.reconnect());
  $('dismiss').addEventListener('click', () => api.window('close'));

  api.onInit((init) => {
    document.title = init.title;
    $('title').textContent = init.title;
    viewOnly = !!init.viewOnly;
    showNotice(init.status, false);
  });

  api.onOpened((info) => {
    opened = info;
    ended = false;
    document.title = info.title;
    $('title').textContent = info.title;
    refreshMode();
  });

  api.onConfig((next) => {
    try {
      configure(next);
    } catch {
      showNotice('This computer cannot decode the picture the other computer sends.', true);
    }
  });

  api.onFrame(onFrame);

  api.onStatus((status) => {
    live = false;
    refreshMode();
    showNotice(status.text, false);
  });

  api.onClosed((reason) => {
    ended = true;
    live = false;
    held.clear();
    buttons = 0;
    refreshMode();
    showNotice(reason.text, true);
  });

  supportedCodecs().then((codecs) => api.ready({ codecs }));
})();
