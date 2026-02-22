import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Unified Vite config: enable rollup-compatible sourcemaps and keep dev server port
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  },
  build: {
    sourcemap: true,
    // Use terser for minification so generated sourcemaps are compatible
    // with source-map-explorer and other analysis tools.
    minify: 'terser',
    rollupOptions: {
      output: {
        // Manual chunking function to place large/optional modules into separate chunks
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (id.includes('react')) return 'react';
            if (id.includes('socket.io-client') || id.includes('engine.io-client') || id.includes('socket.io-parser')) return 'sockets';
            if (id.includes('picomatch') || id.includes('bytes')) return 'vendor';
          }
          if (id.includes('/src/soundManager') || id.includes('/src/soundConfig')) return 'sound';
          if (id.includes('/src/confetti.css')) return 'confetti';
          if (id.includes('/src/workers/')) return 'workers';
          return null;
        }
      }
    }
  }
})
