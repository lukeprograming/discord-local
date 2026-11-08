// Atalhos globais da call (funcionam com outro app/jogo em foco).
//
// KDE (Wayland ou X11): registra direto no kglobalaccel por D-Bus — ele avisa quando a
// tecla é apertada E solta, então dá pra ter push-to-talk de verdade. Os atalhos
// aparecem em Configurações do Sistema > Atalhos como "Discord Local".
// Outros (Windows, GNOME…): globalShortcut do Electron — só avisa o aperto, então
// silenciar/ensurdecer funcionam e o push-to-talk vira "só com o app em foco".

const { execFile, spawn } = require('node:child_process');
const { globalShortcut } = require('electron');

const COMPONENT = 'discord-local';
const NAMES = { mute: 'Silenciar microfone', deafen: 'Ensurdecer', ptt: 'Apertar para falar' };

// ---- acelerador do Electron ("CommandOrControl+Shift+M") <-> código de tecla do Qt ----

const QT_MOD = { Shift: 0x02000000, Control: 0x04000000, Alt: 0x08000000, Meta: 0x10000000 };
const QT_KEYS = {
  Space: 0x20, Tab: 0x01000001, Backspace: 0x01000003, Enter: 0x01000004, Insert: 0x01000006, Delete: 0x01000007,
  Pause: 0x01000008, PrintScreen: 0x01000009, Home: 0x01000010, End: 0x01000011, Left: 0x01000012, Up: 0x01000013,
  Right: 0x01000014, Down: 0x01000015, PageUp: 0x01000016, PageDown: 0x01000017, CapsLock: 0x01000024,
  NumLock: 0x01000025, ScrollLock: 0x01000026, '`': 0x60, '-': 0x2d, '=': 0x3d, '[': 0x5b, ']': 0x5d,
  '\\': 0x5c, ';': 0x3b, "'": 0x27, ',': 0x2c, '.': 0x2e, '/': 0x2f,
};

function toQt(accel) {
  let code = 0;
  for (const part of String(accel).split('+')) {
    const p = part.trim();
    if (/^(CommandOrControl|CmdOrCtrl|Control|Ctrl)$/i.test(p)) code |= QT_MOD.Control;
    else if (/^Shift$/i.test(p)) code |= QT_MOD.Shift;
    else if (/^(Alt|Option)$/i.test(p)) code |= QT_MOD.Alt;
    else if (/^(Super|Meta|Command|Cmd)$/i.test(p)) code |= QT_MOD.Meta;
    else if (/^[A-Z0-9]$/i.test(p)) code |= p.toUpperCase().charCodeAt(0);
    else if (/^F([1-9]|1\d|2[0-4])$/i.test(p)) code |= 0x01000030 + Number(p.slice(1)) - 1;
    else if (QT_KEYS[p] !== undefined) code |= QT_KEYS[p];
    else return null;
  }
  return code & 0x01ffffff ? code : null; // precisa de uma tecla além dos modificadores
}

// ---- backend KDE ----

function gdbus(args) {
  return new Promise((resolve, reject) =>
    execFile('gdbus', ['call', '--session', '--dest', 'org.kde.kglobalaccel', ...args], { timeout: 4000 }, (err, out, errOut) =>
      err ? reject(new Error((errOut || err.message).trim())) : resolve(out),
    ),
  );
}

const actionId = (name) => `['${COMPONENT}', '${name}', 'Discord Local', '${NAMES[name]}']`;

class KdeHotkeys {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.monitor = null;
    this.active = [];
  }

  async set(bindings) {
    await this.clear();
    const failed = [];
    for (const [name, accel] of Object.entries(bindings)) {
      if (!accel || !NAMES[name]) continue;
      const code = toQt(accel);
      if (code === null) {
        failed.push(name);
        continue;
      }
      try {
        await gdbus(['--object-path', '/kglobalaccel', '--method', 'org.kde.KGlobalAccel.doRegister', actionId(name)]);
        // flags 2|4: SetPresent + NoAutoloading (usa a tecla escolhida no app).
        const out = await gdbus([
          '--object-path', '/kglobalaccel', '--method', 'org.kde.KGlobalAccel.setShortcutKeys',
          actionId(name), `[([${code}, 0, 0, 0],)]`, '6',
        ]);
        // O KDE devolve a tecla que ficou; vazia = já usada por outro atalho do sistema.
        if (!new RegExp(`\\b${code}\\b`).test(out)) failed.push(name);
        else this.active.push(name);
      } catch (e) {
        console.warn('[hotkeys] kde', name, e.message);
        failed.push(name);
      }
    }
    if (this.active.length) this.listen();
    return failed;
  }

  listen() {
    const path = `/component/${COMPONENT.replace(/-/g, '_')}`;
    this.monitor = spawn('gdbus', ['monitor', '--session', '--dest', 'org.kde.kglobalaccel', '--object-path', path]);
    let buf = '';
    this.monitor.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = /globalShortcut(Pressed|Released) \('[^']*', '([^']+)'/.exec(line);
        if (m && this.active.includes(m[2])) this.onEvent(m[2], m[1] === 'Pressed');
      }
    });
    this.monitor.on('error', () => {});
  }

  async clear() {
    this.monitor?.kill();
    this.monitor = null;
    const names = this.active;
    this.active = [];
    // Inativo: a tecla volta a funcionar nos outros apps fora da call.
    for (const name of names) {
      await gdbus(['--object-path', '/kglobalaccel', '--method', 'org.kde.KGlobalAccel.setInactive', actionId(name)]).catch(() => {});
    }
  }
}

// ---- backend Electron (sem aviso de soltar a tecla) ----

class ElectronHotkeys {
  constructor(onEvent) {
    this.onEvent = onEvent;
  }

  async set(bindings) {
    await this.clear();
    const failed = [];
    for (const [name, accel] of Object.entries(bindings)) {
      if (!accel || !NAMES[name]) continue;
      if (name === 'ptt') {
        failed.push('ptt'); // sem key-up global: o renderer cuida com o app em foco
        continue;
      }
      try {
        if (!globalShortcut.register(accel, () => this.onEvent(name, true))) failed.push(name);
      } catch {
        failed.push(name);
      }
    }
    return failed;
  }

  async clear() {
    globalShortcut.unregisterAll();
  }
}

function hasKde() {
  return process.platform === 'linux' && /KDE/i.test(process.env.XDG_CURRENT_DESKTOP || '');
}

function createHotkeys(onEvent) {
  return hasKde() ? new KdeHotkeys(onEvent) : new ElectronHotkeys(onEvent);
}

module.exports = { createHotkeys, hasKde, toQt };
