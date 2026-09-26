// Modo host: o servidor roda dentro do próprio app, escutando no IP da VPN do host.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

let running = null; // { url, close, ip, port }

function guessVpn(name, ip) {
  const n = name.toLowerCase();
  const [a, b] = ip.split('.').map(Number);
  if (n.includes('tailscale') || (a === 100 && b >= 64 && b <= 127)) return 'Tailscale';
  if (n.includes('hamachi') || a === 25) return 'Hamachi';
  if (n.startsWith('zt') || n.includes('zerotier')) return 'ZeroTier';
  if (n.includes('radmin') || a === 26) return 'Radmin VPN';
  if (n.startsWith('docker') || n.startsWith('br-') || n.startsWith('veth') || n.includes('vethernet (wsl')) return null;
  return 'Rede local';
}

/** IPs IPv4 da máquina, com um palpite de qual VPN é cada um. */
function listInterfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const vpn = guessVpn(name, a.address);
      if (vpn) out.push({ name, ip: a.address, vpn });
    }
  }
  const rank = { Tailscale: 0, ZeroTier: 1, Hamachi: 2, 'Radmin VPN': 3, 'Rede local': 9 };
  return out.sort((x, y) => rank[x.vpn] - rank[y.vpn]);
}

function tailscaleBin() {
  if (process.platform === 'win32') {
    const p = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
    if (fs.existsSync(p)) return p;
  }
  return 'tailscale';
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim(), missing: err?.code === 'ENOENT' });
    });
  });
}

/** Liga o Tailscale (tailscale up) e espera o IP aparecer. */
async function tailscaleUp(expectedIp) {
  const bin = tailscaleBin();
  const st = await run(bin, ['status', '--json'], 8_000);
  if (st.missing) throw new Error('Tailscale não está instalado neste computador');
  let state = '';
  try {
    state = JSON.parse(st.out).BackendState;
  } catch {
    /* daemon parado: tenta o up mesmo assim */
  }
  if (state === 'Running') return waitForIp(expectedIp);

  let up = await run(bin, ['up'], 25_000);
  // `tailscale up` recusa se a máquina usa flags não-padrão e sugere o comando completo.
  const suggested = up.out.match(/^\s*tailscale up (--.*)$/m)?.[1];
  if (!up.ok && suggested) up = await run(bin, ['up', ...suggested.trim().split(/\s+/)], 25_000);
  const url = up.out.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
  if (url) throw new Error(`O Tailscale precisa de login: abra ${url}`);
  if (!up.ok && /access denied|permission|operator/i.test(up.out)) {
    throw new Error('Sem permissão para ligar o Tailscale. Rode uma vez: sudo tailscale set --operator=$USER');
  }
  if (!up.ok) throw new Error(`Não consegui ligar o Tailscale: ${up.out.split('\n')[0]}`);
  return waitForIp(expectedIp);
}

async function waitForIp(expectedIp) {
  for (let i = 0; i < 30; i++) {
    if (!expectedIp || listInterfaces().some((x) => x.ip === expectedIp)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`O Tailscale ligou, mas o IP ${expectedIp} não apareceu (IP mudou? veja em Configurações)`);
}

async function startHost({ ip, port, name, tailscale }, dataDir) {
  if (running) return status();
  if (tailscale) await tailscaleUp(ip);
  if (!listInterfaces().some((x) => x.ip === ip)) {
    throw new Error(`O IP ${ip} não existe neste computador agora. A VPN está ligada?`);
  }
  const { startServer } = require('./generated/server.cjs');
  try {
    const srv = await startServer({ host: ip, port, dataDir, name });
    running = { ...srv, ip, port };
  } catch (e) {
    if (e.code === 'EADDRINUSE') throw new Error(`A porta ${port} já está em uso (outro servidor aberto?)`);
    throw e;
  }
  return status();
}

async function stopHost() {
  const r = running;
  running = null;
  if (r) await r.close();
  return status();
}

function status() {
  return running ? { running: true, url: running.url, ip: running.ip, port: running.port } : { running: false };
}

module.exports = { listInterfaces, startHost, stopHost, status };
