import { defineConfig } from 'astro/config';

const BACKEND = process.env.H3_BACKEND || 'http://127.0.0.1:8199';

export default defineConfig({
  server: { host: '127.0.0.1', port: 4321 },
  vite: {
    server: {
      proxy: {
        '/api': { target: BACKEND, changeOrigin: true },
      },
    },
  },
});
