import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './', // o app é carregado via file:// no Electron
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
});
