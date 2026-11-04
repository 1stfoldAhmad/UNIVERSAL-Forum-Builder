import { defineConfig } from 'vite';

// Live preview must bind 0.0.0.0 and accept the Arena proxy host (*.e2b.app).
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true, // accept the proxied preview origin
  },
  preview: { host: '0.0.0.0', port: 5173, allowedHosts: true },
});
