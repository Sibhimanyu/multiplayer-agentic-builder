import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Slate serves from root '/'. Do NOT set a base path — any non-root base makes
// every asset 404 on Slate. See catalyst-slate reference, "baseUrl breaks assets".
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
});
