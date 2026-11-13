import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // The potrace WASM package loads its own binary; keep Vite's pre-bundler away from it.
  optimizeDeps: { exclude: ['esm-potrace-wasm'] },
});
