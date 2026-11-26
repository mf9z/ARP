'use strict';

class ArdpError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ArdpError';
    this.code = code;
  }
}

function fromSocketError(err) {
  if (!err) return new ArdpError('closed', 'The connection was closed.');
  if (err instanceof ArdpError) return err;
  switch (err.code) {
    case 'ECONNREFUSED':
      return new ArdpError('refused', 'The computer refused the connection.');
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EHOSTDOWN':
    case 'EADDRNOTAVAIL':
      return new ArdpError('unreachable', 'The computer could not be reached.');
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new ArdpError('not_found', 'The computer name could not be found.');
    case 'ECONNRESET':
    case 'EPIPE':
      return new ArdpError('lost', 'The connection was lost.');
    case 'timeout':
      return new ArdpError('timeout', 'The connection timed out.');
    case 'bad_protocol':
      return new ArdpError('bad_protocol', err.message);
    default:
      return new ArdpError(typeof err.code === 'string' && /^[a-z_]+$/.test(err.code) ? err.code : 'lost', err.message);
  }
}

module.exports = { ArdpError, fromSocketError };
