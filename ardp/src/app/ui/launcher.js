'use strict';

(async () => {
  const api = window.ardp;
  const $ = (id) => document.getElementById(id);
  const body = document.body;

  let state = await api.state();
  let connecting = false;

  $('min').addEventListener('click', () => api.window('minimize'));
  $('close').addEventListener('click', () => api.window('close'));
  api.onWindow((w) => body.classList.toggle('inactive', !w.focused));

  let fitted = 0;
  function fit() {
    const height = Math.ceil(body.getBoundingClientRect().height);
    if (height !== fitted) {
      fitted = height;
      api.fit(height);
    }
  }
  new ResizeObserver(fit).observe(body);

  function setStatus(text) {
    $('status').textContent = text;
  }

  const { product } = state;
  document.title = product.name;
  $('window-title').textContent = product.name;
  $('product-name').textContent = product.name;
  $('product-meaning').textContent = product.meaning;
  $('about-name').textContent = product.name;
  $('about-meaning').textContent = product.meaning;
  $('about-version').textContent = `Version ${state.version}`;
  $('about-family').textContent = `${product.name} is the remote desktop part of ${product.family.name}, the ${product.family.meaning}.`;

  const tabs = [...document.querySelectorAll('.tab')];
  function selectTab(tab, focus) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    }
    if (focus) tab.focus();
    closeRecent();
  }
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') selectTab(tabs[(i + 1) % tabs.length], true);
      else if (e.key === 'ArrowLeft') selectTab(tabs[(i + tabs.length - 1) % tabs.length], true);
    });
  });
  $('status-host').addEventListener('click', () => selectTab($('tab-host')));

  const address = $('address');
  const code = $('code');
  const recentList = $('recent');
  let recentIndex = -1;

  const recentFor = (text) => state.client.recent.find((r) => r.address === text.trim());

  function syncCodeHint() {
    const saved = recentFor(address.value);
    code.placeholder = saved && saved.hasCode ? 'Saved - leave empty to use it' : 'XXXX-XXXX-XXXX';
    if (saved && saved.hasCode) $('remember').checked = true;
  }

  function renderRecent() {
    recentList.replaceChildren(
      ...state.client.recent.map((r) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.dataset.address = r.address;
        const a = document.createElement('span');
        a.textContent = r.address;
        const n = document.createElement('span');
        n.className = 'name';
        n.textContent = r.name && r.name !== r.address ? r.name : '';
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'forget';
        x.tabIndex = -1;
        x.title = 'Forget this computer';
        x.setAttribute('aria-label', `Forget ${r.address}`);
        x.textContent = '×';
        li.append(a, n, x);
        return li;
      }),
    );
    $('combo-btn').disabled = connecting || state.client.recent.length === 0;
  }

  function openRecent() {
    if (connecting || state.client.recent.length === 0) return;
    recentList.hidden = false;
    address.setAttribute('aria-expanded', 'true');
    highlight(-1);
  }
  function closeRecent() {
    recentList.hidden = true;
    address.setAttribute('aria-expanded', 'false');
  }
  function highlight(index) {
    recentIndex = index;
    [...recentList.children].forEach((li, i) => li.classList.toggle('active', i === index));
  }
  function pick(value) {
    address.value = value;
    closeRecent();
    syncCodeHint();
    clearMessage();
    code.focus();
  }

  $('combo-btn').addEventListener('click', () => {
    if (recentList.hidden) openRecent();
    else closeRecent();
    address.focus();
  });
  // keep focus in the text box
  recentList.addEventListener('mousedown', (e) => e.preventDefault());
  recentList.addEventListener('click', async (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    if (e.target.closest('.forget')) {
      state = await api.forget(li.dataset.address);
      renderRecent();
      if (state.client.recent.length === 0) closeRecent();
      syncCodeHint();
      return;
    }
    pick(li.dataset.address);
  });
  address.addEventListener('keydown', (e) => {
    const count = recentList.children.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (recentList.hidden) {
        openRecent();
        return;
      }
      if (!count) return;
      if (e.key === 'ArrowDown') highlight((recentIndex + 1) % count);
      else highlight(recentIndex <= 0 ? count - 1 : recentIndex - 1);
    } else if (e.key === 'Enter' && !recentList.hidden && recentIndex >= 0) {
      e.preventDefault();
      pick(recentList.children[recentIndex].dataset.address);
    } else if (e.key === 'Escape' && !recentList.hidden) {
      e.preventDefault();
      closeRecent();
    }
  });
  address.addEventListener('input', () => {
    closeRecent();
    syncCodeHint();
    clearMessage();
  });
  address.addEventListener('blur', closeRecent);
  code.addEventListener('input', clearMessage);

  function showMessage(text) {
    $('message-text').textContent = text;
    $('message').hidden = false;
  }
  function clearMessage() {
    $('message').hidden = true;
  }

  $('toggle-options').addEventListener('click', () => {
    const open = $('options').hidden;
    $('options').hidden = !open;
    $('toggle-options').setAttribute('aria-expanded', String(open));
  });

  function setConnecting(on) {
    connecting = on;
    for (const id of ['address', 'code', 'remember', 'quality', 'view-only', 'full-screen']) $(id).disabled = on;
    $('combo-btn').disabled = on || state.client.recent.length === 0;
    $('connect').textContent = on ? 'Cancel' : 'Connect';
    $('connect').classList.toggle('default', !on);
  }

  $('connect-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (connecting) {
      api.cancel();
      return;
    }
    closeRecent();
    clearMessage();
    setConnecting(true);
    setStatus(`Connecting to ${address.value.trim() || 'computer'}…`);
    const result = await api.connect({
      address: address.value,
      code: code.value,
      remember: $('remember').checked,
      quality: $('quality').value,
      viewOnly: $('view-only').checked,
      fullScreen: $('full-screen').checked,
    });
    setConnecting(false);
    setStatus('Ready');
    if (result.ok) {
      code.value = '';
      return;
    }
    if (result.cancelled) return;
    showMessage(result.text);
    const target = result.field === 'code' ? code : address;
    target.focus();
    target.select();
  });

  function renderClient() {
    $('quality').value = state.client.quality;
    $('view-only').checked = state.client.viewOnly;
    $('full-screen').checked = state.client.fullScreen;
    renderRecent();
    if (!address.value && state.client.recent.length) address.value = state.client.recent[0].address;
    syncCodeHint();
  }

  function renderHost(host) {
    state.host = host;
    $('host-enabled').checked = host.enabled;
    $('host-control').checked = host.allowControl && host.canControl;
    $('host-control').disabled = !host.canControl;
    $('host-name').textContent = host.name;
    $('host-address').textContent = host.addresses[0] ? withPort(host.addresses[0], host) : 'No network connection';
    $('copy-address').disabled = !host.addresses[0];
    const others = host.addresses.slice(1, 4);
    $('host-also').hidden = others.length === 0;
    $('host-also').textContent = others.length ? `Also reachable at ${others.join(', ')}` : '';
    $('host-code').textContent = host.code || '';
    if (document.activeElement !== $('host-port')) $('host-port').value = String(host.port);
    $('host-details').classList.toggle('off', !host.enabled);

    const watching = host.sessions.filter((s) => s.streaming);
    let led = '';
    let text = 'Remote connections are off.';
    let short = 'Not accepting connections';
    if (host.error) {
      led = 'bad';
      text = host.error;
      short = 'Cannot accept connections';
    } else if (host.listening && watching.length) {
      led = 'live';
      text = watching.length === 1 ? 'A computer is connected:' : `${watching.length} computers are connected:`;
      short = watching.length === 1 ? '1 computer connected' : `${watching.length} computers connected`;
    } else if (host.listening) {
      led = 'on';
      text = `Waiting for connections on port ${host.port}.`;
      short = 'Accepting connections';
    }
    $('host-led').className = `led ${led}`;
    $('status-led').className = `led ${led}`;
    $('host-status-text').textContent = text;
    $('status-host-text').textContent = short;

    $('host-sessions').replaceChildren(
      ...watching.map((s) => {
        const li = document.createElement('li');
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = `${s.name || 'Unknown'} (${s.address}) - ${s.control ? 'controlling' : 'watching'}`;
        const end = document.createElement('button');
        end.type = 'button';
        end.className = 'btn small';
        end.textContent = 'Disconnect';
        end.addEventListener('click', () => api.disconnect(s.id));
        li.append(who, end);
        return li;
      }),
    );
  }

  const withPort = (addr, host) => (host.port === state.defaultPort ? addr : `${addr}:${host.port}`);

  async function changeHost(change) {
    const result = await api.setHost(change);
    renderHost(result.host);
    if (!result.ok) setStatus(result.text);
  }

  $('host-enabled').addEventListener('change', (e) => changeHost({ enabled: e.target.checked }));
  $('host-control').addEventListener('change', (e) => changeHost({ allowControl: e.target.checked }));
  $('host-port').addEventListener('change', (e) => {
    const port = Number(e.target.value);
    if (Number.isInteger(port)) changeHost({ port });
    else e.target.value = String(state.host.port);
  });
  $('host-port').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur();
  });
  $('new-code').addEventListener('click', async () => renderHost(await api.newCode()));

  function copyButton(button, getText) {
    button.addEventListener('click', () => {
      api.copy(getText());
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = 'Copy';
      }, 1200);
    });
  }
  copyButton($('copy-address'), () => $('host-address').textContent);
  copyButton($('copy-code'), () => $('host-code').textContent);

  $('login-row').hidden = !state.packaged;
  $('start-at-login').checked = state.startAtLogin;
  $('start-at-login').addEventListener('change', (e) => api.startAtLogin(e.target.checked));

  $('about-fingerprint').textContent = state.host.fingerprint;

  api.onHost(renderHost);
  api.onState((next) => {
    state = next;
    renderClient();
    renderHost(state.host);
    setStatus('Ready');
  });

  renderClient();
  renderHost(state.host);
  fit();
  (address.value ? code : address).focus();
})();
