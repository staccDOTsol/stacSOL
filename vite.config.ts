import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Vite doesn't compile /api — proxy to production (or `vercel dev`) in local dev.
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'https://stacsol.app',
        changeOrigin: true,
      },
    },
  },
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  optimizeDeps: {
    esbuildOptions: {
      define: { global: 'globalThis' },
    },
  },
})
