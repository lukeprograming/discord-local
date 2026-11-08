// Retransmissor TURN (RFC 5766, só UDP) embutido no app do PC.
//
// Por quê: o WebRTC do Android não usa a VPN (ZeroTier/Tailscale/Hamachi) nas
// conexões diretas — o celular só fala pela rede de casa. O PC da mesma casa
// recebe o áudio/vídeo do celular pela rede local e repassa pela VPN.
//
// Escopo mínimo que o Chrome/WebView usa: Binding, Allocate (com autenticação
// long-term), Refresh, CreatePermission, ChannelBind, Send/Data e ChannelData.

const dgram = require('node:dgram');
const crypto = require('node:crypto');
const os = require('node:os');

const MAGIC = 0x2112a442;
const REALM = 'discord-local';
const DEFAULT_LIFETIME = 600;
const MAX_ALLOCATIONS = 64;

// tipos de mensagem
const BINDING = 0x0001;
const ALLOCATE = 0x0003;
const REFRESH = 0x0004;
const SEND = 0x0006; // método (a indicação chega como tipo 0x0016)
const DATA_INDICATION = 0x0017;
const CREATE_PERMISSION = 0x0008;
const CHANNEL_BIND = 0x0009;
// atributos
const A = {
  USERNAME: 0x0006,
  MESSAGE_INTEGRITY: 0x0008,
  ERROR_CODE: 0x0009,
  CHANNEL_NUMBER: 0x000c,
  LIFETIME: 0x000d,
  XOR_PEER_ADDRESS: 0x0012,
  DATA: 0x0013,
  REALM: 0x0014,
  NONCE: 0x0015,
  XOR_RELAYED_ADDRESS: 0x0016,
  REQUESTED_TRANSPORT: 0x0019,
  XOR_MAPPED_ADDRESS: 0x0020,
  SOFTWARE: 0x8022,
  FINGERPRINT: 0x8028,
};

// ---- STUN: ler e montar ----

function parse(buf) {
  if (buf.length < 20 || (buf[0] & 0xc0) !== 0 || buf.readUInt32BE(4) !== MAGIC) return null;
  const type = buf.readUInt16BE(0);
  const len = buf.readUInt16BE(2);
  if (20 + len > buf.length) return null;
  const tid = buf.subarray(8, 20);
  const attrs = new Map();
  let miOffset = -1;
  let off = 20;
  while (off + 4 <= 20 + len) {
    const t = buf.readUInt16BE(off);
    const l = buf.readUInt16BE(off + 2);
    if (off + 4 + l > buf.length) break;
    if (t === A.MESSAGE_INTEGRITY) miOffset = off;
    if (!attrs.has(t)) attrs.set(t, buf.subarray(off + 4, off + 4 + l));
    off += 4 + l + ((4 - (l % 4)) % 4);
  }
  return { type, tid, attrs, miOffset, raw: buf };
}

function xorAddr(value, tid) {
  const family = value[1];
  const port = value.readUInt16BE(2) ^ (MAGIC >>> 16);
  if (family !== 0x01) return null; // só IPv4
  const ip = [0, 1, 2, 3].map((i) => value[4 + i] ^ ((MAGIC >>> (24 - 8 * i)) & 0xff)).join('.');
  return { ip, port };
}

function encXorAddr(ip, port) {
  const b = Buffer.alloc(8);
  b[1] = 0x01;
  b.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  ip.split('.').forEach((n, i) => (b[4 + i] = Number(n) ^ ((MAGIC >>> (24 - 8 * i)) & 0xff)));
  return b;
}

function attr(type, value) {
  const pad = (4 - (value.length % 4)) % 4;
  const b = Buffer.alloc(4 + value.length + pad);
  b.writeUInt16BE(type, 0);
  b.writeUInt16BE(value.length, 2);
  value.copy(b, 4);
  return b;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Monta a mensagem; com `key` põe MESSAGE-INTEGRITY; sempre põe FINGERPRINT. */
function build(type, tid, attrs, key) {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(type, 0);
  header.writeUInt32BE(MAGIC, 4);
  tid.copy(header, 8);
  let body = Buffer.concat([...attrs, attr(A.SOFTWARE, Buffer.from('discord-local'))]);
  if (key) {
    header.writeUInt16BE(body.length + 24, 2);
    const hmac = crypto.createHmac('sha1', key).update(Buffer.concat([header, body])).digest();
    body = Buffer.concat([body, attr(A.MESSAGE_INTEGRITY, hmac)]);
  }
  header.writeUInt16BE(body.length + 8, 2);
  const fp = (crc32(Buffer.concat([header, body])) ^ 0x5354554e) >>> 0;
  const fpv = Buffer.alloc(4);
  fpv.writeUInt32BE(fp, 0);
  return Buffer.concat([header, body, attr(A.FINGERPRINT, fpv)]);
}

function errorAttr(code, reason) {
  const r = Buffer.from(reason);
  const b = Buffer.alloc(4 + r.length);
  b[2] = Math.floor(code / 100);
  b[3] = code % 100;
  r.copy(b, 4);
  return attr(A.ERROR_CODE, b);
}

// ---- qual IP anunciar como endereço de retransmissão ----

/** IPs IPv4 do PC, VPNs primeiro (é por elas que os PCs das outras casas chegam). */
function localIps() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/^(docker|br-|veth|virbr|vmnet|vboxnet)/i.test(name)) continue;
      const vpn = /zerotier|^zt|tailscale|hamachi|^ham\d|wireguard|^wg\d|radmin/i.test(name);
      out.push({ name, ip: a.address, vpn });
    }
  }
  return out.sort((x, y) => Number(y.vpn) - Number(x.vpn));
}

// ---- servidor ----

class TurnServer {
  constructor() {
    this.username = 'dl-' + crypto.randomBytes(6).toString('hex');
    this.password = crypto.randomBytes(18).toString('base64url');
    this.key = crypto.createHash('md5').update(`${this.username}:${REALM}:${this.password}`).digest();
    this.nonce = crypto.randomBytes(12).toString('hex');
    this.allocations = new Map(); // "ip:port" do cliente -> alocação
    this.socket = null;
    this.port = 0;
    this.relayIp = null; // definido pelo app (IP da VPN usada para falar com o host)
  }

  start(port = 3478) {
    return new Promise((resolve) => {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      sock.on('message', (msg, rinfo) => {
        try {
          this.onMessage(msg, rinfo);
        } catch (e) {
          console.warn('[turn]', e.message);
        }
      });
      sock.once('error', (e) => {
        // Porta ocupada (outra cópia do app): pega qualquer uma livre.
        if (port !== 0) {
          sock.close();
          this.start(0).then(resolve);
        } else {
          console.warn('[turn] não iniciou:', e.message);
          resolve(null);
        }
      });
      sock.bind(port, '0.0.0.0', () => {
        this.socket = sock;
        this.port = sock.address().port;
        resolve(this.info());
      });
    });
  }

  /** O que os outros precisam pra usar este retransmissor. */
  info() {
    if (!this.socket) return null;
    const ips = localIps().map((x) => x.ip);
    return {
      urls: ips.map((ip) => `turn:${ip}:${this.port}?transport=udp`),
      username: this.username,
      credential: this.password,
      relayIp: this.pickRelayIp(),
    };
  }

  /** Endereço anunciado aos outros PCs: o da VPN (ou o pedido pelo app), senão o da rede local. */
  pickRelayIp() {
    const ips = localIps();
    if (this.relayIp && ips.some((x) => x.ip === this.relayIp)) return this.relayIp;
    return ips[0]?.ip ?? '127.0.0.1';
  }

  stop() {
    for (const a of this.allocations.values()) this.freeAllocation(a);
    this.allocations.clear();
    this.socket?.close();
    this.socket = null;
  }

  reply(rinfo, buf) {
    this.socket?.send(buf, rinfo.port, rinfo.address);
  }

  /** Confere USERNAME + MESSAGE-INTEGRITY; senão responde 401 com REALM/NONCE. */
  authOk(m, rinfo, errType) {
    const user = m.attrs.get(A.USERNAME)?.toString();
    if (!user || m.miOffset < 0 || user !== this.username) {
      this.reply(
        rinfo,
        build(errType, m.tid, [errorAttr(401, 'Unauthorized'), attr(A.REALM, Buffer.from(REALM)), attr(A.NONCE, Buffer.from(this.nonce))]),
      );
      return false;
    }
    const head = Buffer.from(m.raw.subarray(0, m.miOffset));
    head.writeUInt16BE(m.miOffset - 20 + 24, 2);
    const expected = crypto.createHmac('sha1', this.key).update(head).digest();
    const got = m.raw.subarray(m.miOffset + 4, m.miOffset + 24);
    if (got.length !== 20 || !crypto.timingSafeEqual(expected, got)) {
      this.reply(rinfo, build(errType, m.tid, [errorAttr(401, 'Unauthorized'), attr(A.REALM, Buffer.from(REALM)), attr(A.NONCE, Buffer.from(this.nonce))]));
      return false;
    }
    return true;
  }

  onMessage(msg, rinfo) {
    const key = `${rinfo.address}:${rinfo.port}`;
    // ChannelData (cliente -> peer): 0x4000..0x7FFF
    if (msg.length >= 4 && msg[0] >= 0x40 && msg[0] <= 0x7f) {
      const alloc = this.allocations.get(key);
      const ch = msg.readUInt16BE(0);
      const len = msg.readUInt16BE(2);
      const peer = alloc?.channels.get(ch);
      if (peer && alloc.permissions.has(peer.ip)) alloc.relay.send(msg.subarray(4, 4 + len), peer.port, peer.ip);
      return;
    }
    const m = parse(msg);
    if (!m) return;
    const method = m.type & 0x3eef;
    const isRequest = (m.type & 0x0110) === 0x0000;
    const isIndication = (m.type & 0x0110) === 0x0010;

    if (method === BINDING && isRequest) {
      this.reply(rinfo, build(0x0101, m.tid, [attr(A.XOR_MAPPED_ADDRESS, encXorAddr(rinfo.address, rinfo.port))]));
      return;
    }

    if (method === SEND && isIndication) {
      const alloc = this.allocations.get(key);
      const peerAttr = m.attrs.get(A.XOR_PEER_ADDRESS);
      const data = m.attrs.get(A.DATA);
      const peer = peerAttr && xorAddr(peerAttr, m.tid);
      if (alloc && peer && data && alloc.permissions.has(peer.ip)) alloc.relay.send(data, peer.port, peer.ip);
      return;
    }

    if (!isRequest) return;

    if (method === ALLOCATE) {
      if (!this.authOk(m, rinfo, 0x0113)) return;
      let alloc = this.allocations.get(key);
      if (!alloc) {
        if (this.allocations.size >= MAX_ALLOCATIONS) {
          this.reply(rinfo, build(0x0113, m.tid, [errorAttr(486, 'Allocation Quota Reached')], this.key));
          return;
        }
        const transport = m.attrs.get(A.REQUESTED_TRANSPORT);
        if (!transport || transport[0] !== 17) {
          this.reply(rinfo, build(0x0113, m.tid, [errorAttr(442, 'Unsupported Transport Protocol')], this.key));
          return;
        }
        alloc = this.createAllocation(key, rinfo);
        // A porta de retransmissão sai no bind (assíncrono): responde quando estiver pronta.
        alloc.ready.then(() => this.allocateOk(m, rinfo, alloc));
        return;
      }
      this.allocateOk(m, rinfo, alloc);
      return;
    }

    const alloc = this.allocations.get(key);
    const errType = 0x0110 | method;
    if (!alloc) {
      this.reply(rinfo, build(errType, m.tid, [errorAttr(437, 'Allocation Mismatch')]));
      return;
    }
    if (!this.authOk(m, rinfo, errType)) return;

    if (method === REFRESH) {
      const lt = m.attrs.get(A.LIFETIME);
      const lifetime = lt ? Math.min(lt.readUInt32BE(0), 3600) : DEFAULT_LIFETIME;
      if (lifetime === 0) {
        this.freeAllocation(alloc);
        this.allocations.delete(key);
      } else this.touch(alloc, lifetime);
      const v = Buffer.alloc(4);
      v.writeUInt32BE(lifetime, 0);
      this.reply(rinfo, build(0x0104, m.tid, [attr(A.LIFETIME, v)], this.key));
      return;
    }

    if (method === CREATE_PERMISSION) {
      const peerAttr = m.attrs.get(A.XOR_PEER_ADDRESS);
      const peer = peerAttr && xorAddr(peerAttr, m.tid);
      if (!peer) {
        this.reply(rinfo, build(0x0118, m.tid, [errorAttr(400, 'Bad Request')], this.key));
        return;
      }
      alloc.permissions.add(peer.ip);
      this.reply(rinfo, build(0x0108, m.tid, [], this.key));
      return;
    }

    if (method === CHANNEL_BIND) {
      const chAttr = m.attrs.get(A.CHANNEL_NUMBER);
      const peerAttr = m.attrs.get(A.XOR_PEER_ADDRESS);
      const peer = peerAttr && xorAddr(peerAttr, m.tid);
      const ch = chAttr ? chAttr.readUInt16BE(0) : 0;
      if (!peer || ch < 0x4000 || ch > 0x7ffe) {
        this.reply(rinfo, build(0x0119, m.tid, [errorAttr(400, 'Bad Request')], this.key));
        return;
      }
      alloc.channels.set(ch, peer);
      alloc.peerChannel.set(`${peer.ip}:${peer.port}`, ch);
      alloc.permissions.add(peer.ip);
      this.reply(rinfo, build(0x0109, m.tid, [], this.key));
    }
  }

  allocateOk(m, rinfo, alloc) {
    const lt = Buffer.alloc(4);
    lt.writeUInt32BE(DEFAULT_LIFETIME, 0);
    this.reply(
      rinfo,
      build(
        0x0103,
        m.tid,
        [
          attr(A.XOR_RELAYED_ADDRESS, encXorAddr(this.pickRelayIp(), alloc.relayPort)),
          attr(A.XOR_MAPPED_ADDRESS, encXorAddr(rinfo.address, rinfo.port)),
          attr(A.LIFETIME, lt),
        ],
        this.key,
      ),
    );
  }

  createAllocation(key, rinfo) {
    const relay = dgram.createSocket('udp4');
    const alloc = {
      client: { ip: rinfo.address, port: rinfo.port },
      relay,
      relayPort: 0,
      permissions: new Set(),
      channels: new Map(), // canal -> peer
      peerChannel: new Map(), // "ip:porta" -> canal
      timer: null,
      ready: null,
    };
    alloc.ready = new Promise((resolve) => relay.bind(0, '0.0.0.0', () => {
      alloc.relayPort = relay.address().port;
      resolve();
    }));
    // peer -> cliente
    relay.on('message', (data, from) => {
      if (!alloc.permissions.has(from.address)) return;
      const ch = alloc.peerChannel.get(`${from.address}:${from.port}`);
      if (ch !== undefined) {
        const head = Buffer.alloc(4);
        head.writeUInt16BE(ch, 0);
        head.writeUInt16BE(data.length, 2);
        this.socket?.send(Buffer.concat([head, data]), alloc.client.port, alloc.client.ip);
      } else {
        const ind = build(DATA_INDICATION, crypto.randomBytes(12), [attr(A.XOR_PEER_ADDRESS, encXorAddr(from.address, from.port)), attr(A.DATA, data)]);
        this.socket?.send(ind, alloc.client.port, alloc.client.ip);
      }
    });
    relay.on('error', () => {});
    this.allocations.set(key, alloc);
    this.touch(alloc, DEFAULT_LIFETIME);
    return alloc;
  }

  touch(alloc, lifetime) {
    clearTimeout(alloc.timer);
    alloc.timer = setTimeout(() => {
      this.freeAllocation(alloc);
      this.allocations.delete(`${alloc.client.ip}:${alloc.client.port}`);
    }, lifetime * 1000);
  }

  freeAllocation(alloc) {
    clearTimeout(alloc.timer);
    try {
      alloc.relay.close();
    } catch {
      /* já fechado */
    }
  }
}

/**
 * IP local usado para chegar no host (o mesmo caminho que os outros PCs usam pra me alcançar).
 * Sendo eu o host (ou sem rota), prefere a VPN: ZeroTier > Tailscale > Hamachi > outras > rede de casa.
 */
function routeIp(hostIp) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const done = (ip) => {
      try {
        s.close();
      } catch {
        /* já fechado */
      }
      resolve(ip);
    };
    s.on('error', () => done(null));
    try {
      s.connect(47200, hostIp, () => {
        const ip = s.address().address;
        const mine = localIps().some((x) => x.ip === hostIp);
        done(!mine && ip && !ip.startsWith('127.') ? ip : null);
      });
    } catch {
      done(null);
    }
  });
}

function preferredVpnIp() {
  const rank = (n) => (/zerotier|^zt/i.test(n) ? 0 : /tailscale/i.test(n) ? 1 : /hamachi|^ham\d/i.test(n) ? 2 : 3);
  const vpn = localIps().filter((x) => x.vpn).sort((a, b) => rank(a.name) - rank(b.name));
  return vpn[0]?.ip ?? null;
}

module.exports = { TurnServer, localIps, routeIp, preferredVpnIp };
