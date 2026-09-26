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

export type ConversationType = 'DIRECT' | 'GROUP';

export type Conversation = {
  id: string;
  type: ConversationType;
  name: string | null;
  owner_id: string | null;
  members: UserPublic[];
};

export type Message = {
  id: string; // ULID gerado pelo cliente (idempotência do reenvio)
  conversation_id: string;
  sender_id: string;
  content: string;
  created_at: number; // ms epoch, carimbado pelo servidor ao receber
};

export type CallParticipant = {
  user_id: string;
  connection_id: string;
  muted: boolean;
  deafened: boolean;
  screen_sharing: boolean;
};

export type CallInfo = {
  conversation_id: string;
  started_at: number;
  participants: CallParticipant[];
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
  | { type: 'candidate'; candidate: IceCandidate | null };

export type ReadyPayload = {
  connection_id: string;
  user: UserPublic;
  friends: Friend[];
  conversations: Conversation[];
  presences: Record<string, Presence>;
  calls: CallInfo[];
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
  'message.send': { id: string; conversation_id: string; content: string };
  'mailbox.ack': { ids: string[] };
  typing: { conversation_id: string };
  'call.join': { conversation_id: string };
  'call.leave': { conversation_id: string };
  'call.state': { conversation_id: string; muted: boolean; deafened: boolean; screen_sharing: boolean };
  'rtc.signal': { conversation_id: string; to_connection_id: string; signal: RtcSignal };
};

// Resposta `d` de cada comando no ack.
export type ClientOpResults = {
  'invite.create': { code: string };
  'group.create': { conversation: Conversation };
  'message.send': { message: Message };
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
