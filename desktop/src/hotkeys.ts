// Atalhos da call: silenciar, ensurdecer e push-to-talk.
// Globais (com o jogo em foco) quando o sistema deixa; push-to-talk também funciona
// com o app em foco em qualquer sistema (teclado lido aqui no renderer).

import type { HotkeyName, Settings } from './native.d.ts';

export const HOTKEY_DEFAULTS: Record<HotkeyName, string> = {
  mute: 'CommandOrControl+Shift+M',
  deafen: 'CommandOrControl+Shift+D',
  ptt: '',
};

export function hotkeyOf(s: Settings | undefined, name: HotkeyName): string {
  const v = s?.[`hotkey_${name}` as const];
  return v === undefined ? HOTKEY_DEFAULTS[name] : v;
}

const CODE_KEYS: Record<string, string> = {
  Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Enter: 'Enter', Insert: 'Insert', Delete: 'Delete',
  Pause: 'Pause', PrintScreen: 'PrintScreen', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', CapsLock: 'CapsLock',
  ScrollLock: 'ScrollLock', NumLock: 'NumLock', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[',
  BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

/** Tecla apertada -> acelerador do Electron. null = só modificador (ainda montando a combinação). */
export function accelFromEvent(e: KeyboardEvent | React.KeyboardEvent): string | null {
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1\d|2[0-4])$/.test(e.code)) key = e.code;
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  if (!key) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  return [...mods, key].join('+');
}

/** Texto amigável: "Ctrl + Shift + M". */
export function prettyAccel(a: string): string {
  if (!a) return 'nenhum';
  return a.replace('CommandOrControl', 'Ctrl').replace('Super', 'Win').split('+').join(' + ');
}

/** Só a tecla principal (para push-to-talk com o app em foco, o soltar não traz os modificadores iguais). */
export function mainKey(accel: string): string {
  return accel.split('+').pop() ?? '';
}
