'use strict';

const os = require('os');

const HIDDEN = 'hidden';

const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// private mode's last line of defence: whatever a piece of text was meant to say, it
// leaves here without addresses, home folders, this computer's name or its codes
function scrubber(secrets = () => []) {
  return (text) => {
    if (typeof text !== 'string' || !text) return text;
    let out = text
      .replace(/(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\w.])/g, HIDDEN)
      // anything shaped like an ipv6 address, with or without brackets and a port
      .replace(/(?<![\w:.])\[?[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}\]?(?::\d{1,5})?(?![\w:])/gi, HIDDEN)
      // a home folder carries the account name
      .replace(/([a-z]:\\users\\|\/users\/|\/home\/)[^\\/\s"'<>|]+/gi, `$1${HIDDEN}`);
    for (const secret of [os.hostname(), ...secrets()]) {
      if (findable(secret)) out = out.replace(new RegExp(`(?<![\\w-])${literal(secret)}(?![\\w-])`, 'gi'), HIDDEN);
    }
    return out;
  };
}

// a name like DESKTOP-7QK2 or rohans-pc can be hunted for in a sentence. a plain word such
// as "desktop" cannot, it is ordinary prose; where the app shows the name itself, the
// name is replaced outright and never gets this far
function findable(secret) {
  return typeof secret === 'string' && secret.length >= 4 && /[^a-z]/i.test(secret);
}

// every string in a payload on its way to a window. ids stay as they are, the app needs them back
function deep(value, scrub) {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((item) => deep(item, scrub));
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = key === 'id' ? item : deep(item, scrub);
  return out;
}

module.exports = { scrubber, deep, findable, HIDDEN };
