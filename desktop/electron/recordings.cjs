// Gravações e clipes da call: o renderer manda pedaços (MediaRecorder) e aqui vão
// direto pro disco, sem acumular a gravação inteira na memória.
//
// data/gravacoes/Gravação 2026-11-08 17-05-03.webm
// data/clipes/Clipe 2026-11-08 17-06-10.webm

const fs = require('node:fs');
const path = require('node:path');
const { shell } = require('electron');

class Recordings {
  constructor(dataDir) {
    this.dirs = { gravacao: path.join(dataDir, 'gravacoes'), clipe: path.join(dataDir, 'clipes') };
    this.open = new Map(); // id -> { fd, path }
    this.seq = 0;
  }

  start(kind, ext) {
    const dir = this.dirs[kind];
    if (!dir) throw new Error('tipo inválido');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toLocaleString('sv-SE').replace(/:/g, '-');
    const label = kind === 'clipe' ? 'Clipe' : 'Gravação';
    const safeExt = /^(webm|ogg|mp4)$/.test(ext) ? ext : 'webm';
    let file = path.join(dir, `${label} ${stamp}.${safeExt}`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${label} ${stamp} (${i}).${safeExt}`);
    const id = String(++this.seq);
    this.open.set(id, { fd: fs.openSync(file, 'w'), path: file });
    return { id, path: file };
  }

  write(id, bytes) {
    const r = this.open.get(id);
    if (!r) throw new Error('gravação não está aberta');
    fs.writeSync(r.fd, Buffer.from(bytes));
  }

  finish(id) {
    const r = this.open.get(id);
    if (!r) return null;
    fs.closeSync(r.fd);
    this.open.delete(id);
    return r.path;
  }

  /** App fechando no meio: fecha os arquivos (o que já foi gravado fica). */
  closeAll() {
    for (const id of [...this.open.keys()]) this.finish(id);
  }

  show(p) {
    const abs = path.resolve(p);
    if (!Object.values(this.dirs).some((d) => abs.startsWith(d + path.sep))) throw new Error('caminho inválido');
    shell.showItemInFolder(abs);
  }
}

module.exports = { Recordings };
