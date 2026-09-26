// "Carimbo" do instalador dos conectados: a configuração do host (endereço + convite)
// vai anexada no fim do próprio arquivo do instalador, numa linha:
//
//   \n#DLOCAL1#<json em base64>#END#\n
//
// - Linux (AppImage): o app lê o fim do próprio arquivo ($APPIMAGE).
// - Windows (NSIS): o instalador copia essa linha para <pasta do app>/conexao.cfg
//   (ver build/installer.nsh) e o app lê de lá.

const fs = require('node:fs');
const path = require('node:path');

const MARK = '#DLOCAL1#';
const END = '#END#';
const TAIL_BYTES = 4096;

function encode(cfg) {
  return `\n${MARK}${Buffer.from(JSON.stringify(cfg)).toString('base64')}${END}\n`;
}

function parseLine(text) {
  const i = text.lastIndexOf(MARK);
  if (i < 0) return null;
  const j = text.indexOf(END, i);
  if (j < 0) return null;
  try {
    const cfg = JSON.parse(Buffer.from(text.slice(i + MARK.length, j), 'base64').toString('utf8'));
    return typeof cfg.server_url === 'string' ? cfg : null;
  } catch {
    return null;
  }
}

function readTail(file) {
  const { size } = fs.statSync(file);
  const len = Math.min(size, TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return { buf, size };
  } finally {
    fs.closeSync(fd);
  }
}

/** Tamanho do arquivo sem o carimbo (se houver). */
function unstampedSize(file) {
  const { buf, size } = readTail(file);
  const i = buf.lastIndexOf(Buffer.from(`\n${MARK}`));
  return i < 0 ? size : size - buf.length + i;
}

/** Configuração embutida neste app, se ele veio de um instalador exportado por um host. */
function readEmbedded() {
  const candidates = [];
  if (process.env.DLOCAL_CONFIG) candidates.push(process.env.DLOCAL_CONFIG);
  if (process.env.APPIMAGE) candidates.push(process.env.APPIMAGE);
  candidates.push(path.join(path.dirname(process.execPath), 'conexao.cfg'));
  for (const file of candidates) {
    try {
      const cfg = parseLine(readTail(file).buf.toString('latin1'));
      if (cfg) return cfg;
    } catch {
      /* não existe */
    }
  }
  return null;
}

/** Copia o instalador limpo `src` para `dest` com o carimbo `cfg` no fim. */
function stamp(src, dest, cfg) {
  const keep = unstampedSize(src);
  const tmp = `${dest}.part`;
  const inFd = fs.openSync(src, 'r');
  const outFd = fs.openSync(tmp, 'w');
  try {
    const chunk = Buffer.alloc(4 * 1024 * 1024);
    let pos = 0;
    while (pos < keep) {
      const n = fs.readSync(inFd, chunk, 0, Math.min(chunk.length, keep - pos), pos);
      if (!n) break;
      fs.writeSync(outFd, chunk, 0, n);
      pos += n;
    }
    fs.writeSync(outFd, encode(cfg));
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }
  fs.renameSync(tmp, dest);
  if (dest.endsWith('.AppImage')) fs.chmodSync(dest, 0o755);
}

function isStamped(file) {
  return unstampedSize(file) !== fs.statSync(file).size;
}

module.exports = { readEmbedded, stamp, isStamped };
