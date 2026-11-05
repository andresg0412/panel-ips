import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    // La lista de requisitos de contraseña se comparte con el servidor (server/auth/politica.ts, fuera de web/).
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://localhost:8100' },
  },
});
