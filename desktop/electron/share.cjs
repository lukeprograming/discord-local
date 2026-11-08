// Pasta compartilhada: os amigos navegam e baixam arquivos de uma pasta escolhida.
// Nada sai de fora dela (caminho resolvido de verdade, sem "..", sem atalho/link pra fora).

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { app, dialog, shell } = require('electron');

async function resolveInside(root, rel) {
  const realRoot = await fs.promises.realpath(root);
  const clean = path.normalize('/' + String(rel || '')).replace(/^[/\\]+/, '');
  const target = await fs.promises.realpath(path.join(realRoot, clean));
  const r = path.relative(realRoot, target);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error('fora da pasta compartilhada');
  return target;
}

async function list(root, rel) {
  const dir = await resolveInside(root, rel);
  const out = [];
  for (const d of await fs.promises.readdir(dir, { withFileTypes: true })) {
    if (d.name.startsWith('.')) continue; // escondidos ficam de fora
    try {
      const full = await resolveInside(root, path.join(rel || '', d.name));
      const st = await fs.promises.stat(full);
      out.push({ name: d.name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs });
    } catch {
      /* link quebrado ou pra fora: ignora */
    }
    if (out.length >= 2000) break;
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, 'pt-BR'));
}

/** Sobe o arquivo pro host (transferência de uso único) e devolve o link. */
async function upload(root, rel, serverUrl, token, toUserId) {
  const file = await resolveInside(root, rel);
  const st = await fs.promises.stat(file);
  if (!st.isFile()) throw new Error('não é um arquivo');
  const name = path.basename(file);
  const url = new URL(`/transfers?to=${encodeURIComponent(toUserId)}&name=${encodeURIComponent(name)}`, serverUrl);
  const lib = url.protocol === 'https:' ? https : http;
  const body = await new Promise((resolve, reject) => {
    const req = lib.request(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-length': st.size } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          res.statusCode === 200 ? resolve(j) : reject(new Error(j.error || `HTTP ${res.statusCode}`));
        } catch {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    fs.createReadStream(file).on('error', reject).pipe(req);
  });
  return { url: body.url, name, size: st.size };
}

/** Baixa um link de transferência pra Downloads/Discord Local. */
function download(fullUrl, name, onProgress) {
  const dir = path.join(app.getPath('downloads'), 'Discord Local');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || 'arquivo').replace(/[\\/\u0000-\u001f<>:"|?*]/g, '_').slice(0, 200) || 'arquivo';
  const ext = path.extname(safe);
  let dest = path.join(dir, safe);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${path.basename(safe, ext)} (${i})${ext}`);
  const url = new URL(fullUrl);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    lib
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(res.statusCode === 404 ? 'link expirado' : `HTTP ${res.statusCode}`));
        }
        const total = Number(res.headers['content-length']) || 0;
        let done = 0;
        let last = 0;
        const out = fs.createWriteStream(dest + '.part');
        res.on('data', (c) => {
          done += c.length;
          if (Date.now() - last > 250) {
            last = Date.now();
            onProgress(done, total);
          }
        });
        res.pipe(out);
        out.on('finish', () => {
          if (total && done !== total) return reject(new Error('download incompleto'));
          fs.renameSync(dest + '.part', dest);
          onProgress(done, total);
          resolve(dest);
        });
        out.on('error', reject);
        res.on('aborted', () => reject(new Error('download interrompido')));
      })
      .on('error', reject);
  });
}

async function pickFolder(win) {
  const r = await dialog.showOpenDialog(win, { title: 'Pasta para compartilhar com os amigos', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
}

module.exports = { list, upload, download, pickFolder, show: (p) => shell.showItemInFolder(p) };
