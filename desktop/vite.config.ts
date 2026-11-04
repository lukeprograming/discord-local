import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { wasmBase64 } from './vite-wasm-base64.ts';

export default defineConfig({
  base: './', // o app é carregado via file:// no Electron
  plugins: [react(), wasmBase64()],
  // Os worklets (noise gate, supressão de ruído) precisam ser arquivo de verdade: o CSP bloqueia data: em script.
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: (file) => (file.endsWith('.js') ? false : undefined) },
});
