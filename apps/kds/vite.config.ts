import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  base: './',
  clearScreen: false,
  server: { port: 1421, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', sourcemap: true },
});
