'use strict';

(async () => {
  const api = window.arp;
  const $ = (id) => document.getElementById(id);
  const body = document.body;

  $('min').addEventListener('click', () => api.window('minimize'));
  $('close').addEventListener('click', () => api.window('close'));
  api.onWindow((w) => body.classList.toggle('inactive', !w.focused));

  let fitted = 0;
  new ResizeObserver(() => {
    const height = Math.ceil(body.getBoundingClientRect().height);
    if (height === fitted) return;
    fitted = height;
    api.fit(height);
  }).observe(body);

  $('open-rdp').addEventListener('click', () => api.open('rdp'));
  $('open-vms').addEventListener('click', () => api.open('vms'));

  function render(state) {
    document.title = state.product.name;
    $('window-title').textContent = state.product.name;
    $('product-name').textContent = state.product.name;
    $('product-meaning').textContent = state.product.meaning;
    $('status').textContent = `Version ${state.version}`;

    const { host, vms } = state;
    let led = '';
    let text = 'Not accepting connections';
    if (host.error) {
      led = 'bad';
      text = 'Cannot accept connections';
    } else if (host.listening && host.connected) {
      led = 'live';
      text = host.connected === 1 ? '1 computer connected' : `${host.connected} computers connected`;
    } else if (host.listening) {
      led = 'on';
      text = 'Accepting connections';
    }
    $('status-led').className = `led ${led}`;
    $('status-host').textContent = text;

    if (!vms.available) $('vms-note').textContent = 'Needs QEMU, which is not installed here.';
    else if (vms.running) $('vms-note').textContent = `${vms.running} of ${vms.total} running.`;
    else if (vms.total) $('vms-note').textContent = `${vms.total} on this computer, none running.`;
    else $('vms-note').textContent = 'Run other computers inside this one.';
  }

  api.onState(render);
  render(await api.state());
  $('open-rdp').focus();
})();
