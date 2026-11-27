import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  // relative paths so the same build works on GitHub Pages, Cloudflare Pages or any folder
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    preact(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.png', 'icons/*.png'],
      manifest: {
        name: 'Emperio Finances',
        short_name: 'Emperio',
        description: 'Zero-based budgeting with pools, for personal and business money in GBP.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#0d0d0d',
        theme_color: '#f4f3f8',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest}'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
  test: { environment: 'node', include: ['tests/**/*.test.js'] },
});
