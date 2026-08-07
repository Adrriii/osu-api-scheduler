import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: false },
  server: {
    // `npm run dev:web` talks to a scheduler running on its default port, so
    // the dashboard can be developed against live data.
    proxy: {
      '/dash': 'http://127.0.0.1:7654',
      '/auth': 'http://127.0.0.1:7654',
      '/stats': 'http://127.0.0.1:7654',
    },
  },
});
