import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './', // o app é carregado via file:// no Electron
  plugins: [react()],
  // O worklet do noise gate precisa ser arquivo de verdade: o CSP bloqueia data: em script.
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: (file) => (file.endsWith('.js') ? false : undefined) },
});
