'use strict';

const { systemPreferences, shell, desktopCapturer } = require('electron');

const mac = process.platform === 'darwin';
const SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_';

// macos lets an app record the screen, and move the pointer or press keys, only after the
// person at the computer has allowed each of the two. elsewhere there is nothing to ask
function status() {
  if (!mac) return { asked: false, screen: true, control: true };
  return {
    asked: true,
    screen: systemPreferences.getMediaAccessStatus('screen') === 'granted',
    control: systemPreferences.isTrustedAccessibilityClient(false),
  };
}

// the system's own question the first time, and the right page of its settings after that
async function request(what) {
  if (!mac) return;
  if (what === 'control') {
    if (!systemPreferences.isTrustedAccessibilityClient(true)) shell.openExternal(`${SETTINGS}Accessibility`);
    return;
  }
  if (what !== 'screen') return;
  // asking for the list of screens is what makes macos ask
  await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => {});
  if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') shell.openExternal(`${SETTINGS}ScreenCapture`);
}

module.exports = { status, request };
