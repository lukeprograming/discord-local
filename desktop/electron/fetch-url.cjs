// Busca de páginas/imagens para a prévia de links do chat (fora do renderer: CORS).
// Só https, com limite de tamanho e tempo; a análise do HTML fica no renderer (src/linkpreview.ts).

const { net } = require('electron');

const UA = 'Mozilla/5.0 (compatible; DiscordLocal-LinkPreview/1.0; +https://github.com/lukeprograming/discord-local)';

async function readLimited(res, max) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel().catch(() => {});
      return null; // grande demais
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** kind 'page': devolve texto (até 1 MB) ou, se for imagem, data URL. kind 'image': só imagem (data URL). */
async function fetchUrl(url, kind) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('só https');
  const res = await net.fetch(u.href, {
    headers: { 'user-agent': UA, accept: kind === 'image' ? 'image/*' : 'text/html,image/*;q=0.9,*/*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type.startsWith('image/')) {
    const buf = await readLimited(res, kind === 'image' ? 3 * 1024 * 1024 : 8 * 1024 * 1024);
    if (!buf) throw new Error('imagem grande demais');
    return { type, finalUrl: res.url, dataUrl: `data:${type};base64,${buf.toString('base64')}` };
  }
  if (kind === 'image') throw new Error('não é imagem');
  if (!/html|xml/.test(type)) return { type, finalUrl: res.url };
  const buf = await readLimited(res, 1024 * 1024);
  // Página enorme: as meta tags ficam no começo, então lê só o início.
  return { type, finalUrl: res.url, text: (buf ?? Buffer.alloc(0)).toString('utf8') };
}

module.exports = { fetchUrl };
