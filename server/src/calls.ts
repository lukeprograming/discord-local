import type { CallInfo, CallParticipant, MediaAction, MediaState } from '../../shared/protocol.ts';
import { MAX_MEDIA_QUEUE, YT_ID_RE } from '../../shared/protocol.ts';
import { ulid } from './ids.ts';

export class MediaError extends Error {}

type Call = {
  conversation_id: string;
  started_at: number;
  participants: Map<string, CallParticipant>; // chave: connection_id
  ringTimer?: NodeJS.Timeout;
  media: Omit<MediaState, 'server_time'>;
};

/** Estado das calls em memória. Não sabe nada de sockets: quem chama faz o broadcast. */
export class Calls {
  private calls = new Map<string, Call>();

  get(conversationId: string): Call | undefined {
    return this.calls.get(conversationId);
  }

  info(conversationId: string): CallInfo | undefined {
    const c = this.calls.get(conversationId);
    if (!c) return undefined;
    const info: CallInfo = { conversation_id: c.conversation_id, started_at: c.started_at, participants: [...c.participants.values()] };
    if (c.media.queue.length) info.media = { ...c.media, queue: [...c.media.queue], server_time: Date.now() };
    return info;
  }

  all(): CallInfo[] {
    return [...this.calls.keys()].map((id) => this.info(id)!);
  }

  /** Entra na call (criando se preciso). Retorna se a call é nova e conexões antigas do mesmo usuário que saíram. */
  join(conversationId: string, userId: string, connectionId: string): { created: boolean; replaced: string[] } {
    let call = this.calls.get(conversationId);
    const created = !call;
    if (!call) {
      call = {
        conversation_id: conversationId,
        started_at: Date.now(),
        participants: new Map(),
        media: { queue: [], playing: false, position: 0, updated_at: Date.now() },
      };
      this.calls.set(conversationId, call);
    }
    // Um usuário só fica na call por um aparelho: o novo substitui o antigo.
    const replaced: string[] = [];
    for (const [connId, p] of call.participants) {
      if (p.user_id === userId && connId !== connectionId) {
        call.participants.delete(connId);
        replaced.push(connId);
      }
    }
    if (!call.participants.has(connectionId)) {
      call.participants.set(connectionId, {
        user_id: userId,
        connection_id: connectionId,
        muted: false,
        deafened: false,
        screen_sharing: false,
      });
    }
    if (call.participants.size > 1 && call.ringTimer) {
      clearTimeout(call.ringTimer);
      call.ringTimer = undefined;
    }
    return { created, replaced };
  }

  /** Sai da call. Retorna a duração se a call terminou (ficou vazia). */
  leave(conversationId: string, connectionId: string): { ended: boolean; duration_s: number } | undefined {
    const call = this.calls.get(conversationId);
    if (!call || !call.participants.delete(connectionId)) return undefined;
    if (call.participants.size > 0) return { ended: false, duration_s: 0 };
    return { ended: true, duration_s: this.end(conversationId) };
  }

  end(conversationId: string): number {
    const call = this.calls.get(conversationId);
    if (!call) return 0;
    if (call.ringTimer) clearTimeout(call.ringTimer);
    this.calls.delete(conversationId);
    return Math.round((Date.now() - call.started_at) / 1000);
  }

  /** Calls em que essa conexão está (para limpar ao desconectar). */
  callsOfConnection(connectionId: string): string[] {
    return [...this.calls.values()].filter((c) => c.participants.has(connectionId)).map((c) => c.conversation_id);
  }

  setState(conversationId: string, connectionId: string, s: Pick<CallParticipant, 'muted' | 'deafened' | 'screen_sharing'>): boolean {
    const p = this.calls.get(conversationId)?.participants.get(connectionId);
    if (!p) return false;
    p.muted = !!s.muted;
    p.deafened = !!s.deafened;
    p.screen_sharing = !!s.screen_sharing;
    return true;
  }

  /** Aplica um comando do bot de YouTube. Retorna se o estado mudou. */
  media(conversationId: string, userId: string, a: MediaAction): boolean {
    const call = this.calls.get(conversationId);
    if (!call) throw new MediaError('call não encontrada');
    const m = call.media;
    const now = Date.now();
    const pos = () => (m.playing ? m.position + (now - m.updated_at) / 1000 : m.position);
    const set = (patch: Partial<typeof m>) => Object.assign(m, patch, { updated_at: now });
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);
    const current = m.queue[0];

    switch (a?.type) {
      case 'add': {
        if (typeof a.video_id !== 'string' || !YT_ID_RE.test(a.video_id)) throw new MediaError('link do YouTube inválido');
        if (m.queue.length >= MAX_MEDIA_QUEUE) throw new MediaError('fila cheia');
        const title = (typeof a.title === 'string' ? a.title.trim() : '').slice(0, 200) || 'Vídeo do YouTube';
        const item = { id: ulid(), video_id: a.video_id, title, added_by: userId };
        if (!current || a.play_now) {
          if (a.play_now && current) m.queue.shift();
          m.queue.unshift(item);
          set({ playing: true, position: num(a.start) });
        } else {
          m.queue.push(item);
        }
        return true;
      }
      case 'add_many': {
        if (!Array.isArray(a.items) || !a.items.length) throw new MediaError('playlist vazia');
        const items = a.items
          .filter((x) => x && typeof x.video_id === 'string' && YT_ID_RE.test(x.video_id))
          .map((x) => ({
            id: ulid(),
            video_id: x.video_id,
            title: (typeof x.title === 'string' ? x.title.trim() : '').slice(0, 200) || 'Vídeo do YouTube',
            added_by: userId,
          }));
        if (!items.length) throw new MediaError('playlist sem vídeos válidos');
        if (a.play_now) m.queue = [];
        const room = MAX_MEDIA_QUEUE - m.queue.length;
        if (room <= 0) throw new MediaError('fila cheia');
        const wasEmpty = !m.queue.length;
        m.queue.push(...items.slice(0, room));
        if (wasEmpty) set({ playing: true, position: 0 });
        return true;
      }
      case 'shuffle': {
        const rest = m.queue.slice(1);
        if (rest.length < 2) return false;
        for (let i = rest.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        m.queue = [m.queue[0], ...rest];
        return true;
      }
      case 'play':
        if (!current || m.playing) return false;
        set({ playing: true, position: pos() });
        return true;
      case 'pause':
        if (!current || !m.playing) return false;
        set({ playing: false, position: a.position !== undefined ? num(a.position) : pos() });
        return true;
      case 'seek':
        if (!current) return false;
        set({ position: num(a.position) });
        return true;
      case 'next':
        if (!current) return false;
        m.queue.shift();
        set({ playing: m.queue.length > 0, position: 0 });
        return true;
      case 'ended':
        // Só o primeiro aviso conta; os outros clientes mandam o mesmo item_id.
        if (!current || current.id !== a.item_id) return false;
        m.queue.shift();
        set({ playing: m.queue.length > 0, position: 0 });
        return true;
      case 'jump': {
        const i = m.queue.findIndex((x) => x.id === a.id);
        if (i <= 0) return false;
        const [item] = m.queue.splice(i, 1);
        m.queue[0] = item;
        set({ playing: true, position: 0 });
        return true;
      }
      case 'remove': {
        const i = m.queue.findIndex((x) => x.id === a.id);
        if (i < 0) return false;
        m.queue.splice(i, 1);
        if (i === 0) set({ playing: m.queue.length > 0, position: 0 });
        return true;
      }
      case 'clear':
        if (!m.queue.length) return false;
        m.queue = [];
        set({ playing: false, position: 0 });
        return true;
      case 'title': {
        const item = m.queue.find((x) => x.id === a.item_id);
        const title = typeof a.title === 'string' ? a.title.trim().slice(0, 200) : '';
        if (!item || !title || item.title === title) return false;
        item.title = title;
        return true;
      }
      default:
        throw new MediaError('comando desconhecido');
    }
  }

  inCall(conversationId: string, connectionId: string): boolean {
    return !!this.calls.get(conversationId)?.participants.has(connectionId);
  }

  setRingTimer(conversationId: string, ms: number, onTimeout: () => void): void {
    const call = this.calls.get(conversationId);
    if (!call) return;
    call.ringTimer = setTimeout(() => {
      call.ringTimer = undefined;
      if (call.participants.size <= 1) onTimeout();
    }, ms);
  }
}
