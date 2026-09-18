import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const proxy = {
  '/api/ss-fixtures': {
    target: 'https://api.content-prod.superscore.live',
    changeOrigin: true,
    rewrite: (path: string) =>
      path.replace(/^\/api\/ss-fixtures/, '/v2/public/stats/fixtures'),
  },
  '/api/ss-momentum': {
    target: 'https://scorealarm-stats.freetls.fastly.net',
    changeOrigin: true,
    rewrite: (path: string) =>
      path.replace(
        /^\/api\/ss-momentum/,
        '/v2/soccer/fixtures/attacking-momentum/superscore/en',
      ),
  },
} as const

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 43173,
    strictPort: true,
    proxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 43173,
    strictPort: true,
    proxy,
  },
})
