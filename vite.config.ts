/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves the site at /<repo-name>/, so every asset path needs that prefix.
const base = '/hide-and-drink/'

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'logo.svg', 'mark.svg', 'wordmark.svg'],
      // Precache the bundled fonts and map label glyphs too, so the app looks right offline.
      // push-sw.js (public/) adds the push alert handlers to the generated service worker.
      workbox: { globPatterns: ['**/*.{js,mjs,css,html,woff2,pbf}'], importScripts: ['push-sw.js'] },
      manifest: {
        name: 'Hide + Drink',
        short_name: 'Hide+Drink',
        description: 'Companion app for our Hide + Drink game',
        theme_color: '#17222E',
        background_color: '#17222E',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  // MapLibre + Terra Draw load lazily as one ~1 MB chunk (still under the PWA precache limit).
  build: { chunkSizeWarningLimit: 1200 },
  test: {
    environment: 'node',
  },
})
