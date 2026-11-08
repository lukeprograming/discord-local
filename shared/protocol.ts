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

export type Attachment = VoiceAttachment | FileAttachment;

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
};

/** Campos que tornam a mensagem uma mudança em outra (não aparece sozinha no chat). */
export function isMutation(m: Pick<Message, 'edit_of' | 'delete_of' | 'reaction'>): boolean {
  return !!(m.edit_of || m.delete_of || m.reaction);
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
  video_id: string; // 11 caracteres
  title: string;
  added_by: string; // user_id
};

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
  | { type: 'add'; video_id: string; title: string; start?: number; play_now?: boolean }
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
  | { type: 'streams'; camera: string | null };

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
  };
  'status.set': { status: UserStatus };
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
