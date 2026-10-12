/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // `npm run dev` + `npm run server`: the app on Vite, the API on the sync server.
  server: { proxy: { '/api': { target: 'http://localhost:8080', ws: true } } },
  // The cloud also serves the customers' ordering page (order.html → cheesybeez.com).
  build: mode === 'cloud' ? { rollupOptions: { input: { index: 'index.html', order: 'order.html' } } } : {},
  test: { environment: 'jsdom', include: ['src/**/*.ui.test.tsx'], globals: false },
}));
