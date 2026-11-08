import type { Conversation, FileAttachment, Friend, Message, ShareEntry, UserPublic } from '../../shared/protocol.ts';

export type HostConfig = {
  ip: string;
  port: number;
  name: string; // "Servidor do Lucas"
  tailscale: boolean; // ligar o Tailscale ao iniciar a sessão
};

/** Config carimbada no instalador exportado por um host. */
export type EmbeddedConfig = { server_url: string; invite_code: string; host_name: string };

export type NetInterface = { name: string; ip: string; vpn: string };

export type UpdateStatus = {
  state: 'idle' | 'unsupported' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error';
  current: string;
  version?: string;
  notes?: string;
  percent?: number;
  message?: string;
  checked_at?: number;
};

export type HotkeyName = 'mute' | 'deafen' | 'ptt' | 'clip';

export type HostStatus = { running: boolean; url?: string; ip?: string; port?: number };

export type Profile = {
  role: 'host' | 'client';
  host?: HostConfig;
  server_url: string;
  token: string;
  user: UserPublic;
  cache: { friends: Friend[]; conversations: Conversation[] };
  settings?: Settings;
};

export type Settings = {
  mic_id?: string;
  speaker_id?: string;
  camera_id?: string;
  screen_preset?: string;
  /** Volume do meu microfone (1 = 100%). */
  mic_volume?: number;
  /** Sensibilidade em dB: abaixo disso os outros não me ouvem. Ausente = automático (sempre aberto). */
  mic_threshold?: number | null;
  /** Supressão de ruído do microfone. Ausente = padrão (GTCRN). */
  mic_noise?: 'off' | 'native' | 'rnnoise' | 'gtcrn';
  /** Atalhos (formato do Electron, ex. "CommandOrControl+Shift+M"); '' = desligado. */
  hotkey_mute?: string;
  hotkey_deafen?: string;
  hotkey_ptt?: string;
  hotkey_clip?: string;
  /** Linux: no "tudo que toca no PC", incluir também Discord oficial e afins. */
  share_include_voice_apps?: boolean;
  /** Pasta que os amigos podem navegar e baixar (só desktop). */
  shared_folder?: string;
  /** Volume, só pra mim, do vídeo que estou transmitindo de um arquivo (0–100). */
  video_share_volume?: number;
  /** 'ptt' = microfone só abre segurando a tecla. */
  voice_mode?: 'open' | 'ptt';
  /** Favoritos (só neste aparelho). */
  fav_conversations?: string[];
  fav_messages?: { c: string; m: string }[];
  /** Conversas sem notificação (menção ainda avisa). */
  muted_conversations?: string[];
  /** Volume do soundboard neste aparelho (0–100). */
  sound_volume?: number;
  /** Volume do bot de YouTube neste aparelho (0–100). */
  yt_volume?: number;
  /** Volume que eu escolhi para cada pessoa: voz e áudio da transmissão de tela. */
  user_volumes?: Record<string, { voice?: number; screen?: number }>;
};

export type ScreenSource = { id: string; name: string; thumbnail: string; isScreen: boolean };

declare global {
  interface Window {
    native: {
      loadProfile(): Promise<Profile | null>;
      saveProfile(p: Profile | null): Promise<void>;
      loadMessages(convId: string): Promise<Message[]>;
      appendMessages(convId: string, msgs: Message[]): Promise<Message[]>;
      loadOutbox(): Promise<Message[]>;
      saveOutbox(list: Message[]): Promise<void>;
      openDataDir(): Promise<void>;
      /** Prévia de links: busca fora do renderer (CORS). Só https. */
      fetchUrl?(url: string, kind: 'page' | 'image'): Promise<{ type: string; finalUrl: string; text?: string; dataUrl?: string }>;
      // ---- Spotify (só desktop): sessão usada pelo player embutido ----
      spotifyLogin?(): Promise<boolean>;
      spotifyStatus?(): Promise<boolean>;
      spotifyLogout?(): Promise<void>;
      // ---- pasta compartilhada (dono: só desktop) ----
      sharePick?(): Promise<string | null>;
      shareList?(root: string, rel: string): Promise<ShareEntry[]>;
      shareUpload?(root: string, rel: string, serverUrl: string, token: string, to: string): Promise<{ url: string; name: string; size: number }>;
      shareDownload?(key: string, url: string, name: string): Promise<string>;
      shareShow?(path: string): Promise<void>;
      onShareProgress?(cb: (p: { key: string; done: number; total: number }) => void): () => void;
      // ---- gravações e clipes (só desktop) ----
      recStart?(kind: 'gravacao' | 'clipe', ext: string): Promise<{ id: string; path: string }>;
      recWrite?(id: string, bytes: Uint8Array): Promise<void>;
      recFinish?(id: string): Promise<string | null>;
      recShow?(path: string): Promise<void>;
      /** 'kde' = global com apertar e soltar (push-to-talk global); 'basic' = só apertar. */
      hotkeysKind?(): Promise<'kde' | 'basic'>;
      /** Devolve os que não deu pra registrar (tecla já usada, inválida…). */
      hotkeysSet?(bindings: Partial<Record<HotkeyName, string>>): Promise<HotkeyName[]>;
      hotkeysClear?(): Promise<void>;
      onHotkey?(cb: (h: { name: HotkeyName; pressed: boolean }) => void): () => void;
      // ---- arquivos do chat (caminho local = onde o arquivo está guardado no aparelho) ----
      pathForFile?(file: File): string | null;
      fileLocal?(convId: string, att: FileAttachment): Promise<string | null>;
      fileDownload?(serverUrl: string, token: string, convId: string, att: FileAttachment): Promise<string>;
      fileKeepSent?(convId: string, att: FileAttachment, source: string | Uint8Array): Promise<string>;
      fileRead?(path: string): Promise<Uint8Array>;
      fileOpen?(path: string): Promise<void>;
      fileShow?(path: string): Promise<void>;
      fileSaveAs?(path: string): Promise<string | null>;
      /** Celular: notificação agendada pelo sistema (lembretes). */
      scheduleNotification?(id: string, at: number, title: string, body: string): Promise<void>;
      /** Abre no navegador do aparelho (celular: downloads grandes). */
      openUrl?(url: string): Promise<void>;
      onFileProgress?(cb: (p: { id: string; done: number; total: number }) => void): () => void;
      info(): Promise<{ platform: string; profile: string; version: string }>;
      flash(): Promise<void>;
      /** Segundos sem mexer no PC (para o "ausente" automático). */
      idleSeconds?(): Promise<number>;
      /** Janela inteira em tela cheia (tile em tela cheia / F11). */
      setFullscreen?(on: boolean): Promise<void>;
      focusMain?(): Promise<void>;
      onChooseScreen(cb: (sources: ScreenSource[]) => void): () => void;
      screenPicked(id: string | null): Promise<void>;
      /** Linux: cria a fonte virtual com o áudio do PC (sem o próprio app). Devolve o nome do dispositivo. */
      shareAudioStart?(only?: string[] | null, includeVoiceApps?: boolean): Promise<string>;
      /** Linux: apps tocando som agora (para escolher só alguns na transmissão). */
      shareAudioApps?(): Promise<{ key: string; name: string; detail: string; voice?: boolean }[]>;
      shareAudioStop?(): Promise<void>;
      interfaces(): Promise<NetInterface[]>;
      hostStart(cfg: HostConfig): Promise<HostStatus>;
      hostStop(): Promise<HostStatus>;
      hostStatus(): Promise<HostStatus>;
      embedded(): Promise<EmbeddedConfig | null>;
      exportConnector(platform: 'win32' | 'linux', cfg: EmbeddedConfig, pickAgain?: boolean): Promise<string | null>;
      onExportProgress(cb: (p: { downloading: string; size: number }) => void): () => void;
      updateStatus(): Promise<UpdateStatus>;
      updateCheck(): Promise<UpdateStatus>;
      updateDownload(): Promise<void>;
      updateInstall(): Promise<void>;
      onUpdateStatus(cb: (s: UpdateStatus) => void): () => void;
      // Só no Android:
      notify?(title: string, body: string): Promise<void>;
      /** Mantém o app vivo com o microfone em segundo plano enquanto está na call. */
      callActive?(active: boolean): Promise<void>;
      /** Alto-falante (true) ou fone de ouvido do celular (false). */
      setSpeaker?(on: boolean): Promise<void>;
    };
  }
}
