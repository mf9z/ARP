'use strict';

const mac = process.platform === 'darwin';

// event.code -> libnut key name. these are physical keys, the host layout picks the character
const KEYS = {
  Escape: 'escape',
  Tab: 'tab',
  Space: 'space',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ArrowLeft: 'left',
  ArrowUp: 'up',
  ArrowRight: 'right',
  ArrowDown: 'down',

  ShiftLeft: 'shift',
  ShiftRight: 'right_shift',
  ControlLeft: 'control',
  ControlRight: 'right_control',
  AltLeft: 'alt',
  AltRight: 'right_alt',
  MetaLeft: mac ? 'cmd' : 'win',
  MetaRight: mac ? 'right_cmd' : 'right_win',
  ContextMenu: 'menu',

  CapsLock: 'caps_lock',
  NumLock: 'num_lock',
  ScrollLock: 'scroll_lock',
  PrintScreen: 'printscreen',

  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  IntlBackslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',

  NumpadDecimal: 'numpad_decimal',
  NumpadAdd: 'add',
  NumpadSubtract: 'subtract',
  NumpadMultiply: 'multiply',
  NumpadDivide: 'divide',
  ...(mac ? { NumpadEqual: 'numpad_equal' } : {}),

  AudioVolumeMute: 'audio_mute',
  AudioVolumeDown: 'audio_vol_down',
  AudioVolumeUp: 'audio_vol_up',
  MediaPlayPause: 'audio_play',
  MediaStop: 'audio_stop',
  MediaTrackPrevious: 'audio_prev',
  MediaTrackNext: 'audio_next',
};

for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') KEYS[`Key${letter}`] = letter.toLowerCase();
for (let digit = 0; digit <= 9; digit++) {
  KEYS[`Digit${digit}`] = String(digit);
  KEYS[`Numpad${digit}`] = `numpad_${digit}`;
}
for (let f = 1; f <= 24; f++) KEYS[`F${f}`] = `f${f}`;

module.exports = { KEYS: Object.freeze(KEYS) };
