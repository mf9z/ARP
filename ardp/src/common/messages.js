'use strict';

const MESSAGES = {
  refused: (h) => `${h} refused the connection. Check that ARDP is open on that computer and that it allows remote connections.`,
  unreachable: (h) => `${h} could not be reached. Check the address, and that both computers are on the same network.`,
  not_found: (h) => `No computer named ${h} was found.`,
  timeout: () => 'The other computer stopped answering.',
  lost: () => 'The connection was lost.',
  closed: () => 'Disconnected.',
  auth_failed: () => 'The access code is not correct.',
  identity_changed: () => 'The connection was cancelled because the other computer could not be recognised.',
  host_untrusted: () => 'The computer that answered could not prove it knows the access code, so the connection was closed.',
  bad_protocol: (h) => `${h} is not an ARDP computer, or it runs an incompatible version.`,
  version: () => 'The two computers run incompatible versions of ARDP.',
  host_disabled: () => 'That computer is not accepting remote connections.',
  host_stopped: () => 'Remote connections were turned off on the other computer.',
  denied: () => 'The other computer did not allow the connection.',
  kicked: () => 'The other computer ended the session.',
  replaced: () => 'Another computer took over this session.',
  no_source: () => 'That computer or virtual machine is not available.',
  capture_failed: () => 'The other computer could not share its screen.',
  display_changed: () => 'The remote display changed.',
  source_ended: () => 'The remote session ended.',
};

const KEEP_REMOTE_TEXT = new Set(['rate_limited', 'capture_failed', 'internal']);

function describe(error, host = 'The computer') {
  const code = (error && error.code) || 'lost';
  const remote = error && error.message && error.message !== code ? error.message : '';
  if (KEEP_REMOTE_TEXT.has(code) && remote) return remote;
  const make = MESSAGES[code];
  return make ? make(host) : remote || 'The connection ended unexpectedly.';
}

module.exports = { describe };
