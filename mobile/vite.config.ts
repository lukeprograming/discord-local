import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { wasmBase64 } from '../desktop/vite-wasm-base64.ts';

// Mesma interface do desktop (../desktop/src); só o "native" muda (src/native.ts).
export default defineConfig({
  base: './',
  plugins: [react(), wasmBase64()],
  // Os worklets (noise gate, supressão de ruído) precisam ser arquivo de verdade: o CSP bloqueia data: em script.
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: (file) => (file.endsWith('.js') ? false : undefined) },
});
