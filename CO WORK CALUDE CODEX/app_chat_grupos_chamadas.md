# App de Chat, Amigos, Grupos e Chamadas

## Arquitetura e plano de implementação

---

# 1. Objetivo

Construir um aplicativo de comunicação simples, inspirado apenas nas partes mais úteis de Discord/Telegram/Steam Friends:

- sistema de usuários;
- lista de amigos;
- pedidos de amizade;
- conversas privadas;
- grupos;
- chat em tempo real;
- presença online/offline;
- chamadas de voz individuais;
- chamadas de voz em grupo;
- mute;
- deafen;
- seleção de microfone;
- seleção de saída de áudio;
- push-to-talk opcional.

O objetivo não é recriar todo o Discord.

Não entram inicialmente:

- servidores complexos;
- canais múltiplos;
- bots;
- streaming;
- vídeo;
- screen share;
- threads;
- marketplace;
- sistema grande de cargos.

---

# 2. Arquitetura geral

```text
                    BACKEND
        ┌────────────────────────────┐
        │ Auth                       │
        │ Users                      │
        │ Friends                    │
        │ Groups                     │
        │ Conversations              │
        │ Messages                   │
        │ Presence                   │
        │ WebSocket Gateway          │
        │ Call Signaling             │
        └─────────────┬──────────────┘
                      │
              REST + WebSocket
                      │
         ┌────────────┴────────────┐
         │                         │
    Desktop Linux              Mobile
    Tauri + Web UI           Flutter/Kotlin
         │                         │
         └──────── WebRTC ─────────┘
```

---

# 3. Conceito central: Conversation

Evite implementar chat privado e grupo como dois sistemas totalmente diferentes.

Use uma entidade comum:

```text
Conversation
├── type: DIRECT
└── type: GROUP
```

Exemplo de conversa privada:

```json
{
  "id": "conv_001",
  "type": "DIRECT",
  "members": ["user_a", "user_b"]
}
```

Exemplo de grupo:

```json
{
  "id": "conv_002",
  "type": "GROUP",
  "name": "Amigos",
  "members": ["user_a", "user_b", "user_c"]
}
```

Isso simplifica:

- mensagens;
- histórico;
- anexos;
- notificações;
- chamadas;
- permissões básicas.

---

# 4. Módulos principais do backend

```text
backend/
├── auth/
├── users/
├── friends/
├── groups/
├── conversations/
├── messages/
├── presence/
├── websocket/
├── calls/
└── media/
```

---

# 5. Auth

Responsabilidades:

- cadastro;
- login;
- logout;
- refresh token;
- recuperação de sessão;
- autenticação de WebSocket.

Modelo inicial:

```text
email / username
password hash
access token
refresh token
```

Para um projeto pessoal, JWT funciona bem.

---

# 6. Users

Campos sugeridos:

```json
{
  "id": "user_123",
  "username": "Rover",
  "display_name": "Rover",
  "avatar_url": null,
  "status": "ONLINE",
  "created_at": "..."
}
```

---

# 7. Amigos

Fluxo:

```text
A envia pedido
↓
PENDING
↓
B aceita
↓
ACCEPTED
```

Estados possíveis:

```text
PENDING
ACCEPTED
BLOCKED
REMOVED
```

Tabela:

```text
friendships

id
requester_id
addressee_id
status
created_at
updated_at
```

---

# 8. Grupos

Modelo básico:

```json
{
  "id": "group_001",
  "name": "Devs",
  "owner_id": "user_1",
  "avatar_url": null
}
```

Membros:

```text
group_members

group_id
user_id
role
joined_at
```

Roles iniciais:

```text
OWNER
ADMIN
MEMBER
```

---

# 9. Mensagens

Modelo:

```json
{
  "id": "msg_001",
  "conversation_id": "conv_001",
  "sender_id": "user_123",
  "content": "Olá",
  "created_at": "...",
  "edited_at": null,
  "deleted_at": null
}
```

Posteriormente:

- reply;
- reação;
- imagem;
- arquivo;
- áudio;
- edição;
- remoção.

---

# 10. WebSocket

WebSocket será usado para eventos em tempo real.

Exemplos:

```text
message.created
message.edited
message.deleted

presence.online
presence.offline

friend.requested
friend.accepted

group.member_joined
group.member_left

call.incoming
call.accepted
call.ended
```

---

# 11. Fluxo de mensagem

```text
Usuário escreve mensagem
        ↓
WebSocket / API
        ↓
Backend valida permissão
        ↓
Salva PostgreSQL
        ↓
Publica evento
        ↓
Destinatários conectados recebem
```

Se o usuário estiver offline:

```text
Mensagem fica salva
↓
Usuário conecta depois
↓
Cliente sincroniza histórico
```

---

# 12. Presence

Estados sugeridos:

```text
ONLINE
IDLE
DO_NOT_DISTURB
OFFLINE
```

No início, pode ser simplificado para:

```text
ONLINE
OFFLINE
```

---

# 13. Chamadas de voz

Use WebRTC.

Não crie um protocolo próprio de voz para o sistema de chamadas.

WebRTC já resolve:

- negociação de mídia;
- codec;
- jitter;
- perda de pacotes;
- sincronização;
- NAT traversal;
- adaptação de rede.

---

# 14. Chamada individual

Para duas pessoas:

```text
Usuário A
   │
   │ WebRTC
   │
Usuário B
```

O backend apenas faz signaling.

Fluxo:

```text
A pressiona ligar
↓
call.incoming
↓
B recebe
↓
B aceita
↓
troca SDP/ICE
↓
WebRTC conecta
```

---

# 15. Signaling

O signaling pode usar o mesmo WebSocket do chat.

Eventos:

```text
call.offer
call.answer
call.ice_candidate
call.reject
call.hangup
```

---

# 16. STUN e TURN

Na mesma LAN, chamadas podem funcionar diretamente.

Na internet, será necessário lidar com:

- NAT;
- CGNAT;
- firewall;
- redes móveis;
- Wi-Fi corporativo.

Então use:

```text
STUN
+
TURN
```

TURN é importante para casos em que conexão peer-to-peer não é possível.

---

# 17. Chamadas em grupo

Para grupo, evite mesh completo.

Ruim:

```text
A conecta com B
A conecta com C
A conecta com D
B conecta com C
...
```

Isso escala mal.

Use uma SFU.

---

# 18. SFU

Arquitetura:

```text
           User A
             │
             │
User B ───── SFU ───── User C
             │
             │
           User D
```

Sugestão:

```text
LiveKit self-hosted
```

Alternativa mais low-level:

```text
mediasoup
```

Para projeto pessoal, LiveKit tende a reduzir muito a complexidade.

---

# 19. ActiveCall

Uma chamada pode estar associada diretamente a uma Conversation.

```json
{
  "id": "call_001",
  "conversation_id": "conv_002",
  "type": "VOICE",
  "status": "ACTIVE",
  "started_at": "..."
}
```

Participantes:

```text
call_participants

call_id
user_id
joined_at
left_at
muted
deafened
```

---

# 20. UI sugerida

```text
┌──────────────────────────────────────────────┐
│ Meu App                                      │
├────────────┬─────────────────────────────────┤
│ Amigos     │ João                     📞     │
│            │                                 │
│ ● João     │ João: vai jogar hoje?           │
│ ● Maria    │                                 │
│ ○ Pedro    │ Você: sim                       │
│            │                                 │
│ Grupos     │                                 │
│            │                                 │
│ Dev Team   │                                 │
│ Jogos      │                                 │
│ Amigos     │                                 │
│            ├─────────────────────────────────┤
│            │ Mensagem...                ➤    │
└────────────┴─────────────────────────────────┘
```

---

# 21. UI de chamada individual

```text
┌───────────────────────────────┐
│             João              │
│                               │
│        Chamada 00:14:32       │
│                               │
│      🎙️       🔊       ☎️     │
│      mute     deafen   sair   │
└───────────────────────────────┘
```

---

# 22. UI de chamada em grupo

```text
Dev Team

🔊 Chamada ativa

├── Você
├── João
├── Ana
└── Pedro

[ Entrar na chamada ]
```

---

# 23. Stack recomendada

## Desktop

```text
Tauri
+
React / Vue / Svelte
```

## Mobile

Opções:

```text
Flutter
```

ou:

```text
Kotlin Android
```

## Backend

Opções boas:

```text
Rust
Go
Node.js / TypeScript
```

## Banco

```text
PostgreSQL
```

## Realtime

```text
WebSocket
```

## Chamadas

```text
WebRTC
```

## Grupo/SFU

```text
LiveKit
```

---

# 24. Banco de dados sugerido

```text
users
sessions
friendships
groups
group_members
conversations
conversation_members
messages
calls
call_participants
```

---

# 25. Esquema simplificado

```text
users
-----
id
username
display_name
avatar_url
created_at

friendships
-----------
id
requester_id
addressee_id
status

conversations
-------------
id
type
name
created_at

conversation_members
--------------------
conversation_id
user_id
role

messages
--------
id
conversation_id
sender_id
content
created_at
edited_at

calls
-----
id
conversation_id
status
started_at
ended_at

call_participants
-----------------
call_id
user_id
joined_at
left_at
muted
deafened
```

---

# 26. Segurança

Implementar desde cedo:

- senha com Argon2 ou bcrypt;
- TLS;
- autenticação WebSocket;
- validação de permissão por conversa;
- rate limiting;
- tamanho máximo de mensagem;
- validação de uploads;
- bloqueio entre usuários;
- logs de erro sem expor tokens.

---

# 27. Arquivos e imagens

No início:

```text
filesystem
```

Depois:

```text
MinIO
```

ou algum serviço S3-compatible.

Nunca guardar binários grandes diretamente no PostgreSQL sem necessidade.

---

# 28. Roadmap

## Fase 1 — Base

- backend;
- PostgreSQL;
- cadastro/login;
- usuários.

## Fase 2 — Amigos

- adicionar;
- aceitar;
- remover;
- bloquear.

## Fase 3 — Conversas

- DM;
- grupos;
- membros.

## Fase 4 — Chat

- WebSocket;
- mensagens;
- histórico;
- presença.

## Fase 5 — Chamada individual

- WebRTC;
- signaling;
- mute;
- hangup;
- dispositivo de entrada/saída.

## Fase 6 — Grupo

- LiveKit/SFU;
- entrar/sair da chamada;
- participantes;
- mute.

## Fase 7 — Qualidade

- reconnect;
- unread count;
- notificações;
- upload;
- reply;
- edição.

---

# 29. MVP recomendado

O primeiro MVP deveria ter apenas:

```text
Login
Amigos
DM
Grupo
Mensagem em tempo real
Chamada 1:1
```

Depois:

```text
Chamada em grupo
```

Não implemente tudo de uma vez.

---

# 30. Integração futura com telefone como microfone

Posteriormente, o app desktop pode listar o telefone como dispositivo remoto:

```text
Microfone

○ Microfone USB
○ Webcam
● Galaxy — Wi-Fi
```

O fluxo seria:

```text
Telefone
↓
LAN
↓
Desktop
↓
entrada virtual / áudio interno
↓
WebRTC
↓
Chamada
```

Isso permite integrar o segundo projeto documentado separadamente.

---

# 31. Princípio arquitetural

O sistema deve ter três camadas independentes:

```text
Messaging
Presence
RTC
```

Chat não deve depender diretamente da implementação de chamadas.

Chamadas não devem depender do histórico de mensagens.

Isso permite substituir WebRTC/SFU no futuro sem reescrever todo o app.

---

# 32. Resultado final esperado

```text
APP
│
├── Amigos
│   ├── adicionar
│   ├── remover
│   ├── bloquear
│   └── presença
│
├── Conversas
│   ├── DM
│   ├── grupos
│   ├── mensagens
│   └── arquivos
│
└── Chamadas
    ├── 1:1
    ├── grupo
    ├── mute
    ├── deafen
    ├── push-to-talk
    ├── microfone
    └── saída de áudio
```

Esse escopo entrega a parte mais útil de um app tipo Discord sem carregar a complexidade de reproduzir todo o produto.
