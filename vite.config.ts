import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // ffmpeg.wasm spawns its own worker; pre-bundling breaks the worker URL.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg'] },
  server: {
    // The project lives in OneDrive, whose filter driver swallows file-change notifications: without
    // polling the dev server keeps serving stale modules after an edit.
    watch: { usePolling: true, interval: 1000 },
    // Dev only: lets ?load=/@fs/... read the extracted game files next to the project.
    fs: { allow: ['..'] },
  },
})
