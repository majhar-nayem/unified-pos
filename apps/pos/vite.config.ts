import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tauri expects a fixed dev port and a relative base for the production bundle.
// In the browser dev build `/v1` is proxied to the API so no CORS is needed (the API sends none);
// the Tauri build calls the configured server address directly.
const apiTarget = process.env.POS_API_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: { '/v1': { target: apiTarget, changeOrigin: true } },
  },
  build: { target: 'es2022', outDir: 'dist', sourcemap: true },
});
