import { defineConfig } from 'vite';

// Empacota o servidor (../server) num único .cjs para rodar dentro do Electron no modo host.
export default defineConfig({
  build: {
    ssr: '../server/src/server.ts',
    outDir: 'electron/generated',
    emptyOutDir: true,
    target: 'node24',
    rollupOptions: { output: { format: 'cjs', entryFileNames: 'server.cjs' } },
  },
  ssr: { noExternal: true, external: ['bufferutil', 'utf-8-validate'] },
});
