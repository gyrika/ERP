/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { FAKE_ORDER_SHOP } from './src/fake/data.ts';

export default defineConfig(({ mode }) => ({
  plugins: [react(), {
    // `npm run dev` only: the ordering page's shop status (the cloud answers it live; the sync server
    // has no such route), so the page shows "Open · Closes 9 PM" instead of "Couldn't check".
    name: 'dev-order-shop',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/v1/shop', (req, res, next) => {
        if (req.method !== 'GET' || !/^\/?(\?.*)?$/.test(req.url ?? '')) return next();
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(FAKE_ORDER_SHOP));
      });
    },
  }],
  // `npm run dev` + `npm run server`: the app on Vite, the API on the sync server.
  server: { proxy: { '/api': { target: 'http://localhost:8080', ws: true } } },
  // The cloud also serves the customers' ordering page (order.html → cheesybeez.com).
  build: mode === 'cloud' ? { rollupOptions: { input: { index: 'index.html', order: 'order.html' } } } : {},
  test: { environment: 'jsdom', include: ['src/**/*.ui.test.tsx'], globals: false },
}));
