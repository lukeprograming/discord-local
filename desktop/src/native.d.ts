import type { Conversation, Friend, Message, UserPublic } from '../../shared/protocol.ts';

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

export type HostStatus = { running: boolean; url?: string; ip?: string; port?: number };

export type Profile = {
  role: 'host' | 'client';
  host?: HostConfig;
  server_url: string;
  token: string;
  user: UserPublic;
  cache: { friends: Friend[]; conversations: Conversation[] };
  settings?: { mic_id?: string; speaker_id?: string; screen_preset?: string };
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
      info(): Promise<{ platform: string; profile: string; version: string }>;
      flash(): Promise<void>;
      onChooseScreen(cb: (sources: ScreenSource[]) => void): () => void;
      screenPicked(id: string | null): Promise<void>;
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
    };
  }
}
