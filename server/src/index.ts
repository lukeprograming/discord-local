// Servidor avulso (sem o app): `node src/index.ts`. O app desktop embute o mesmo servidor no modo host.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startServer } from './server.ts';

/** Escuta só no IP da VPN. HOST sobrescreve; senão tenta o IP do Tailscale. */
function detectHost(): string {
  if (process.env.HOST) return process.env.HOST;
  try {
    return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    console.warn('[server] tailscale não encontrado; escutando só em 127.0.0.1 (defina HOST=<ip da VPN>)');
    return '127.0.0.1';
  }
}

const server = await startServer({
  host: detectHost(),
  port: Number(process.env.PORT ?? 47200),
  dataDir: resolve(process.env.DATA_DIR ?? 'data'),
  name: process.env.SERVER_NAME,
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => server.close().then(() => process.exit(0)));
}
