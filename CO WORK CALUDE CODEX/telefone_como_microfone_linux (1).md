# Telefone como Microfone no Linux

## Arquitetura e plano de implementação

---

# 1. Objetivo

Criar um sistema onde um telefone funcione como microfone remoto de um computador Linux.

Fluxo:

```text
Telefone
   ↓
captura microfone
   ↓
rede local
   ↓
cliente/daemon Linux
   ↓
PipeWire
   ↓
microfone virtual
   ↓
Discord / OBS / navegador / jogo / app próprio
```

O usuário deve conseguir selecionar no Linux algo como:

```text
Phone Microphone
```

da mesma forma que selecionaria um microfone USB.

---

# 2. Componentes

O projeto possui dois componentes principais.

```text
Phone App
+
Linux Receiver
```

---

# 3. Phone App

Responsabilidades:

- capturar áudio do microfone;
- converter para formato apropriado;
- codificar;
- transmitir pela rede;
- controlar mute;
- controlar ganho;
- mostrar conexão;
- opcionalmente permitir push-to-talk.

No Android, pode usar:

```text
AudioRecord
```

---

# 4. Linux Receiver

Responsabilidades:

- descobrir/aceitar telefone;
- receber pacotes de áudio;
- ordenar pacotes;
- jitter buffer;
- decodificar áudio;
- alimentar PipeWire;
- expor source virtual.

---

# 5. Arquitetura

```text
ANDROID
┌───────────────────────┐
│ Microphone            │
│ AudioRecord           │
│ Noise processing      │
│ Opus Encoder          │
│ Network Transport     │
└───────────┬───────────┘
            │
            │ Wi-Fi / LAN
            │
┌───────────▼───────────┐
│ Linux Receiver        │
│ Packet Receiver       │
│ Jitter Buffer         │
│ Opus Decoder          │
│ PCM Output            │
└───────────┬───────────┘
            │
         PipeWire
            │
┌───────────▼───────────┐
│ Phone Microphone      │
│ Virtual Source        │
└───────────────────────┘
```

---

# 6. Codec

Para voz, use:

```text
Opus
```

Configuração inicial sugerida:

```text
Sample rate: 48 kHz
Channels: mono
Frame: 20 ms
Bitrate: 24–64 kbps
```

Opus possui boa qualidade para fala e baixa latência.

---

# 7. Por que não PCM puro

É possível transmitir PCM diretamente.

Exemplo:

```text
48 kHz
16 bit
mono
```

Mas isso:

- usa mais banda;
- sofre mais com Wi-Fi instável;
- não possui vantagens de codec de voz;
- aumenta tráfego desnecessário.

PCM cru pode ser útil para um protótipo inicial, mas Opus é melhor para uso real.

---

# 8. Transporte

Para LAN, opções:

```text
UDP + protocolo próprio
```

ou:

```text
WebRTC
```

---

# 9. UDP + Opus

Vantagens:

- simples;
- baixa latência;
- controle total;
- fácil de debugar;
- ótimo para LAN.

Desvantagens:

- você precisa implementar jitter buffer;
- sequência de pacotes;
- reconexão;
- detecção de perda.

Para projeto pessoal, é uma excelente primeira opção.

---

# 10. WebRTC

Vantagens:

- jitter handling;
- codecs;
- ICE;
- NAT traversal;
- adaptação de rede;
- RTP/RTCP.

Desvantagens:

- mais complexo;
- mais dependências;
- talvez seja exagero para um microfone apenas em LAN.

---

# 11. Protocolo UDP sugerido

Header:

```text
magic
version
stream_id
sequence
timestamp
flags
payload_length
payload
```

Exemplo conceitual:

```text
PHONE_MIC_PACKET

version: 1
stream: 42
sequence: 10291
timestamp: 9842120
flags: 0
codec: OPUS
payload: [...]
```

---

# 12. Sequence number

Todo pacote deve possuir sequence.

Exemplo:

```text
100
101
102
104
```

O receiver percebe:

```text
103 perdido
```

E pode:

- ignorar;
- usar packet loss concealment do Opus;
- ajustar jitter buffer.

---

# 13. Timestamp

Timestamp é importante para:

- ordenação;
- sincronização;
- cálculo de atraso;
- jitter.

Não dependa apenas da ordem de chegada.

---

# 14. Jitter Buffer

Wi-Fi não entrega pacotes perfeitamente espaçados.

Exemplo:

```text
20 ms
18 ms
32 ms
10 ms
25 ms
```

O jitter buffer mantém alguns frames antes de tocar.

Exemplo:

```text
buffer: 40–100 ms
```

Menor:

```text
menor latência
mais risco de glitches
```

Maior:

```text
mais estabilidade
mais atraso
```

---

# 15. PipeWire

No Arch Linux moderno, PipeWire é a integração natural.

Objetivo:

```text
decoder
↓
PCM
↓
PipeWire node
↓
virtual source
```

Aplicativos enxergam:

```text
Phone Microphone
```

---

# 16. Conceito de source virtual

O daemon cria ou alimenta um node de áudio.

Fluxo:

```text
Network Receiver
↓
Decoded PCM
↓
PipeWire Stream
↓
Virtual Microphone Source
```

---

# 17. Integração com aplicações

Depois de criado o dispositivo, ele deve aparecer em:

- Discord;
- OBS;
- Firefox;
- Chromium;
- jogos;
- Zoom;
- aplicativo de chamadas próprio.

---

# 18. Pairing

Evite pedir IP manual toda vez.

Use pairing.

Fluxo:

```text
Linux abre receiver
↓
gera QR Code
↓
telefone escaneia
↓
conecta automaticamente
```

QR pode conter:

```text
host
port
pairing_token
protocol_version
```

Exemplo conceitual:

```text
phonemic://192.168.1.50:38765?token=abc123
```

---

# 19. Descoberta local

Outra opção:

```text
mDNS
```

Linux anuncia:

```text
_phone-mic._udp.local
```

O telefone descobre automaticamente o PC.

---

# 20. Segurança

Mesmo em LAN, implemente autenticação.

Use:

```text
pairing token
```

Não aceite qualquer telefone da rede sem validação.

Possível evolução:

```text
Noise handshake
TLS/DTLS
chave persistente
```

---

# 21. Reconexão

O telefone deve detectar:

```text
Wi-Fi caiu
receiver reiniciou
PC dormiu
```

Estados:

```text
DISCONNECTED
CONNECTING
CONNECTED
RECONNECTING
```

---

# 22. Keepalive

Envie heartbeat.

Exemplo:

```text
PING
PONG
```

Se não houver resposta em alguns segundos:

```text
connection lost
```

---

# 23. Mute

Mute pode acontecer de duas formas.

No telefone:

```text
para de transmitir frames
```

ou envia:

```text
SILENCE flag
```

O Linux também pode ter mute próprio.

---

# 24. Push-to-talk

O telefone pode ter botão:

```text
[ Segure para falar ]
```

Enquanto pressionado:

```text
stream enabled
```

Ao soltar:

```text
stream muted
```

---

# 25. Controle de ganho

Configurações possíveis:

```text
Input Gain
Noise Suppression
Automatic Gain Control
Echo Cancellation
```

Nem todas precisam estar no MVP.

---

# 26. Noise suppression

Pode ser feito:

```text
no telefone
```

ou:

```text
no Linux
```

Evite processar duas vezes inicialmente.

Escolha um único local.

---

# 27. Arquitetura de módulos Android

```text
android/
├── audio/
│   ├── capture/
│   ├── encoder/
│   └── processing/
│
├── network/
│   ├── discovery/
│   ├── pairing/
│   └── transport/
│
├── session/
└── ui/
```

---

# 28. Arquitetura Linux

```text
linux/
├── daemon/
├── network/
│   ├── receiver/
│   └── protocol/
├── audio/
│   ├── opus/
│   ├── jitter/
│   └── pipewire/
├── pairing/
└── cli/
```

---

# 29. Linguagens sugeridas

## Android

```text
Kotlin
```

## Linux daemon

Boa opção:

```text
Rust
```

Porque combina bem com:

- rede;
- baixa latência;
- threads;
- áudio;
- segurança de memória.

Alternativas:

```text
C++
Go
```

Python é ótimo para protótipo, mas eu evitaria como implementação final de áudio de baixa latência.

---

# 30. Bibliotecas possíveis

Conceitualmente:

```text
libopus
PipeWire API
QR library
mDNS library
```

A escolha exata pode ser feita durante implementação.

---

# 31. Estados da sessão

```text
Idle
↓
Discovering
↓
Pairing
↓
Connected
↓
Streaming
↓
Disconnected
```

---

# 32. Modelo de sessão

```json
{
  "device_id": "phone_001",
  "device_name": "Galaxy",
  "sample_rate": 48000,
  "channels": 1,
  "codec": "opus",
  "frame_ms": 20,
  "status": "STREAMING"
}
```

---

# 33. Métricas úteis

Mostrar no app Linux:

```text
Latency
Packet Loss
Jitter
Bitrate
Buffer
Signal Level
```

Exemplo:

```text
Galaxy Sxx

Connected
Latency: 58 ms
Loss: 0.2%
Jitter: 7 ms
Opus: 32 kbps
```

---

# 34. Controle adaptativo

Posteriormente, o sistema pode ajustar automaticamente:

```text
bitrate
jitter buffer
FEC
```

dependendo da rede.

---

# 35. FEC

Opus pode ajudar com perda de pacotes.

Em redes instáveis, habilitar mecanismos de recuperação pode melhorar voz.

Isso deve ser uma otimização posterior.

---

# 36. Uso via USB

Futuramente, além de Wi-Fi:

```text
USB
```

O telefone poderia usar:

```text
ADB tunnel
```

ou outro transporte.

Isso oferece:

- latência menor;
- maior estabilidade;
- nenhuma interferência de Wi-Fi.

---

# 37. Wi-Fi vs USB

## Wi-Fi

Vantagens:

- sem cabo;
- fácil;
- mobilidade.

Desvantagens:

- jitter;
- interferência;
- perda.

## USB

Vantagens:

- estabilidade;
- baixa latência.

Desvantagens:

- cabo;
- integração mais trabalhosa.

---

# 38. Múltiplos telefones

Arquitetura pode suportar:

```text
Phone A
Phone B
Tablet
```

Cada um vira uma source:

```text
Phone Microphone — Galaxy
Phone Microphone — Pixel
Phone Microphone — Tablet
```

---

# 39. Perfis

Possível:

```text
Voice
Studio
Low Latency
Battery Saver
```

Exemplo:

```text
Voice
Opus 32 kbps
20 ms

Low Latency
Opus 64 kbps
10 ms
```

---

# 40. Bateria

Captura constante + Wi-Fi usa bateria.

O app deve:

- manter wake lock somente durante stream;
- parar encoder quando muted por muito tempo;
- encerrar sessão quando usuário sair;
- evitar processamento excessivo.

---

# 41. UI do telefone

```text
┌──────────────────────────┐
│ Phone Microphone         │
│                          │
│ PC: Arch Desktop         │
│ ● Connected              │
│                          │
│ ████████░░ Input         │
│                          │
│ [ Mute ]                 │
│                          │
│ Latency: 52 ms           │
└──────────────────────────┘
```

---

# 42. UI Linux

```text
┌────────────────────────────────┐
│ Phone Mic Receiver             │
├────────────────────────────────┤
│ Galaxy Sxx          ● Connected│
│                                │
│ Latency     52 ms              │
│ Packet Loss 0.1%               │
│                                │
│ Device: Phone Microphone       │
│                                │
│ [Disconnect]                   │
└────────────────────────────────┘
```

---

# 43. Daemon + UI

Separe:

```text
phonemic-daemon
```

de:

```text
phonemic-ui
```

O daemon continua rodando mesmo com a interface fechada.

---

# 44. CLI

Comandos possíveis:

```bash
phonemic status
phonemic devices
phonemic pair
phonemic disconnect
```

---

# 45. systemd user service

No Linux:

```text
~/.config/systemd/user/phonemic.service
```

O receiver pode iniciar automaticamente na sessão do usuário.

---

# 46. Logs

Não logar áudio.

Logar apenas:

```text
connect
disconnect
packet loss
errors
device id
session info
```

---

# 47. MVP

Primeira versão:

```text
Android:
- AudioRecord
- PCM ou Opus
- IP manual
- UDP

Linux:
- receiver
- decoder
- PipeWire output
```

Sem:

```text
QR
mDNS
GUI
FEC
USB
```

---

# 48. MVP 2

Adicionar:

```text
Opus
jitter buffer
mute
reconnect
```

---

# 49. MVP 3

Adicionar:

```text
QR pairing
mDNS
GUI Linux
status de latência
```

---

# 50. MVP 4

Adicionar:

```text
USB
noise suppression
profiles
multiple devices
```

---

# 51. Roadmap recomendado

## Fase 1 — Prova de conceito

Telefone captura áudio.

Linux recebe e toca em speaker/headphones.

## Fase 2 — PipeWire

Transformar stream em microfone virtual.

## Fase 3 — Codec

Adicionar Opus.

## Fase 4 — Estabilidade

Jitter buffer, reconnect, packet loss.

## Fase 5 — UX

Pairing, QR, descoberta automática.

## Fase 6 — Qualidade

Noise suppression, gain, profiles.

---

# 52. Critério de sucesso

O projeto estará funcional quando:

```text
1. abrir app no telefone;
2. conectar ao PC;
3. abrir configurações de áudio do Linux;
4. selecionar "Phone Microphone";
5. falar no telefone;
6. aplicativo Linux receber áudio como input normal.
```

---

# 53. Integração com o app de chat

O mesmo telefone pode futuramente funcionar como microfone dentro do app de chamadas.

```text
Android Phone
↓
Phone Mic protocol
↓
Desktop Client
↓
WebRTC
↓
Call
```

A interface desktop poderia mostrar:

```text
Input Device

○ USB Microphone
○ Webcam
● Galaxy Sxx — Remote
```

---

# 54. Princípio arquitetural

Separe em três camadas:

```text
Capture
Transport
Audio Output
```

Assim você pode trocar:

```text
Wi-Fi → USB
UDP → WebRTC
PipeWire → outra saída
```

sem reescrever o sistema inteiro.

---

# 55. Resultado esperado

```text
PHONE
├── Capture
├── Processing
├── Opus
└── Transport
      ↓
LINUX
├── Receiver
├── Jitter Buffer
├── Opus Decoder
├── PipeWire
└── Virtual Microphone
      ↓
Applications
```

Essa arquitetura permite começar simples e evoluir até um produto robusto de baixa latência.
