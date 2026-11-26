'use strict';

const CODE = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

const unit = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
const delta = (v) => (Number.isFinite(v) ? Math.min(10000, Math.max(-10000, v)) : 0);

function sanitise(ev) {
  if (!ev || typeof ev !== 'object') return null;
  switch (ev.t) {
    case 'move': {
      const x = unit(ev.x);
      const y = unit(ev.y);
      return x === null || y === null ? null : { t: 'move', x, y };
    }
    case 'button': {
      if (!Number.isInteger(ev.b) || ev.b < 0 || ev.b > 4) return null;
      const out = { t: 'button', b: ev.b, down: ev.down === true };
      const x = unit(ev.x);
      const y = unit(ev.y);
      if (x !== null && y !== null) {
        out.x = x;
        out.y = y;
      }
      return out;
    }
    case 'wheel': {
      const out = { t: 'wheel', dx: delta(ev.dx), dy: delta(ev.dy) };
      const x = unit(ev.x);
      const y = unit(ev.y);
      if (x !== null && y !== null) {
        out.x = x;
        out.y = y;
      }
      return out.dx === 0 && out.dy === 0 ? null : out;
    }
    case 'key':
      if (typeof ev.code !== 'string' || !CODE.test(ev.code)) return null;
      return { t: 'key', code: ev.code, down: ev.down === true };
    case 'release':
      return { t: 'release' };
    default:
      return null;
  }
}

module.exports = { sanitise };
