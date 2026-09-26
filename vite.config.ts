import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiServer = 'http://127.0.0.1:43174'

const proxy = {
  '/api/push': { target: apiServer, changeOrigin: true },
  '/api/learn': { target: apiServer, changeOrigin: true },
  '/api/poller': { target: apiServer, changeOrigin: true },
  '/api/telegram': { target: apiServer, changeOrigin: true },
  '/api/robobet': { target: apiServer, changeOrigin: true },
  '/api/tips': { target: apiServer, changeOrigin: true },
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
    allowedHosts: true,
    proxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 43173,
    strictPort: true,
    allowedHosts: true,
    proxy,
  },
})
