// Arquivos do chat no PC: cópia local de tudo que foi enviado/recebido.
//
// data/arquivos/<conversa>/<id do arquivo>/<nome original>
//
// O upload é feito pelo renderer (XHR com progresso); aqui ficam o download direto
// para o disco, a cópia do que eu mandei e abrir/mostrar/salvar como.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { dialog, shell } = require('electron');

const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PREVIEW_MAX = 25 * 1024 * 1024;

function safeName(name) {
  const n = String(name || 'arquivo').replace(/[\\/\u0000-\u001f<>:"|?*]/g, '_').replace(/^\.+/, '_').trim();
  return n.slice(0, 200) || 'arquivo';
}

class Files {
  constructor(dataDir, send) {
    this.root = path.join(dataDir, 'arquivos');
    this.send = send; // (canal, dados) -> renderer
    this.active = new Map(); // id -> Promise do download em andamento
  }

  target(convId, att) {
    if (!ID_RE.test(convId) || !ID_RE.test(att.id)) throw new Error('id inválido');
    return path.join(this.root, convId, att.id, safeName(att.name));
  }

  /** Caminho do arquivo se já está no PC. */
  local(convId, att) {
    const p = this.target(convId, att);
    return fs.existsSync(p) ? p : null;
  }

  /** Guarda uma cópia do que eu mandei (de um caminho no disco ou dos bytes colados). */
  async keepSent(convId, att, source) {
    const p = this.target(convId, att);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    if (typeof source === 'string') await fs.promises.copyFile(source, p, fs.constants.COPYFILE_FICLONE);
    else await fs.promises.writeFile(p, Buffer.from(source));
    return p;
  }

  download(serverUrl, token, convId, att) {
    if (this.active.has(att.id)) return this.active.get(att.id);
    const job = this._download(serverUrl, token, convId, att).finally(() => this.active.delete(att.id));
    this.active.set(att.id, job);
    return job;
  }

  async _download(serverUrl, token, convId, att) {
    const p = this.target(convId, att);
    if (fs.existsSync(p)) return p;
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    const part = p + '.part';
    const url = new URL(`/files/${att.id}`, serverUrl);
    const lib = url.protocol === 'https:' ? https : http;
    await new Promise((resolve, reject) => {
      const req = lib.get(url, { headers: { authorization: `Bearer ${token}` } }, (res) => {
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            let msg = `HTTP ${res.statusCode}`;
            try {
              msg = JSON.parse(body).error || msg;
            } catch {}
            reject(new Error(msg));
          });
          return;
        }
        const total = Number(res.headers['content-length']) || att.size;
        let done = 0;
        let lastSent = 0;
        const out = fs.createWriteStream(part);
        res.on('data', (c) => {
          done += c.length;
          const now = Date.now();
          if (now - lastSent > 200) {
            lastSent = now;
            this.send('file:progress', { id: att.id, done, total });
          }
        });
        res.pipe(out);
        res.on('aborted', () => reject(new Error('download interrompido')));
        out.on('error', reject);
        out.on('finish', () => (done === total ? resolve() : reject(new Error('download incompleto'))));
      });
      req.on('error', reject);
    }).catch(async (e) => {
      await fs.promises.rm(part, { force: true });
      throw e;
    });
    await fs.promises.rename(part, p);
    this.send('file:progress', { id: att.id, done: att.size, total: att.size });
    return p;
  }

  inside(p) {
    const rel = path.relative(this.root, path.resolve(p));
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('caminho fora da pasta de arquivos');
    return path.resolve(p);
  }

  async read(p) {
    p = this.inside(p);
    const st = await fs.promises.stat(p);
    if (st.size > PREVIEW_MAX) throw new Error('grande demais para pré-visualizar');
    return new Uint8Array(await fs.promises.readFile(p));
  }

  open(p) {
    return shell.openPath(this.inside(p)).then((err) => {
      if (err) throw new Error(err);
    });
  }

  show(p) {
    shell.showItemInFolder(this.inside(p));
  }

  async saveAs(win, p) {
    p = this.inside(p);
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(require('electron').app.getPath('downloads'), path.basename(p)) });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.copyFile(p, r.filePath, fs.constants.COPYFILE_FICLONE);
    return r.filePath;
  }
}

module.exports = { Files };
