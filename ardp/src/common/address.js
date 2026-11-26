'use strict';

const { defaultPort } = require('./product');

function parseAddress(input) {
  let text = String(input || '').trim();
  if (!text) return null;
  text = text.replace(/^ardp:\/\//i, '');

  let source;
  const slash = text.indexOf('/');
  if (slash !== -1) {
    source = text.slice(slash + 1).trim() || undefined;
    text = text.slice(0, slash).trim();
  }

  let host = text;
  let port = defaultPort;

  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(text);
  if (bracket) {
    host = bracket[1];
    if (bracket[2]) port = Number(bracket[2]);
  } else if ((text.match(/:/g) || []).length === 1) {
    const [h, p] = text.split(':');
    if (!/^\d+$/.test(p)) return null;
    host = h;
    port = Number(p);
  }

  if (!host || /\s/.test(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port, source };
}

function formatAddress({ host, port }) {
  if (!port || port === defaultPort) return host;
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

function isLoopback(address) {
  if (!address) return false;
  const a = String(address).replace(/^::ffff:/i, '');
  return a === '::1' || a === 'localhost' || /^127\./.test(a);
}

module.exports = { parseAddress, formatAddress, isLoopback };
