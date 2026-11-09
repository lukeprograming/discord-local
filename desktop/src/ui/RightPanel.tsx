// Painel da direita: contextual e recolhível. "Pessoas" vale pra qualquer conversa;
// as abas de ferramenta (música, jogos, soundboard, gravação, diagnóstico) agem na
// call em que estou, de qualquer tela — antes elas se empilhavam dentro da call e
// cobriam o chat.

import { CircleDot, Dices, HeadphoneOff, Megaphone, MicOff, MonitorUp, Music, Stethoscope, Users, X } from 'lucide-react';
import type { Conversation } from '../../../shared/protocol.ts';
import { app, useApp, type PanelTab } from '../app.ts';
import { canRecord } from '../recorder.ts';
import { Avatar } from './common.tsx';
import { BotPanel } from './YouTubeBot.tsx';
import { GamesPanel } from './Games.tsx';
import { SoundboardPanel } from './Soundboard.tsx';
import { DiagnosticsPanel } from './Diagnostics.tsx';
import { RecordPanel, recordTargets } from './CallPanel.tsx';

const TABS: { tab: PanelTab; label: string; Icon: typeof Users; call?: boolean }[] = [
  { tab: 'people', label: 'Pessoas', Icon: Users },
  { tab: 'music', label: 'Música', Icon: Music, call: true },
  { tab: 'games', label: 'Jogos', Icon: Dices, call: true },
  { tab: 'sounds', label: 'Soundboard', Icon: Megaphone, call: true },
  { tab: 'record', label: 'Gravar', Icon: CircleDot, call: true },
  { tab: 'diag', label: 'Diagnóstico', Icon: Stethoscope, call: true },
];

export function RightPanel({ conversation }: { conversation: Conversation | null }) {
  const s = useApp((s) => s);
  const inCall = !!s.call;
  const tabs = TABS.filter((t) => (!t.call || inCall) && (t.tab !== 'record' || canRecord()) && (t.tab !== 'people' || conversation));
  const tab = tabs.some((t) => t.tab === s.panelTab) ? s.panelTab : tabs[0]?.tab;
  if (!tab) return null;
  const callConv = s.call ? s.conversations.find((c) => c.id === s.call!.conversationId) : undefined;
  const elsewhere = TABS.find((t) => t.tab === tab)?.call && callConv && callConv.id !== conversation?.id;

  return (
    <>
      <div className="rpanel-backdrop" onClick={() => app.setPanelOpen(false)} />
      <aside className={`rpanel ${tab === 'games' ? 'wide' : ''}`} aria-label="Painel lateral">
        <div className="rpanel-tabs" role="tablist">
          {tabs.map(({ tab: t, label, Icon }) => (
            <button
              key={t}
              role="tab"
              aria-selected={t === tab}
              className={`rpanel-tab ${t === tab ? 'on' : ''}`}
              title={label}
              onClick={() => app.openPanel(t, false)}
            >
              <Icon size={17} />
              {t === tab && <span>{label}</span>}
            </button>
          ))}
          <span className="grow" />
          <button className="rpanel-close" title="Fechar painel" aria-label="Fechar painel" onClick={() => app.setPanelOpen(false)}>
            <X size={18} />
          </button>
        </div>
        {elsewhere && (
          <button className="rpanel-callnote" onClick={() => app.select(callConv!.id)}>
            na call de <strong>{app.conversationTitle(callConv!)}</strong> — ir para a call
          </button>
        )}
        <div className="rpanel-body">
          {tab === 'people' && conversation && <People conversation={conversation} />}
          {tab === 'music' && <BotPanel media={s.call ? s.calls[s.call.conversationId]?.media : undefined} />}
          {tab === 'games' && <GamesPanel />}
          {tab === 'sounds' && <SoundboardPanel />}
          {tab === 'record' && <RecordPanel targets={recordTargets(s)} />}
          {tab === 'diag' && <DiagnosticsPanel />}
        </div>
      </aside>
    </>
  );
}

function People({ conversation }: { conversation: Conversation }) {
  const s = useApp((s) => s);
  const meId = s.profile?.user.id;
  const call = s.calls[conversation.id];
  const online = (id: string) => id === meId || s.presences[id] === 'ONLINE';
  const members = [...conversation.members].sort(
    (a, b) => Number(online(b.id)) - Number(online(a.id)) || a.display_name.localeCompare(b.display_name),
  );

  return (
    <div className="people">
      {call && call.participants.length > 0 && (
        <section>
          <h5>Na call ({call.participants.length})</h5>
          {call.participants.map((p) => (
            <div key={p.connection_id} className="person">
              <Avatar user={app.user(p.user_id)} size={32} />
              <span className="person-name">
                <span className="person-line">
                  {app.user(p.user_id)?.display_name ?? '?'}
                  {p.user_id === meId && <small className="muted"> (você)</small>}
                </span>
              </span>
              <span className="person-icons">
                {p.recording && <span className="rec-badge">REC</span>}
                {p.screen_sharing && <MonitorUp size={15} className="state-icon live" aria-label="transmitindo" />}
                {p.muted && <MicOff size={15} className="state-icon" aria-label="microfone desligado" />}
                {p.deafened && <HeadphoneOff size={15} className="state-icon" aria-label="ensurdecido" />}
              </span>
            </div>
          ))}
        </section>
      )}
      <section>
        <h5>
          Membros ({members.length}) <small className="muted">· {members.filter((m) => online(m.id)).length} online</small>
        </h5>
        {members.map((m) => {
          const st = app.statusOf(m.id);
          const status = online(m.id) ? [st?.emoji, st?.text].filter(Boolean).join(' ') : 'offline';
          return (
            <div key={m.id} className={`person ${online(m.id) ? '' : 'offline'}`}>
              <Avatar user={m} size={32} online={online(m.id)} availability={st?.availability} />
              <span className="person-name">
                <span className="person-line">
                  {m.display_name}
                  {m.id === meId && <small className="muted"> (você)</small>}
                </span>
                {status && <small className="muted person-status">{status}</small>}
              </span>
              {conversation.owner_id === m.id && <span className="role-badge">Dono</span>}
            </div>
          );
        })}
      </section>
    </div>
  );
}
