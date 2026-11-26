'use strict';

(async () => {
  const api = window.arp;
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const STATE = { stopped: 'off', starting: 'starting', running: 'running', stopping: 'shutting down' };

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

  let vms = await api.state();
  const list = window.listbox($('vm-list'), buttons, (id) => openVm(id));
  const current = () => vms.vms.find((vm) => vm.id === list.selected);

  function message(text) {
    $('vm-message-text').textContent = text || '';
    $('vm-message').hidden = !text;
  }

  function buttons() {
    const vm = current();
    $('vm-new').disabled = !vms.available || !$('vm-form').hidden;
    $('vm-open').disabled = !vm || vm.state === 'stopping';
    $('vm-remove').disabled = !vm || vm.state !== 'stopped';
    const power = $('vm-power');
    power.disabled = !vm || vm.state === 'starting';
    power.textContent = !vm || vm.state === 'stopped' ? 'Start' : vm.state === 'stopping' ? 'Turn off' : vm.state === 'starting' ? 'Starting' : 'Shut down';
  }

  function render(next) {
    vms = next;
    $('vm-hint').textContent = vms.available
      ? 'Open them here, or from another computer like any desktop.'
      : 'This needs QEMU, which is not installed on this computer.';
    list.fill(
      vms.vms.map((vm) => ({ id: vm.id, name: vm.name, state: vm.error && vm.state === 'stopped' ? 'could not start' : STATE[vm.state] })),
      vms.available ? 'No virtual machines yet. Press New to make one.' : 'Install QEMU from qemu.org, then open ARP again.',
    );
    buttons();
  }

  async function call(promise) {
    message('');
    const result = await promise;
    if (result.vms) render(result.vms);
    if (!result.ok && !result.cancelled) message(result.text);
    return result;
  }

  async function openVm(id) {
    if (!id) return;
    message('');
    $('status').textContent = 'Opening…';
    const result = await api.open(id);
    $('status').textContent = 'Ready';
    if (!result.ok && !result.cancelled) message(result.text);
  }

  $('vm-open').addEventListener('click', () => openVm(list.selected));
  $('vm-power').addEventListener('click', () => {
    const vm = current();
    if (!vm) return;
    if (vm.state === 'stopped') call(api.start(vm.id));
    // a second press while it is shutting down pulls the plug
    else call(api.stop(vm.id, vm.state === 'stopping'));
  });
  $('vm-remove').addEventListener('click', () => {
    if (current()) call(api.remove(list.selected));
  });

  const showForm = (show) => {
    $('vm-form').hidden = !show;
    buttons();
    if (show) $('vm-name').focus();
  };
  $('vm-new').addEventListener('click', () => showForm(true));
  $('vm-cancel').addEventListener('click', () => showForm(false));
  $('vm-browse').addEventListener('click', async () => {
    const file = await api.browse();
    if (file) $('vm-iso').value = file;
  });
  $('vm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('vm-create').disabled = true;
    const result = await call(
      api.create({
        name: $('vm-name').value,
        memory: Number($('vm-memory').value),
        cpus: Number($('vm-cpus').value),
        diskGb: Number($('vm-disk').value),
        iso: $('vm-iso').value,
      }),
    );
    $('vm-create').disabled = false;
    if (!result.ok) return;
    $('vm-name').value = '';
    $('vm-iso').value = '';
    showForm(false);
  });

  api.onState(render);
  render(vms);
})();
