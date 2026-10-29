/** Single-origin UI: the Hono process owns Vite in development and static files in production. */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { middlewareMode: true },
  build: { outDir: 'dist', sourcemap: false },
});
