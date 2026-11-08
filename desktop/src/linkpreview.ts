// Prévia de links do chat: título, descrição e imagem (Open Graph), ou a própria imagem.

export type Preview =
  | { kind: 'image'; url: string; image: string }
  | { kind: 'page'; url: string; title: string; description: string; site: string; image: string | null; color: string | null };

const cache = new Map<string, Promise<Preview | null>>();

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

/** Lê as <meta> do <head> (sem DOMParser para não carregar nada da página). */
function metas(html: string): Map<string, string> {
  const head = html.slice(0, 300_000);
  const out = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    const key = attr('property') ?? attr('name');
    const content = attr('content');
    if (!key || !content) continue;
    const k = (key[2] ?? key[3] ?? key[4] ?? '').toLowerCase();
    if (!out.has(k)) out.set(k, decode(content[2] ?? content[3] ?? content[4] ?? ''));
  }
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1];
  if (title && !out.has('title')) out.set('title', decode(title));
  return out;
}

async function build(url: string): Promise<Preview | null> {
  const fetchUrl = window.native.fetchUrl;
  if (!fetchUrl) return null;
  const r = await fetchUrl(url, 'page');
  if (r.dataUrl) return { kind: 'image', url, image: r.dataUrl };
  if (!r.text) return null;
  const m = metas(r.text);
  const title = m.get('og:title') ?? m.get('twitter:title') ?? m.get('title') ?? '';
  const description = m.get('og:description') ?? m.get('twitter:description') ?? m.get('description') ?? '';
  if (!title && !description) return null;
  let image: string | null = null;
  const img = m.get('og:image:secure_url') ?? m.get('og:image') ?? m.get('twitter:image') ?? m.get('twitter:image:src');
  if (img) {
    try {
      const abs = new URL(img, r.finalUrl || url).href;
      image = (await fetchUrl(abs, 'image')).dataUrl ?? null;
    } catch {
      image = null;
    }
  }
  const site = m.get('og:site_name') ?? new URL(r.finalUrl || url).hostname.replace(/^www\./, '');
  const color = m.get('theme-color') ?? null;
  return {
    kind: 'page',
    url,
    title: title.slice(0, 200),
    description: description.slice(0, 300),
    site: site.slice(0, 80),
    image,
    color: color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : null,
  };
}

export function getPreview(url: string): Promise<Preview | null> {
  let p = cache.get(url);
  if (!p) {
    p = build(url).catch(() => null);
    cache.set(url, p);
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
  }
  return p;
}
