import { readFileSync } from 'node:fs';
import type { Plugin } from 'vite';

/**
 * `import b64 from 'x.wasm?base64'` → string base64 do binário, embutida no JS.
 * Sem fetch: no Electron a página é file:// (fetch não funciona) e o CSP barra data: no connect-src.
 */
export function wasmBase64(): Plugin {
  const PREFIX = '\0wasm-base64:';
  return {
    name: 'wasm-base64',
    enforce: 'pre',
    async resolveId(id, importer) {
      if (!id.endsWith('.wasm?base64')) return null;
      const r = await this.resolve(id.slice(0, -'?base64'.length), importer, { skipSelf: true });
      return r ? PREFIX + r.id : null;
    },
    load(id) {
      if (!id.startsWith(PREFIX)) return null;
      return `export default ${JSON.stringify(readFileSync(id.slice(PREFIX.length)).toString('base64'))};`;
    },
  };
}
