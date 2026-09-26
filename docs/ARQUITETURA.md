# Discord Local — Arquitetura v1

> Evolução do rascunho inicial de app de chat/grupos/chamadas: aqui transmissão de
> tela é requisito, o histórico é local-first e o servidor roda embutido no app do host.

---

## 1. Requisitos fechados

| Item | Decisão |
|---|---|
| Uso | Privado, poucos amigos, sem cadastro aberto |
| Funções MVP | Amigos, chat (DM + grupo), call de voz, transmissão de tela |
| Tamanho de call | 2 pessoas, no máximo 3 |
| Rede | VPN mesh (Tailscale recomendado; ZeroTier/Hamachi funcionam igual) |
| Clientes | **MVP: desktop Linux + Windows** (amigo usa Windows). Android nativo numa fase posterior |
| Servidor | Um processo rodando no PC do dono, escutando no IP da VPN |

### Fora do MVP
App Android (fase posterior, mas o protocolo já é pensado pra ele), vídeo de webcam, servidores/canais estilo Discord, bots, cargos, SFU, push via
Google (FCM), E2EE de mensagens, iOS.

---

## 2. Visão geral

```text
                 ┌──────────────── VPN (Tailscale 100.x.x.x) ────────────────┐
                 │                                                            │
   ┌─────────────┴─────────────┐                                              │
   │  SERVIDOR (PC do dono)    │                                              │
   │  Node 26 + TypeScript     │                                              │
   │  ├── REST  (auth, amigos, │                                              │
   │  │          histórico,    │                                              │
   │  │          upload)       │                                              │
   │  ├── WebSocket gateway    │  ← chat, presença, signaling de call         │
   │  ├── SQLite (node:sqlite) │                                              │
   │  └── ./data/uploads       │                                              │
   └───────┬──────────┬────────┘                                              │
           │          │  REST + WS (só controle, nunca mídia)                 │
     ┌─────┴───┐  ┌───┴─────┐                                                 │
     │ Desktop │  │ Android │                                                 │
     │Electron │  │ Kotlin  │                                                 │
     └────┬────┘  └────┬────┘                                                 │
          └── WebRTC P2P (áudio + tela) direto entre clientes ───────────────┘
```

**Princípio:** o servidor nunca toca em mídia. Ele guarda dados e repassa
mensagens de signaling. Áudio e vídeo vão direto de cliente pra cliente pela VPN.

Três camadas independentes (mantido do doc original):
`Mensagens` · `Presença` · `RTC`. Call não depende do chat e vice-versa.

---

## 3. Por que cada escolha

### Rede: VPN mesh em vez de servidor público
- Sem domínio, sem certificado, sem porta aberta no roteador.
- A VPN já criptografa tudo (WireGuard no Tailscale).
- **Elimina STUN/TURN**: todos os peers têm IP 100.x alcançável, então o WebRTC
  conecta por candidato `host` direto. `iceServers: []`.
- O app não conhece a VPN — só recebe uma URL tipo `http://100.89.140.30:47200`.
  Trocar Tailscale por ZeroTier = trocar a URL.

> Hamachi: funciona, mas é legado, cliente Linux ruim e limite de 5 no plano grátis.
> ZeroTier: alternativa boa. Tailscale: melhor NAT traversal e já está em uso aqui.

### Topologia de call: mesh P2P, sem SFU
Com N=3, cada um mantém 2 conexões. Custo de upload do screen share:
~4 Mbps × 2 peers = 8 Mbps — aceitável em fibra doméstica.
Se um dia passar de 4 pessoas, entra LiveKit (a camada RTC foi isolada pra isso).

### Servidor: Node + TypeScript + SQLite
- Node 26 já instalado; `node:sqlite` embutido → **zero dependência nativa**.
- SQLite é arquivo único: backup = copiar `data/app.db`. Postgres é exagero pra
  3 usuários.
- Libs: `fastify` (REST), `ws` (gateway), `zod` (validação do protocolo).

### Desktop: Electron (não Tauri)
Motivo decisivo é **screen share no Linux Wayland**:
- Tauri usa WebKitGTK no Linux, que não suporta `getDisplayMedia` de forma
  utilizável.
- Electron usa Chromium, que já fala com o `xdg-desktop-portal` + PipeWire
  (o seletor nativo de tela/janela do KDE/GNOME).
- WebRTC do Chromium é o mais maduro que existe.
- UI em React + Vite + TypeScript, reaproveitando os tipos do protocolo.
- Mesmo código gera os dois instaladores via `electron-builder`:
  Linux (AppImage) e Windows (instalador NSIS `.exe`). O build de Windows sai
  daqui do Linux (cross-build); sem assinatura de código → o Windows mostra o
  aviso do SmartScreen na primeira vez ("Executar assim mesmo").

### Android (fase posterior): Kotlin nativo + Jetpack Compose
- WebRTC: `io.getstream:stream-webrtc-android` (build mantido do libwebrtc).
- Voz: `AudioRecord` via WebRTC `JavaAudioDeviceModule` (AEC/NS nativos ligados).
- Screen share: `MediaProjection` + `ScreenCapturerAndroid`, com
  foreground service tipo `mediaProjection` (obrigatório no Android 14+).
- Sem FCM: notificação funciona enquanto o app está aberto ou com o foreground
  service "conectado" ativo (opcional, o usuário liga se quiser receber ligação
  com o app em segundo plano).

---

## 4. Estrutura do repositório

```text
DIscord Local/
├── docs/
│   ├── ARQUITETURA.md        ← este arquivo
│   └── PROTOCOLO.md          ← contrato WS/REST detalhado (gerado da seção 7)
├── server/                   ← Node/TS
│   ├── src/
│   │   ├── index.ts
│   │   ├── db/ (schema.sql, migrations)
│   │   ├── auth/  users/  friends/  conversations/  messages/  uploads/
│   │   ├── gateway/          ← WebSocket, sessões conectadas, presença
│   │   └── calls/            ← estado das calls em memória + relay de signaling
│   └── data/                 ← app.db + uploads (gitignored)
├── shared/
│   └── protocol/             ← tipos TS + schemas zod do protocolo
├── desktop/                  ← Electron + React
│   ├── electron/ (main.ts, preload.ts)
│   └── src/ (ui, rtc/, api/)
├── android/                  ← Kotlin + Compose (fase posterior)
└── linux-receiver/           ← projeto "telefone como microfone" (separado)
```

---

## 5. Modelo de dados (SQLite)

```sql
users            (id, username UNIQUE, display_name, password_hash,
                  avatar_path, created_at)
sessions         (id, user_id, token_hash, device_name, platform,
                  created_at, last_seen_at)
invites          (code PRIMARY KEY, created_by, used_by, created_at, used_at)

friendships      (user_low, user_high, requested_by, status, created_at, updated_at)
                  -- par ordenado (menor id, maior id) → uma linha por par
                  -- status: PENDING | ACCEPTED | BLOCKED

conversations    (id, type, name, owner_id, created_at)   -- type: DIRECT | GROUP
conversation_members (conversation_id, user_id, joined_at, last_read_message_id)

messages         (id, conversation_id, sender_id, kind, content,
                  reply_to_id, created_at, edited_at, deleted_at)
                  -- kind: TEXT | SYSTEM (ex: "call durou 12min")
attachments      (id, message_id, file_name, mime, size, path)
```

- IDs: **ULID** (ordenável por tempo → paginação de histórico por `id < cursor`).
- Senha: `scrypt` do `node:crypto` (sem dependência nativa).
- Token de sessão: 32 bytes aleatórios, guardado **só o hash** no banco. Sem JWT —
  pra 3 usuários, token opaco revogável é mais simples e mais seguro.
- **Cadastro só por convite**: o dono gera um código, o amigo usa uma vez.
- Calls **não vão pro banco** — são estado efêmero em memória. Ao terminar,
  grava uma mensagem `SYSTEM` na conversa.

---

## 5.1 Local-first (decidido em 2026-09-26)

O histórico **não mora no servidor**. Cada PC guarda o seu:

```text
<pasta de dados do app>/data/
├── profile.json            servidor, token, cache de amigos/conversas
├── outbox.json             mensagens escritas e ainda não confirmadas
└── conversas/<id>.jsonl    uma mensagem por linha (só append)
```

- Offline: lê todo o histórico e escreve (vai pra `outbox.json`).
- O servidor é **caixa de correio**: guarda a mensagem na tabela `mailbox` até
  cada destinatário gravar em disco e mandar `mailbox.ack`; aí apaga.
  Só `message_ids` (id + carimbo, sem conteúdo) fica, para reenvio idempotente.
- O id da mensagem é um ULID gerado no cliente → reenviar após queda não duplica.
- Consequência: conta nova / PC novo não recupera histórico do servidor
  (backup = copiar a pasta `data/`).
- Na implementação, amigos/grupos/convites também vão pelo WebSocket (com `ack`);
  o REST ficou só com `/health`, `/auth/register` e `/auth/login`.

## 5.2 Host embutido e instalador exportado (decidido em 2026-09-26)

Não existe servidor separado para o usuário final: **o servidor roda dentro do app
de quem escolhe "Ser o host"** (`server/src/server.ts` empacotado em
`desktop/electron/generated/server.cjs`, rodando no processo principal do Electron).

- **Host**: escolhe o IP da própria VPN (Tailscale/ZeroTier/Hamachi/Radmin detectados
  por interface), cria a conta (a primeira vira admin) e usa o botão
  **Iniciar sessão online** — com Tailscale, roda `tailscale up` antes de subir o servidor.
  Banco em `<userData>/servidor/app.db`.
- **Conectado**: só procura o host (reconexão automática) e entra.
- **Exportar instalador** (Configurações do host): pega o instalador limpo da
  plataforma (o próprio AppImage, ou um `.exe`/`.AppImage` baixado das Releases) e
  anexa no fim do arquivo uma linha `#DLOCAL1#<base64 {server_url, invite_code, host_name}>#END#`.
  - AppImage: o app lê o fim do próprio arquivo (`$APPIMAGE`).
  - Windows: `build/installer.nsh` copia a linha para `<pasta do app>/conexao.cfg`.
  - O convite embutido é de **uso múltiplo** (`invites.max_uses = NULL`), só o admin cria.
- A versão pública (GitHub) é o instalador limpo; o fluxo acima é igual para qualquer host.

## 6. Conexão e sessões

```text
1. POST /auth/login {username, password, device_name, platform} → {token, user}
2. WS  /gateway   → primeiro frame: {op:"hello", d:{token}}
3. servidor responde {op:"ready", d:{user, friends, conversations, presences,
                                      active_calls, connection_id}}
4. heartbeat: cliente manda {op:"ping"} a cada 20s; sem ping por 45s = desconecta
```

Um usuário pode estar conectado em vários aparelhos (desktop + celular).
Cada socket tem um `connection_id`. **Mensagens de chat vão pra todos os sockets
do usuário; a call é presa a um único `connection_id`** (o aparelho que atendeu).

Reconexão: o cliente guarda o último `message.id` visto por conversa e chama
`GET /conversations/:id/messages?after=<id>` ao reconectar.

---

## 7. Protocolo WebSocket

Envelope único, JSON:

```json
{ "op": "message.send", "d": { ... }, "rid": "opcional-id-de-requisição" }
```

`rid` é ecoado na resposta `{op:"ack", rid, ok, error?}` para comandos do cliente.

### Cliente → servidor
| op | d |
|---|---|
| `hello` | `{token}` |
| `ping` | `{}` |
| `message.send` | `{conversation_id, content, reply_to_id?, nonce}` |
| `message.edit` / `message.delete` | `{message_id, content?}` |
| `typing` | `{conversation_id}` |
| `read` | `{conversation_id, message_id}` |
| `presence.set` | `{status: ONLINE \| IDLE \| DND}` |
| `call.join` | `{conversation_id}` — inicia ou entra |
| `call.leave` | `{conversation_id}` |
| `call.decline` | `{conversation_id}` |
| `call.state` | `{conversation_id, muted, deafened, screen_sharing}` |
| `rtc.signal` | `{conversation_id, to_connection_id, signal}` |

### Servidor → cliente
| op | d |
|---|---|
| `ready` | estado inicial (ver seção 6) |
| `message.created` / `.updated` / `.deleted` | a mensagem |
| `typing` | `{conversation_id, user_id}` |
| `presence.update` | `{user_id, status}` |
| `friend.request` / `friend.accepted` / `friend.removed` | `{user}` |
| `conversation.created` / `.updated` | a conversa |
| `call.ringing` | `{conversation_id, from_user_id}` — toca pro resto |
| `call.updated` | `{conversation_id, participants:[{user_id, connection_id, muted, deafened, screen_sharing}]}` |
| `call.ended` | `{conversation_id, duration_s}` |
| `rtc.signal` | `{conversation_id, from_connection_id, signal}` |

`signal` é opaco pro servidor:
`{type:"offer"|"answer", sdp}` ou `{type:"candidate", candidate}`.
O servidor só valida que remetente e destinatário estão na mesma call.

REST cobre o que não é tempo real: `auth/*`, `invites`, `friends` (enviar/aceitar
pedido por username), `conversations` (criar grupo, membros), histórico paginado,
`POST /uploads` (limite 50 MB, arquivos em `data/uploads/`).

---

## 8. Fluxo de call (mesh)

```text
A: call.join(conv)
   servidor cria call {participants:[A]} → call.ringing pra B e C
B: call.join(conv)
   servidor → call.updated {A, B}
   Regra de quem oferta: quem ENTROU DEPOIS cria a offer pra cada um que já estava.
   B → rtc.signal(offer) → A
   A → rtc.signal(answer) → B
   ICE candidates trocados via rtc.signal → conecta (host candidate 100.x)
C: call.join(conv) → C oferta pra A e pra B
Qualquer um: call.leave → fecha os PeerConnections daquele peer
Último sai → call.ended + mensagem SYSTEM
```

- **Uma `RTCPeerConnection` por par**, carregando: 1 track de áudio (sempre) e
  1 track de vídeo de tela (quando alguém compartilha).
- Ligar/desligar a tela = adicionar/remover track → **renegociação** usando o
  padrão *perfect negotiation* (peer "polite" = `connection_id` menor), evitando
  colisão de offers.
- Mute = `track.enabled = false` (sem renegociar). Deafen = mudo local + zera o
  volume dos áudios remotos. Ambos anunciados via `call.state`.
- Timeout de toque: 45 s sem ninguém entrar → `call.ended`.

---

## 9. Transmissão de tela

| | Desktop (Electron) | Android |
|---|---|---|
| Captura | `getDisplayMedia` → portal PipeWire (Wayland) / seletor próprio (X11/Windows) via `setDisplayMediaRequestHandler` | `MediaProjection` + foreground service |
| Áudio do sistema | Windows: loopback nativo. Linux: fase posterior (capturar monitor do PipeWire como track extra) | Android 10+: `AudioPlaybackCapture` (fase posterior) |
| Assistir | `<video>` com tela cheia / janela destacada | `SurfaceViewRenderer` com zoom |

Parâmetros de envio:
- Codec: VP9 preferido (texto nítido), fallback VP8/H264.
- `contentHint = "detail"` (código/texto) ou `"motion"` (jogo), escolhível na UI.
- Presets: **720p30 ~2,5 Mbps**, **1080p30 ~4 Mbps**, **1080p60 ~6 Mbps** via
  `RTCRtpSender.setParameters({encodings:[{maxBitrate, maxFramerate}]})`.
- Voz: Opus, 48 kHz, `maxaveragebitrate` 64 kbps, DTX + FEC ligados.

Detalhe Electron: desativar a ofuscação de IP local por mDNS
(`--disable-features=WebRtcHideLocalIpsWithMdns`), senão o candidato host vira
`xxxx.local`, que não resolve pela VPN.

---

## 10. Segurança (proporcional a uso privado)

- Servidor escuta **só no IP da VPN** (não em `0.0.0.0`).
- Cadastro apenas com convite; rate limit no login.
- Toda operação valida se o usuário é membro da conversa.
- Limite de mensagem: 4000 caracteres. Upload: 50 MB, MIME checado.
- Tokens nunca em log.
- Sem TLS próprio: a VPN já criptografa o transporte. (Se um dia for público,
  entra HTTPS + TURN.)

---

## 11. Roadmap

| Fase | Entrega | Critério de pronto |
|---|---|---|
| **0** | Esqueleto: repo, server sobe, desktop abre em Linux e Windows | Instalador `.exe` roda no PC do amigo e `GET /health` responde via VPN |
| **1** | Convite, login, amigos, presença | 2 contas se adicionam e se veem online |
| **2** | Chat DM + grupo, histórico, anexos | Mensagem chega em tempo real nos 2 clientes |
| **3** | Call de voz 1:1 e em trio | Voz Linux↔Windows com mute/deafen |
| **4** | Screen share | Linux→Windows e Windows→Linux em 1080p30 |
| **5** | Polimento | Reconexão, não lidas, notificação, seleção de mic/saída, push-to-talk |
| **6** | Android | App Kotlin com chat, call e assistir/transmitir tela |
| **7** | Extras | Áudio do sistema no share, telefone como microfone (`linux-receiver`) virando dispositivo de entrada |

Cada fase é validada primeiro com duas instâncias no Linux e depois de verdade
Linux↔Windows com o PC do amigo pela VPN (o teste real de cada fase).

---

## 12. Divisão de trabalho (sugestão, mesmo modelo do projeto do microfone)

- **Claude:** `server/`, `shared/protocol`, `desktop/`.
- **Codex:** `android/` quando chegar a fase 6 (ou revisão/testes antes disso).
- Contrato = seções 5–9 deste doc. Mudança no protocolo passa pelos canais
  `CHAT DE AI/` antes de virar código.

---

## 13. Riscos conhecidos

| Risco | Mitigação |
|---|---|
| Android mata o app em segundo plano → não recebe ligação | Foreground service opcional; aceitar limitação no MVP |
| Upload do host insuficiente com 1080p60 pra 2 peers | Presets de qualidade; reduzir automaticamente se `packetsLost` subir |
| Wayland sem portal configurado | Checar `xdg-desktop-portal-kde`/`-gnome` instalado; mensagem de erro clara |
| Firewall do Windows bloqueia o WebRTC na interface da VPN | Instalador pede permissão de rede; doc de troubleshooting |
| Servidor desligado = ninguém conversa | Aceito (uso privado). Rodar como serviço `systemd --user` |
