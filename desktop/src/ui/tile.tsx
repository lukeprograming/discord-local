// Peças comuns dos tiles de vídeo (telas transmitidas e player do YouTube):
// tela cheia de verdade e controles que somem quando o mouse para.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

// Tela cheia feita pelo app: o tile ocupa a janela inteira e a janela vai pra tela cheia
// (como o F11). Não depende da Fullscreen API, que no Wayland pode não ser liberada
// e no WebView do Android nem sempre existe.

let fsId: string | null = null;
const fsListeners = new Set<() => void>();
const emit = () => fsListeners.forEach((l) => l());

function setFs(id: string | null): void {
  if (fsId === id) return;
  fsId = id;
  window.native.setFullscreen?.(!!id);
  document.body.classList.toggle('has-tile-fs', !!id);
  emit();
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && fsId) setFs(null);
});

/** Liga/desliga a tela cheia deste tile. */
export function useTileFullscreen(id: string): { fs: boolean; toggle: () => void } {
  const fs = useSyncExternalStore(
    (l) => {
      fsListeners.add(l);
      return () => fsListeners.delete(l);
    },
    () => fsId === id,
  );
  useEffect(() => () => {
    if (fsId === id) setFs(null); // tile sumiu (parou a transmissão) em tela cheia
  }, [id]);
  return { fs, toggle: () => setFs(fsId === id ? null : id) };
}

/** true quando o mouse ficou parado em cima do tile (esconde controles e cursor). */
export function useIdle(ms = 2500) {
  const ref = useRef<HTMLDivElement>(null);
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let t = 0;
    const wake = () => {
      setIdle(false);
      clearTimeout(t);
      t = window.setTimeout(() => setIdle(true), ms);
    };
    const leave = () => {
      clearTimeout(t);
      setIdle(false);
    };
    el.addEventListener('mousemove', wake);
    el.addEventListener('mouseleave', leave);
    el.addEventListener('touchstart', wake, { passive: true });
    return () => {
      clearTimeout(t);
      el.removeEventListener('mousemove', wake);
      el.removeEventListener('mouseleave', leave);
      el.removeEventListener('touchstart', wake);
    };
  }, [ms]);
  return { ref, idle };
}
