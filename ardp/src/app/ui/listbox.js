'use strict';

// a list box: one selected row, arrow keys move it, enter or double click opens it
window.listbox = function listbox(el, onChange, onOpen) {
  let selected = null;
  const rows = () => [...el.querySelectorAll('li[data-id]')];
  const select = (id) => {
    selected = rows().some((r) => r.dataset.id === id) ? id : null;
    for (const r of rows()) r.setAttribute('aria-selected', String(r.dataset.id === selected));
    onChange(selected);
  };

  el.addEventListener('click', (e) => {
    const row = e.target.closest('li[data-id]');
    if (row) select(row.dataset.id);
  });
  el.addEventListener('dblclick', (e) => {
    if (e.target.closest('li[data-id]') && onOpen) onOpen(selected);
  });
  el.addEventListener('keydown', (e) => {
    const list = rows();
    const at = list.findIndex((r) => r.dataset.id === selected);
    if (e.key === 'ArrowDown' && list.length) select(list[Math.min(list.length - 1, at + 1)].dataset.id);
    else if (e.key === 'ArrowUp' && list.length) select(list[Math.max(0, at - 1)].dataset.id);
    else if (e.key === 'Enter' && selected && onOpen) onOpen(selected);
    else return;
    e.preventDefault();
  });

  return {
    get selected() {
      return selected;
    },
    select,
    fill(items, empty) {
      const row = (item) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.dataset.id = item.id;
        const what = document.createElement('span');
        what.className = 'what';
        what.textContent = item.name;
        const state = document.createElement('span');
        state.className = 'state';
        state.textContent = item.state || '';
        li.append(what, state);
        return li;
      };
      const none = Object.assign(document.createElement('li'), { className: 'empty', textContent: empty });
      el.replaceChildren(...(items.length ? items.map(row) : [none]));
      select(selected || (items[0] && items[0].id));
    },
  };
};
