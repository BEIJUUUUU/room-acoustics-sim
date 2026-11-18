import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    open: true,
    watch: {
      // The edit tool writes through sibling "<name>.tmpdir/" dirs; letting
      // chokidar watch those throws EBUSY and kills the dev server.
      ignored: ['**/*.tmpdir/**', '**/*.tmp'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    open: true,
  },
});
