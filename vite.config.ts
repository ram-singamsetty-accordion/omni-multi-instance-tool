import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  // Same PORT (and .env) the API server reads, so the proxy follows a PORT override.
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = Number.parseInt(env.PORT ?? '', 10) || 5174;
  return {
    root: fileURLToPath(new URL('./src/web', import.meta.url)),
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${apiPort}`,
          changeOrigin: false,
        },
      },
    },
    build: {
      outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
      emptyOutDir: true,
    },
  };
});
