// Áudio do sistema na transmissão de tela no Linux (PipeWire).
//
// O loopback do Chromium só funciona no Windows (no Linux devolve silêncio).
// Aqui criamos uma fonte virtual ("microfone") no PipeWire e ligamos nela a
// saída de todos os apps que estão tocando som, MENOS o próprio Discord Local
// (senão os amigos ouviriam a própria voz de volta). O renderer captura essa
// fonte com getUserMedia e manda junto com a tela.
//
// Usa só as ferramentas que vêm com o PipeWire: pactl, pw-dump e pw-link.

const { execFile, execFileSync } = require('node:child_process');

// Um por processo: dois apps abertos (ou um teste) não mexem na fonte um do outro.
const NODE_PREFIX = 'discord_local_share';
const NODE_NAME = `${NODE_PREFIX}_${process.pid}`;
const DESCRIPTION = `Discord Local (áudio da transmissão ${process.pid})`;
const POLL_MS = 1000;

let moduleId = null;
let timer = null;
let syncing = false;
let ownPids = () => [process.pid];
let onlyApps = null; // null = todos os apps; senão, só as chaves escolhidas (ver appKey)

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 5000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd}: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Restos de execuções que fecharam sem limpar (crash, kill) — só de processos que já morreram. */
async function unloadStale() {
  const out = await run('pactl', ['list', 'short', 'modules']).catch(() => '');
  for (const line of out.split('\n')) {
    const [id, name, args = ''] = line.split('\t');
    if (name !== 'module-null-sink') continue;
    const m = new RegExp(`sink_name=${NODE_PREFIX}(?:_(\\d+))?(?:\\s|$)`).exec(args);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid || (pid && alive(pid))) continue;
    // Sem PID (v0.2.7): só remove se ninguém está gravando dela.
    if (!pid && (await inUse(`${NODE_PREFIX}`))) continue;
    await run('pactl', ['unload-module', id]).catch(() => {});
  }
}

async function inUse(sourceName) {
  const out = await run('pactl', ['list', 'source-outputs']).catch(() => '');
  return out.includes(`target.object = "${sourceName}"`);
}

/** Identifica o app pelo executável (os streams vêm e vão, o PID do navegador muda). */
function appKey(props) {
  return String(props['application.process.binary'] || props['application.name'] || props['node.name'] || '?');
}

async function playbackStreams(mine) {
  const objs = JSON.parse(await run('pw-dump', []));
  const props = (o) => o.info?.props ?? {};
  return {
    objs,
    streams: objs.filter(
      (o) =>
        o.type === 'PipeWire:Interface:Node' &&
        props(o)['media.class'] === 'Stream/Output/Audio' &&
        !mine.has(Number(props(o)['application.process.id'])),
    ),
  };
}

/** Apps tocando som agora (menos o próprio), para escolher o que vai na transmissão. */
async function listApps(getOwnPids) {
  if (process.platform !== 'linux') return [];
  const mine = new Set((getOwnPids ?? ownPids)().map(Number));
  const { streams } = await playbackStreams(mine);
  const apps = new Map();
  for (const n of streams) {
    const p = n.info?.props ?? {};
    const key = appKey(p);
    const name = String(p['application.name'] || key);
    const app = apps.get(key) ?? { key, name, detail: key !== name ? key : '' };
    apps.set(key, app);
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function channelTargets(channel, inputs) {
  const c = String(channel || '').toUpperCase();
  if (c.endsWith('L') && inputs.FL) return [inputs.FL];
  if (c.endsWith('R') && inputs.FR) return [inputs.FR];
  return Object.values(inputs); // MONO, FC, LFE… → nos dois lados
}

async function sync() {
  if (syncing || moduleId === null) return;
  syncing = true;
  try {
    const mine = new Set(ownPids().map(Number));
    const { objs, streams } = await playbackStreams(mine);
    const props = (o) => o.info?.props ?? {};
    const nodes = objs.filter((o) => o.type === 'PipeWire:Interface:Node');
    const ports = objs.filter((o) => o.type === 'PipeWire:Interface:Port');
    const links = objs.filter((o) => o.type === 'PipeWire:Interface:Link');

    const target = nodes.find((n) => props(n)['node.name'] === NODE_NAME);
    if (!target) return;
    const inputs = {};
    for (const p of ports) {
      const pp = props(p);
      if (Number(pp['node.id']) === target.id && p.info?.direction === 'input') inputs[pp['audio.channel'] || p.id] = p.id;
    }
    const inputIds = new Set(Object.values(inputs));
    if (!inputIds.size) return;

    const streamIds = new Set(
      streams.filter((n) => !onlyApps || onlyApps.has(appKey(props(n)))).map((n) => n.id),
    );

    const want = new Set();
    for (const p of ports) {
      const pp = props(p);
      if (p.info?.direction !== 'output' || pp['port.monitor'] === true || pp['port.monitor'] === 'true') continue;
      if (!streamIds.has(Number(pp['node.id']))) continue;
      for (const inId of channelTargets(pp['audio.channel'], inputs)) want.add(`${p.id}:${inId}`);
    }

    const have = new Set();
    for (const l of links) {
      const { output_port_id: out, input_port_id: inp } = l.info ?? {};
      if (!inputIds.has(inp)) continue;
      const key = `${out}:${inp}`;
      if (want.has(key)) have.add(key);
      else await run('pw-link', ['-d', String(out), String(inp)]).catch(() => {});
    }
    for (const key of want) {
      if (have.has(key)) continue;
      const [out, inp] = key.split(':');
      await run('pw-link', [out, inp]).catch(() => {}); // o stream pode ter sumido nesse meio-tempo
    }
  } catch (e) {
    console.warn('[linux-audio]', e.message);
  } finally {
    syncing = false;
  }
}

/** Cria a fonte virtual e começa a ligar os apps nela. Devolve o nome que aparece no getUserMedia. */
async function start(getOwnPids, only) {
  if (process.platform !== 'linux') throw new Error('Só no Linux');
  if (getOwnPids) ownPids = getOwnPids;
  await stop();
  onlyApps = Array.isArray(only) && only.length ? new Set(only.map(String)) : null;
  await unloadStale();
  try {
    await run('pw-dump', ['--version']);
    await run('pw-link', ['--version']);
  } catch {
    throw new Error('Precisa do PipeWire (pw-dump e pw-link) para transmitir o áudio do PC.');
  }
  const out = await run('pactl', [
    'load-module',
    'module-null-sink',
    `sink_name=${NODE_NAME}`,
    'channel_map=front-left,front-right',
    `sink_properties=media.class=Audio/Source/Virtual node.description="${DESCRIPTION}"`,
  ]);
  moduleId = out.trim();
  await sync();
  timer = setInterval(sync, POLL_MS);
  return DESCRIPTION;
}

async function stop() {
  clearInterval(timer);
  timer = null;
  if (moduleId === null) return;
  const id = moduleId;
  moduleId = null;
  await run('pactl', ['unload-module', id]).catch(() => {});
}

/** Na saída do app (não dá pra esperar promise). */
function stopSync() {
  clearInterval(timer);
  timer = null;
  if (moduleId === null) return;
  try {
    execFileSync('pactl', ['unload-module', moduleId], { timeout: 2000 });
  } catch {}
  moduleId = null;
}

module.exports = { start, stop, stopSync, listApps, DESCRIPTION };
