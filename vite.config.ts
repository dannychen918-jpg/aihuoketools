import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    watch: {
      // The tsx-based server writes server.log / server.err.log continuously
      // (every publish iteration), and Playwright keeps mutating files inside
      // .browser-profiles/. Without ignoring these, every write triggers a
      // full page reload — the UI appears to refresh on its own forever.
      ignored: [
        '**/server.log',
        '**/server.err.log',
        '**/vite.log',
        '**/vite.err.log',
        '**/.browser-profiles/**',
        '**/data.db',
        '**/data.db-journal',
        '**/data.db-wal',
        '**/data.db-shm',
      ],
    },
  },
})
