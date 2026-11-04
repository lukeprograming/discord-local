import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mesma interface do desktop (../desktop/src); só o "native" muda (src/native.ts).
export default defineConfig({
  base: './',
  plugins: [react()],
  // O worklet do noise gate precisa ser arquivo de verdade: o CSP bloqueia data: em script.
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: (file) => (file.endsWith('.js') ? false : undefined) },
});
