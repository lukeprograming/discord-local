// Contrato entre servidor e clientes. Só tipos: é importado com `import type`
// pelos dois lados (o servidor roda com type-stripping do Node, sem build).

export type UserPublic = {
  id: string;
  username: string;
  display_name: string;
};

export type Presence = 'ONLINE' | 'OFFLINE';

export type FriendStatus = 'ACCEPTED' | 'INCOMING' | 'OUTGOING';

export type Friend = {
  user: UserPublic;
  status: FriendStatus;
};

/** ROOM = sala fixa do servidor: todo mundo participa, a voz fica aberta (sem tocar pra ninguém). */
export type ConversationType = 'DIRECT' | 'GROUP' | 'ROOM';

export type Conversation = {
  id: string;
  type: ConversationType;
  name: string | null;
  owner_id: string | null;
  members: UserPublic[];
};

/** Mensagem de voz gravada no app (vai inteira dentro da mensagem). */
export type VoiceAttachment = {
  kind: 'voice';
  mime: string; // ex.: audio/webm;codecs=opus
  data: string; // base64
  duration_ms: number;
  peaks: number[]; // forma de onda resumida (0..1)
};

/** Arquivo enviado: o conteúdo fica no host (POST /files) até todos baixarem ou expirar. */
export type FileAttachment = {
  kind: 'file';
  id: string; // ULID dado pelo servidor no upload
  name: string;
  size: number; // bytes
  mime: string;
};

/** Enquete: votos chegam como mensagens com `vote` (o último voto de cada um vale). */
export type PollAttachment = {
  kind: 'poll';
  question: string; // até 200
  options: string[]; // 2 a 10, até 100 cada
  multi: boolean; // pode marcar várias
};

/** Lembrete: cada aparelho da conversa avisa na hora marcada. */
export type ReminderAttachment = {
  kind: 'reminder';
  at: number; // ms epoch
  text: string; // até 300
};

export type Attachment = VoiceAttachment | FileAttachment | PollAttachment | ReminderAttachment;

export type Message = {
  id: string; // ULID gerado pelo cliente (idempotência do reenvio)
  conversation_id: string;
  sender_id: string;
  content: string; // nas de voz: texto de reserva para versões antigas e notificações
  created_at: number; // ms epoch, carimbado pelo servidor ao receber
  attachment?: Attachment;
  /** Resposta a outra mensagem (id). */
  reply_to?: string;
  /**
   * Mudanças em mensagens já enviadas também viajam como mensagens (o histórico é local e
   * só cresce): o app aplica por cima da original. `content` vira texto de reserva.
   */
  edit_of?: string; // novo texto em content (só o autor)
  delete_of?: string; // só o autor
  reaction?: { target: string; emoji: string; on: boolean };
  /** Voto numa enquete (índices das opções; vazio = tirou o voto). */
  vote?: { target: string; options: number[] };
};

/** Campos que tornam a mensagem uma mudança em outra (não aparece sozinha no chat). */
export function isMutation(m: Pick<Message, 'edit_of' | 'delete_of' | 'reaction' | 'vote'>): boolean {
  return !!(m.edit_of || m.delete_of || m.reaction || m.vote);
}

export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👀', '✅'];

export type CallParticipant = {
  user_id: string;
  connection_id: string;
  muted: boolean;
  deafened: boolean;
  screen_sharing: boolean;
  /** Está gravando a call (todo mundo vê o aviso). */
  recording?: boolean;
};

/** Item da fila do bot de YouTube. */
export type MediaItem = {
  id: string;
  video_id: string; // YouTube: 11 caracteres; Spotify: id da faixa (22); SoundCloud: vazio
  title: string;
  added_by: string; // user_id
  /** De onde vem (ausente = youtube, versões antigas). */
  source?: MediaSource;
  /** SoundCloud: link da faixa (https://soundcloud.com/artista/faixa). */
  url?: string;
  /** Capa (SoundCloud; no YouTube vem do id). */
  thumb?: string;
};

export type MediaSource = 'youtube' | 'soundcloud' | 'spotify';
export const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
export const SOUNDCLOUD_URL_RE = /^https:\/\/(?:www\.|m\.)?soundcloud\.com\/[\w-]+\/(?:sets\/)?[\w-]+\/?$/;
export const SOUNDCLOUD_THUMB_RE = /^https:\/\/i\d?\.sndcdn\.com\/[\w./-]+$/;
export const SPOTIFY_THUMB_RE = /^https:\/\/(?:i\.scdn\.co|image-cdn-[a-z]+\.spotifycdn\.com|[\w-]+\.spotifycdn\.com)\/[\w./-]+$/;

/**
 * Estado do bot de YouTube: cada um toca no próprio app e se ajusta a isso.
 * queue[0] é o que está tocando; o que acaba sai da fila.
 * Posição atual = position + (playing ? agora - updated_at : 0), no relógio do servidor
 * (server_time é o "agora" do servidor no envio, para descontar a diferença de relógio).
 */
export type MediaState = {
  queue: MediaItem[];
  playing: boolean;
  position: number; // segundos
  updated_at: number;
  server_time: number;
};

export type MediaAction =
  | { type: 'add'; video_id: string; title: string; start?: number; play_now?: boolean; source?: MediaSource; url?: string; thumb?: string }
  /** Playlist: vários de uma vez (play_now troca a fila atual pela playlist). */
  | { type: 'add_many'; items: { video_id: string; title: string }[]; play_now?: boolean }
  /** Embaralha o que vem depois do vídeo atual. */
  | { type: 'shuffle' }
  | { type: 'play' }
  | { type: 'pause'; position?: number }
  | { type: 'seek'; position: number }
  | { type: 'next' }
  /** Toca esse item da fila agora (o atual sai). */
  | { type: 'jump'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  /** O vídeo atual acabou (cada cliente avisa; o servidor só avança uma vez). */
  | { type: 'ended'; item_id: string }
  /** O título real chegou pelo player (o oEmbed pode ter falhado). */
  | { type: 'title'; item_id: string; title: string };

export type CallInfo = {
  conversation_id: string;
  started_at: number;
  participants: CallParticipant[];
  media?: MediaState;
};

// Espelha RTCIceCandidateInit sem depender dos tipos DOM (o servidor não tem).
export type IceCandidate = {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

export type RtcSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: IceCandidate | null }
  /** Diz qual stream é a câmera (o resto do vídeo é tela). */
  | { type: 'streams'; camera: string | null }
  /** A conexão travou: os dois lados jogam fora e criam outra do zero. */
  | { type: 'reset' };

export type Availability = 'online' | 'idle' | 'dnd';

/** Status escolhido pela pessoa (fica salvo no host). */
export type UserStatus = {
  availability: Availability;
  text: string; // até 80
  emoji: string; // até 16
};

/** Som do soundboard (o áudio fica no host: GET /sounds/<id>). */
export type Sound = {
  id: string;
  name: string;
  emoji: string;
  uploader_id: string;
  size: number;
};

export const MAX_SOUND_BYTES = 1024 * 1024;
export const MAX_SOUNDS = 60;

/** Convite criado no servidor (lista do host para revogar). */
export type InviteInfo = {
  code: string;
  created_at: number;
  multi_use: boolean; // embutido em instalador exportado
  uses: number;
  revoked: boolean;
  used_by: string | null; // display_name do último que usou
};

/** Atividades da call (jogos): o servidor só ordena e guarda o histórico de eventos. */
export type ActivityName = 'velha' | 'quadro';

/** Pasta compartilhada: pedido que o host repassa ao dono da pasta. */
export type ShareRequest = { type: 'list'; path: string } | { type: 'get'; path: string };
export type ShareEntry = { name: string; dir: boolean; size: number; mtime: number };
export type ShareResponse =
  | { ok: true; type: 'list'; path: string; entries: ShareEntry[] }
  | { ok: true; type: 'get'; url: string; name: string; size: number } // url de uso único no host
  | { ok: false; error: string };

export type ReadyPayload = {
  connection_id: string;
  user: UserPublic;
  friends: Friend[];
  conversations: Conversation[];
  presences: Record<string, Presence>;
  calls: CallInfo[];
  statuses?: Record<string, UserStatus>;
  sounds?: Sound[];
  /** Sou o admin (host): posso criar/renomear/apagar salas. */
  admin?: boolean;
};

// ---- cliente -> servidor (comandos com `rid` recebem `ack`) ----

export type ClientOps = {
  hello: { token: string };
  ping: Record<string, never>;
  'invite.create': { multi_use?: boolean };
  'friend.request': { username: string };
  'friend.accept': { user_id: string };
  'friend.remove': { user_id: string };
  'group.create': { name: string; member_ids: string[] };
  'message.send': {
    id: string;
    conversation_id: string;
    content: string;
    attachment?: Attachment;
    reply_to?: string;
    edit_of?: string;
    delete_of?: string;
    reaction?: { target: string; emoji: string; on: boolean };
    vote?: { target: string; options: number[] };
  };
  'status.set': { status: UserStatus };
  'invite.list': Record<string, never>;
  'call.activity': { conversation_id: string; activity: ActivityName; event: Record<string, unknown> };
  'call.activity.log': { conversation_id: string; activity: ActivityName };
  'share.request': { to_user_id: string; req_id: string; req: ShareRequest };
  'share.response': { to_user_id: string; req_id: string; res: ShareResponse };
  'invite.revoke': { code: string };
  'room.create': { name: string };
  'room.rename': { conversation_id: string; name: string };
  'room.delete': { conversation_id: string };
  'sound.delete': { id: string };
  /** Toca um som do soundboard pra todos na call. */
  'call.sound': { conversation_id: string; sound_id: string };
  /** Controle do bot de YouTube da call (todos na call podem mexer). */
  'call.media': { conversation_id: string; action: MediaAction };
  'mailbox.ack': { ids: string[] };
  typing: { conversation_id: string };
  'call.join': { conversation_id: string };
  'call.leave': { conversation_id: string };
  'call.state': { conversation_id: string; muted: boolean; deafened: boolean; screen_sharing: boolean; recording?: boolean };
  'rtc.signal': { conversation_id: string; to_connection_id: string; signal: RtcSignal };
};

// Resposta `d` de cada comando no ack.
export type ClientOpResults = {
  'invite.create': { code: string };
  'group.create': { conversation: Conversation };
  'message.send': { message: Message };
  'room.create': { conversation: Conversation };
  'invite.list': { invites: InviteInfo[] };
  'call.activity.log': { events: { event: Record<string, unknown>; user_id: string }[] };
};

// ---- servidor -> cliente ----

export type ServerOps = {
  ready: ReadyPayload;
  pong: Record<string, never>;
  ack: { ok: boolean; d?: unknown; error?: string };
  'friends.sync': { friends: Friend[] };
  'conversation.upsert': { conversation: Conversation };
  'message.created': { message: Message };
  'presence.update': { user_id: string; status: Presence };
  'status.update': { user_id: string; status: UserStatus };
  'conversation.removed': { conversation_id: string };
  'sounds.sync': { sounds: Sound[] };
  'call.activity': { conversation_id: string; activity: ActivityName; event: Record<string, unknown>; user_id: string };
  'share.request': { from_user_id: string; req_id: string; req: ShareRequest };
  'share.response': { from_user_id: string; req_id: string; res: ShareResponse };
  'call.sound': { conversation_id: string; sound_id: string; user_id: string };
  typing: { conversation_id: string; user_id: string };
  'call.update': { call: CallInfo };
  'call.ringing': { conversation_id: string; from_user_id: string };
  'call.ended': { conversation_id: string; duration_s: number };
  'rtc.signal': { conversation_id: string; from_connection_id: string; from_user_id: string; signal: RtcSignal };
};

export type Envelope<Ops, K extends keyof Ops = keyof Ops> = {
  op: K;
  d: Ops[K];
  rid?: string;
};

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_VOICE_MS = 3 * 60_000;
/** Tamanho máximo do áudio em base64 (~3 min de Opus a 24 kbps cabem com folga). */
export const MAX_VOICE_BASE64 = 1_200_000;
export const VOICE_PEAKS = 48;
export const MAX_FILE_BYTES = 2 * 1024 ** 3;
export const FILE_TTL_MS = 7 * 24 * 3600_000;
export const MAX_MEDIA_QUEUE = 300;
export const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
