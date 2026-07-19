import { defineConfig } from 'vite';

export default defineConfig(() => ({
  // Relative base so the built asset links (./assets/index-*.js) resolve no
  // matter which folder the files are uploaded to (web root, /castle/, etc.).
  base: './',
  // Bind to all network interfaces so the dev server is reachable on LAN.
  server: {
    host: true,
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: true,
  },
  // Stable output names are more resilient for manual FTP hosting.
  // A mixed upload or stale cache cannot break module loading by hash mismatch.
  build: {
    // esbuild minification is causing a production-only TDZ runtime crash.
    // Use terser for safer output on this bundle.
    minify: 'terser',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/game.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: assetInfo => {
          if (assetInfo.name && assetInfo.name.endsWith('.webmanifest')) {
            return 'assets/manifest.webmanifest';
          }
          return 'assets/[name][extname]';
        },
      },
    },
  },
}));
