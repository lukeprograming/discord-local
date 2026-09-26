// Armazenamento local-first: o histórico mora no PC de cada um.
//
// data/
// ├── profile.json          servidor, token, cache de amigos/conversas
// ├── outbox.json           mensagens escritas e ainda não confirmadas pelo servidor
// └── conversas/<id>.jsonl  uma mensagem por linha, só cresce (append)

const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

class LocalStore {
  constructor(dir) {
    this.dir = dir;
    this.convDir = path.join(dir, 'conversas');
    fs.mkdirSync(this.convDir, { recursive: true });
    this.knownIds = new Map(); // convId -> Set de ids já gravados (dedupe)
  }

  readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8'));
    } catch {
      return fallback;
    }
  }

  // Escreve num temporário e renomeia: se o PC desligar no meio, o arquivo antigo fica intacto.
  writeJson(file, data) {
    const target = path.join(this.dir, file);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, target);
  }

  loadProfile() {
    return this.readJson('profile.json', null);
  }

  saveProfile(p) {
    if (p === null) {
      fs.rmSync(path.join(this.dir, 'profile.json'), { force: true });
      return;
    }
    this.writeJson('profile.json', p);
  }

  loadOutbox() {
    return this.readJson('outbox.json', []);
  }

  saveOutbox(list) {
    this.writeJson('outbox.json', list);
  }

  convFile(convId) {
    if (!ID_RE.test(convId)) throw new Error(`id de conversa inválido: ${convId}`);
    return path.join(this.convDir, `${convId}.jsonl`);
  }

  loadMessages(convId) {
    let text = '';
    try {
      text = fs.readFileSync(this.convFile(convId), 'utf8');
    } catch {
      /* conversa ainda sem arquivo */
    }
    const messages = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        // Linha cortada (queda de energia no meio do append): ignora só ela.
      }
    }
    this.knownIds.set(convId, new Set(messages.map((m) => m.id)));
    messages.sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    return messages;
  }

  /** Acrescenta as mensagens que ainda não estão no arquivo. Retorna as que foram gravadas. */
  appendMessages(convId, msgs) {
    if (!this.knownIds.has(convId)) this.loadMessages(convId);
    const known = this.knownIds.get(convId);
    const fresh = msgs.filter((m) => m && ID_RE.test(m.id) && !known.has(m.id));
    if (!fresh.length) return [];
    const file = this.convFile(convId);
    // Garante que a nova linha não cole numa linha cortada anterior.
    let prefix = '';
    try {
      const { size } = fs.statSync(file);
      if (size > 0) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(1);
        fs.readSync(fd, buf, 0, 1, size - 1);
        fs.closeSync(fd);
        if (buf[0] !== 0x0a) prefix = '\n';
      }
    } catch {
      /* arquivo novo */
    }
    fs.appendFileSync(file, prefix + fresh.map((m) => JSON.stringify(m)).join('\n') + '\n');
    for (const m of fresh) known.add(m.id);
    return fresh;
  }
}

module.exports = { LocalStore };
