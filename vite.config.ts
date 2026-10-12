/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // `npm run dev` + `npm run server`: the app on Vite, the API on the sync server.
  server: { proxy: { '/api': { target: 'http://localhost:8080', ws: true } } },
  test: { environment: 'jsdom', include: ['src/**/*.ui.test.tsx'], globals: false },
});
