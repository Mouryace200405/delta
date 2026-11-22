import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const root = fileURLToPath(new URL('./src/renderer', import.meta.url))

/**
 * Copy Excalidraw's fonts into the build.
 *
 * Left alone, the drawing editor fetches its fonts from a CDN. Delta has to
 * work with no network at all, so the fonts are served from the app instead
 * and `EXCALIDRAW_ASSET_PATH` points at them.
 */
function excalidrawAssets(): Plugin {
  const source = resolve(
    dirname(fileURLToPath(import.meta.url)),
    'node_modules/@excalidraw/excalidraw/dist/prod/fonts',
  )
  return {
    name: 'delta:excalidraw-assets',
    apply: 'build',
    async closeBundle() {
      const outDir = fileURLToPath(new URL('./dist/renderer/excalidraw-assets/fonts', import.meta.url))
      await mkdir(outDir, { recursive: true })
      await cp(source, outDir, { recursive: true })
    },
  }
}

export default defineConfig({
  root,
  base: './',
  plugins: [react(), excalidrawAssets()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src/renderer', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: false,
    chunkSizeWarningLimit: 8192,
  },
})
