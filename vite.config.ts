import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { existsSync, copyFileSync } from 'fs';

/**
 * Inline Vite plugin: copy root-level static files to extension output.
 *
 * Vite copies public/ → outDir automatically, but manifest.json, theme-init.js,
 * and error-handler.js live in the project root (not public/). This plugin
 * copies them to dist-extension/ after the bundle is written.
 */
function copyExtensionStaticFiles() {
  return {
    name: 'copy-extension-static',
    writeBundle() {
      const outDir = resolve(__dirname, 'dist-extension');
      const filesToCopy = ['manifest.json', 'theme-init.js', 'error-handler.js'];
      for (const file of filesToCopy) {
        const src = resolve(__dirname, file);
        if (existsSync(src)) {
          copyFileSync(src, resolve(outDir, file));
        }
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const isExtension = mode === 'extension';

  // Shared config (both desktop and extension)
  const commonConfig = {
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
      },
    },
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
    },
    envPrefix: ['VITE_', 'TAURI_'],
  };

  if (isExtension) {
    // ─── Extension (Chrome MV3) config ───
    return {
      ...commonConfig,
      plugins: [...commonConfig.plugins, copyExtensionStaticFiles()],
      base: './',
      worker: {
        format: 'es',
      },
      build: {
        outDir: 'dist-extension',
        target: 'chrome102',
        minify: 'esbuild',
        sourcemap: false,
        emptyOutDir: true,
        rollupOptions: {
          input: {
            editor: resolve(__dirname, 'editor.html'),
            background: resolve(__dirname, 'src/background.ts'),
          },
          output: {
            // background.ts → background.js (no hash, manifest.json references it by name)
            entryFileNames: (chunkInfo: { name: string }) => {
              if (chunkInfo.name === 'background') {
                return 'background.js';
              }
              return 'assets/[name]-[hash].js';
            },
            chunkFileNames: 'assets/[name]-[hash].js',
            assetFileNames: 'assets/[name]-[hash][extname]',
          },
        },
      },
    };
  }

  // ─── Desktop (Tauri) config — existing, unchanged ───
  return {
    ...commonConfig,
    build: {
      target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari14',
      minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
      sourcemap: !!process.env.TAURI_ENV_DEBUG,
    },
  };
});
