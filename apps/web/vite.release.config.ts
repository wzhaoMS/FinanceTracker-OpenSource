import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

export default mergeConfig(base, defineConfig({
  envDir: false,
  base: '/',
  build: {
    sourcemap: false,
    assetsInlineLimit: 0,
    manifest: false,
    ssrManifest: false,
    copyPublicDir: false,
    reportCompressedSize: false,
    emptyOutDir: true,
  },
}));
