import type { CallInfo, CallParticipant } from '../../shared/protocol.ts';

type Call = {
  conversation_id: string;
  started_at: number;
  participants: Map<string, CallParticipant>; // chave: connection_id
  ringTimer?: NodeJS.Timeout;
};

/** Estado das calls em memória. Não sabe nada de sockets: quem chama faz o broadcast. */
export class Calls {
  private calls = new Map<string, Call>();

  get(conversationId: string): Call | undefined {
    return this.calls.get(conversationId);
  }

  info(conversationId: string): CallInfo | undefined {
    const c = this.calls.get(conversationId);
    return c && { conversation_id: c.conversation_id, started_at: c.started_at, participants: [...c.participants.values()] };
  }

  all(): CallInfo[] {
    return [...this.calls.keys()].map((id) => this.info(id)!);
  }

  /** Entra na call (criando se preciso). Retorna se a call é nova e conexões antigas do mesmo usuário que saíram. */
  join(conversationId: string, userId: string, connectionId: string): { created: boolean; replaced: string[] } {
    let call = this.calls.get(conversationId);
    const created = !call;
    if (!call) {
      call = { conversation_id: conversationId, started_at: Date.now(), participants: new Map() };
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
